/**
 * cost_events durable mirror — Spec 31 Phase 6.
 *
 * Single sink that every LLM call site funnels through. Resolves agent +
 * company FKs from friendly identifiers, computes a `cost_cents` integer
 * from the token counts using a per-model pricing table, and inserts a
 * `cost_events` row.
 *
 * Why centralized:
 *   - LlmAuditContext already carries companyId / agentRole / correlationId
 *     and is plumbed through every `structuredCompletion` + `chatCompletion`
 *     caller. Adding a single recordLlmCost call inside `auditLlmCall`
 *     captures all 6+ emit sites at once.
 *   - The pricing table lives here (not at each emit site) so model
 *     additions are a one-line edit.
 *
 * Caveats (out of scope for this commit):
 *   - `chatCompletionStream` doesn't return a usage object — streaming
 *     bytes don't carry per-call token totals. A follow-up could parse
 *     the trailing `usage` chunk if the upstream emits one.
 *   - OpenCode-SDK calls (run-beat, prompts/llm.runPromptText,
 *     internal-agent) don't currently surface per-call token usage in
 *     the SDK response. Once the SDK exposes it, add a recordLlmCost
 *     call after each `session.prompt` returns.
 */
import { getDb } from "@arceus/db";
import * as costEventsRepo from "@arceus/db/src/repos/cost_events.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { toDbId as companyToDbId } from "@arceus/db/src/repos/companies.js";
// Same uuidv5 namespace as tasks.toDbId — heartbeat_runs.id is computed
// from friendlyBeatId via this exact function in beat-lifecycle.ts:74.
// Re-using it here means cost_events.run_id resolves to the same uuid the
// FK target holds. TODO(spec-31 cleanup): centralise ARCEUS_UUID_NS into a
// shared @arceus/db helper instead of leaning on tasks.toDbId.
import { toDbId as friendlyToUuid } from "@arceus/db/src/repos/tasks/index.js";
import postgres from "postgres";

type Provider = "azure" | "openai" | "anthropic" | "opencode";

interface RecordLlmCostInput {
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Friendly company id (e.g. "company_acme"). Skipped if empty / "_system". */
  companyId?: string;
  /** Friendly agent role (e.g. "ceo"). Resolved to agents.id via repo lookup. */
  agentRole?: string;
  /** Friendly beat id (e.g. "beat_abc..."). Hashed to heartbeat_runs.id uuid. */
  runId?: string;
  /** Friendly task id (e.g. "tsk_..."). Hashed to tasks.id uuid. */
  taskId?: string;
  /** Override timestamp. Defaults to now. */
  occurredAt?: Date;
}

/**
 * Approximate USD per 1M tokens for each provider/model. Source: vendor
 * pricing pages — values intentionally rounded to the nearest dollar so
 * "$" units stay readable in dashboards without forcing all readers to
 * track the exact tier breakpoints.
 *
 * Match is by lowercased substring (so deployment aliases like
 * `gpt-4.1-mini-2024-04-09` still resolve). Update when models change
 * tier; the `_default` row covers unmatched models without crashing.
 */
const PRICING_USD_PER_1M_TOKENS: readonly (readonly [string, { input: number; output: number }])[] = [
  // OpenAI / Azure GPT-4 family
  ["gpt-4.1-mini", { input: 0.40, output: 1.60 }],
  ["gpt-4.1", { input: 2.00, output: 8.00 }],
  ["gpt-4o-mini", { input: 0.15, output: 0.60 }],
  ["gpt-4o", { input: 2.50, output: 10.00 }],
  // GPT-5 family (Azure)
  ["gpt-5.4-mini", { input: 0.50, output: 2.00 }],
  ["gpt-5.4", { input: 5.00, output: 20.00 }],
  // Anthropic
  ["claude-haiku", { input: 0.80, output: 4.00 }],
  ["claude-sonnet", { input: 3.00, output: 15.00 }],
  ["claude-opus", { input: 15.00, output: 75.00 }],
];

const DEFAULT_PRICING = { input: 1.00, output: 3.00 };

export function computeCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const lower = model.toLowerCase();
  const matched = PRICING_USD_PER_1M_TOKENS.find(([key]) => lower.includes(key));
  const pricing = matched?.[1] ?? DEFAULT_PRICING;
  const dollars = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  // Round-half-up to nearest cent. Sub-cent calls clamp to 0 (cheap models /
  // tiny prompts) — the schema is integer-cents so we can't represent
  // fractional spend without changing the column type.
  return Math.round(dollars * 100);
}

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

// Spec 31 Phase 7.C.1 — `"company_pending"` retired. The empty string
// is the canonical "no company" marker now; `"_system"` is reserved
// for bootstrap-time LLM calls that have no company FK target.
const SYSTEM_COMPANIES = new Set(["", "_system"]);

/**
 * Insert a cost_events row for one LLM call. Best-effort — pg failures
 * are logged but never thrown, so a transient DB hiccup can't take down
 * the LLM call path.
 */
export async function recordLlmCost(input: RecordLlmCostInput): Promise<void> {
  if (!input.companyId || SYSTEM_COMPANIES.has(input.companyId)) {
    // System-scoped LLM calls (bootstrap, company-name derivation before
    // a real company exists) have no FK target — silently skip.
    return;
  }

  const db = getDb();
  try {
    const dbCompanyId = companyToDbId(input.companyId);
    const agentDbId = input.agentRole
      ? await agentsRepo.resolveAgentDbId(db, dbCompanyId, input.agentRole)
      : null;
    const runDbId = input.runId ? friendlyToUuid(input.runId) : null;
    const taskDbId = input.taskId ? friendlyToUuid(input.taskId) : null;
    const costCents = computeCostCents(input.model, input.inputTokens, input.outputTokens);

    await costEventsRepo.recordCost(db, {
      companyId: dbCompanyId,
      agentId: agentDbId,
      runId: runDbId,
      taskId: taskDbId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      outputTokens: input.outputTokens,
      costCents,
      occurredAt: input.occurredAt ?? new Date(),
    });
  } catch (err) {
    console.warn(
      `[cost_events] record skipped for ${input.companyId}/${input.model} (pg=${pgErrorCode(err)})`,
    );
  }
}

/** Test-only — exposes the pricing-lookup logic for unit tests. */
