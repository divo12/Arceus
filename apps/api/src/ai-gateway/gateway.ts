/**
 * AI Gateway — scoped, metered LLM access for company products.
 *
 * Products built by Arceus companies are frontend-only SPAs served at
 * `<slug>.arceus.sh`. They call `POST /api/ai/complete` (same-origin via
 * the preview proxy). This module is the server-side core: it validates
 * the request, enforces the per-company budget, rate-limits, calls Azure
 * OpenAI with the SERVER's key (which never leaves the server), records
 * the spend, and returns the completion text.
 *
 * Security model (v1): the company is resolved server-side from the
 * request (preview subdomain → companyId, or an authenticated JWT), so
 * no API key is ever embedded in the shipped bundle. A product's public
 * URL is itself the only "credential" for the same-origin path, so the
 * real protections against abuse are (a) the per-company budget cap —
 * worst case a company spends its OWN capped budget, never the raw Azure
 * key — and (b) a per-company rate limit. Hardening to a true secret
 * moves with the full-stack scaffold (server-side secret injection).
 */
import { z } from "zod";
import { getDb } from "@arceus/db";
import { findCompanyById, incrementSpentCents } from "@arceus/db/src/repos/companies.js";
import { gatewayChatCompletion, type GatewayCompletionResult } from "../infra/azure-openai.js";
import { computeCostCents } from "../observability/cost-recorder.js";
import { ensureDeployment, type DeploymentKey } from "../config/index.js";

/** Which Azure deployment backs the gateway. gpt-5.2 (ceoDeployment) gives
 *  products a capable model; per-company budget caps bound the cost.
 *  Override with ARCEUS_AI_GATEWAY_DEPLOYMENT=worker for the cheap tier. */
const GATEWAY_DEPLOYMENT: DeploymentKey =
  process.env.ARCEUS_AI_GATEWAY_DEPLOYMENT === "worker" ? "workerDeployment" : "ceoDeployment";

const MAX_MESSAGES = 50;
const MAX_TOTAL_CHARS = 24_000;
const MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_OUTPUT_TOKENS = 1_024;

/** Per-company rate limit: a simple in-memory sliding window. */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

export const aiCompleteRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1, "message content must not be empty"),
      }),
    )
    .min(1, "at least one message is required")
    .max(MAX_MESSAGES, `at most ${MAX_MESSAGES} messages`),
  maxTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export type AiCompleteRequest = z.infer<typeof aiCompleteRequestSchema>;

export interface AiCompleteResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number; costCents: number };
}

/** Validation / rate-limit / budget failures carry an HTTP status + code so
 *  the route can map them without leaking internals to the product. */
export class AiGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AiGatewayError";
    this.status = status;
    this.code = code;
  }
}

function checkRateLimit(companyId: string): void {
  const now = Date.now();
  const recent = (rateBuckets.get(companyId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw new AiGatewayError(429, "rate_limited", "Too many AI requests — slow down and retry shortly.");
  }
  recent.push(now);
  rateBuckets.set(companyId, recent);
}

/**
 * Run one metered completion on behalf of a company. Throws AiGatewayError
 * for client-facing failures (validation/budget/rate-limit); lets unexpected
 * errors propagate so the route returns a generic 502.
 */
export async function aiCompleteForCompany(
  companyId: string,
  rawBody: unknown,
): Promise<AiCompleteResult> {
  const parsed = aiCompleteRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new AiGatewayError(400, "invalid_request", parsed.error.errors[0]?.message ?? "Invalid request body");
  }
  const { messages, maxTokens, temperature } = parsed.data;

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new AiGatewayError(413, "payload_too_large", `Prompt too large (${totalChars} chars > ${MAX_TOTAL_CHARS}).`);
  }

  const company = await findCompanyById(getDb(), companyId);
  if (!company) {
    throw new AiGatewayError(404, "company_not_found", "No company is associated with this request.");
  }

  // Budget gate: a null budget means unmetered (no cap). Otherwise refuse
  // once spend has reached the cap. This is what makes the endpoint safe to
  // expose at a public product URL.
  if (company.budgetCents != null && company.spentCents >= company.budgetCents) {
    throw new AiGatewayError(402, "budget_exceeded", "This product's AI budget has been exhausted.");
  }

  checkRateLimit(companyId);

  let result: GatewayCompletionResult;
  try {
    result = await gatewayChatCompletion(
      GATEWAY_DEPLOYMENT,
      messages,
      { maxTokens: maxTokens ?? DEFAULT_OUTPUT_TOKENS, temperature },
      { companyId, agentRole: "product" },
    );
  } catch {
    // Upstream LLM/breaker failure — don't leak internals to the product.
    throw new AiGatewayError(502, "upstream_error", "The AI service is temporarily unavailable. Retry shortly.");
  }

  // Meter: increment the company's spend counter so the budget gate above
  // is enforced on subsequent calls. computeCostCents mirrors the cost_events
  // ledger pricing (auditLlmCall inside gatewayChatCompletion already wrote
  // the durable cost_events row).
  const costCents = computeCostCents(ensureDeployment(GATEWAY_DEPLOYMENT), result.promptTokens, result.completionTokens);
  if (costCents > 0) {
    await incrementSpentCents(getDb(), companyId, costCents).catch(() => {
      /* best-effort: the durable cost_events row is the source of truth for billing */
    });
  }

  return {
    text: result.text,
    usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens, costCents },
  };
}
