import { z, type ZodType } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { runtimeConfig, ensureDeployment } from "../config/index.js";
import { resilientCall, breakers, isRetryableError } from "./resilience.js";
import { audit } from "../observability/audit-ledger.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Optional context for audit logging LLM calls. */
export type LlmAuditContext = {
  companyId: string;
  agentRole?: string;
  correlationId?: string;
  /** Caller label for the summary, e.g. "ceo_classification" */
  label?: string;
};

/** Build the Azure OpenAI chat completions URL for a given deployment. */
function deploymentUrl(deployment: string) {
  const base = runtimeConfig.azureEndpoint.replace(/\/+$/, "");
  return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${runtimeConfig.azureApiVersion}`;
}

type AzureOpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

// ── Per-beat token accumulator ─────────────────────────────
// Tracks total tokens consumed during a beat window so the heartbeat
// engine can record actual cost instead of hardcoded 0.
const beatTokenAccumulators = new Map<string, number>();

/** Start accumulating tokens for a beat. */
export function startBeatTokenAccumulator(beatId: string) {
  beatTokenAccumulators.set(beatId, 0);
}

/** Read and clear the accumulated token count for a beat. */
export function drainBeatTokenAccumulator(beatId: string): number {
  const tokens = beatTokenAccumulators.get(beatId) ?? 0;
  beatTokenAccumulators.delete(beatId);
  return tokens;
}

// ── Per-meeting token accumulator (Phase 8) ────────────────
// Tracks total tokens consumed during a meeting pipeline run.
const meetingTokenAccumulators = new Map<string, number>();

/** Start accumulating tokens for a meeting pipeline. */
export function startMeetingTokenAccumulator(meetingId: string) {
  meetingTokenAccumulators.set(meetingId, 0);
}

/** Read and clear the accumulated token count for a meeting. */
export function drainMeetingTokenAccumulator(meetingId: string): number {
  const tokens = meetingTokenAccumulators.get(meetingId) ?? 0;
  meetingTokenAccumulators.delete(meetingId);
  return tokens;
}

/** Distribute consumed tokens across all active beat and meeting accumulators. */
function accumulateBeatTokens(totalTokens: number) {
  // Add tokens to all active accumulators (usually just one active beat per agent).
  for (const [beatId, current] of beatTokenAccumulators) {
    beatTokenAccumulators.set(beatId, current + totalTokens);
  }
  // Also add to any active meeting accumulators.
  for (const [meetingId, current] of meetingTokenAccumulators) {
    meetingTokenAccumulators.set(meetingId, current + totalTokens);
  }
}

/** Record an LLM call in the audit ledger with token counts and latency. */
function auditLlmCall(
  deployment: string,
  usage: AzureOpenAIUsage | undefined,
  latencyMs: number,
  ctx?: LlmAuditContext,
  schemaName?: string,
) {
  const companyId = ctx?.companyId ?? "_system";
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? (promptTokens + completionTokens);
  const label = ctx?.label ?? schemaName ?? deployment;

  accumulateBeatTokens(totalTokens);

  audit({
    companyId,
    category: "agent_action",
    severity: "debug",
    eventType: "llm_call_completed",
    agentRole: ctx?.agentRole ?? null,
    summary: `LLM ${label} → ${totalTokens} tokens (${promptTokens}+${completionTokens}) ${latencyMs}ms`,
    detail: {
      deployment,
      schemaName: schemaName ?? null,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs,
    },
    correlationId: ctx?.correlationId ?? null,
  });
}

/** Send a chat completion request to Azure OpenAI with resilience and audit logging. */
export async function chatCompletion(
  deploymentKey: "ceoDeployment" | "workerDeployment",
  messages: ChatMessage[],
  auditCtx?: LlmAuditContext,
): Promise<string> {
  const deployment = ensureDeployment(deploymentKey);
  const url = deploymentUrl(deployment);

  return resilientCall(
    async () => {
      const start = performance.now();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": runtimeConfig.azureApiKey
        },
        body: JSON.stringify({ messages, temperature: 0.7 })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI ${deployment} error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: AzureOpenAIUsage;
      };
      const latencyMs = Math.round(performance.now() - start);

      auditLlmCall(deployment, json.usage, latencyMs, auditCtx);

      return json.choices[0]?.message?.content ?? "";
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}

/**
 * Type-safe structured output completion.
 * Takes a Zod schema, derives the JSON Schema automatically,
 * sends it as response_format to Azure OpenAI, and validates
 * the response through Zod before returning.
 *
 * Principle 4: Structured Outputs Over String Parsing.
 */
/**
 * Error thrown when the LLM response was truncated because the deployment's
 * completion-token cap was reached before the structured output finished.
 * Callers can catch this to retry with a compacted prompt or a smaller schema
 * path instead of trying to parse the (guaranteed-broken) partial JSON.
 */
export class LlmTruncatedOutputError extends Error {
  readonly schemaName: string;
  readonly completionTokens: number;
  readonly maxTokens: number;
  constructor(schemaName: string, completionTokens: number, maxTokens: number) {
    super(
      `Azure OpenAI structured output (${schemaName}) truncated at ${completionTokens} tokens (max_tokens=${maxTokens}). ` +
      `Reduce prompt context, narrow the schema, or raise max_tokens.`,
    );
    this.name = "LlmTruncatedOutputError";
    this.schemaName = schemaName;
    this.completionTokens = completionTokens;
    this.maxTokens = maxTokens;
  }
}

/** Default completion cap for structured outputs. Generous enough for
 * sprint_proposal cards while still preventing runaway responses that
 * hit deployment defaults and produce truncated JSON. */
const DEFAULT_STRUCTURED_MAX_TOKENS = 12000;

export async function structuredCompletion<T>(
  deploymentKey: "ceoDeployment" | "workerDeployment",
  messages: ChatMessage[],
  schema: ZodType<T>,
  schemaName: string,
  options?: { temperature?: number; maxTokens?: number },
  auditCtx?: LlmAuditContext,
): Promise<T> {
  const deployment = ensureDeployment(deploymentKey);
  const url = deploymentUrl(deployment);

  // Derive JSON Schema from Zod — single source of truth
  const derived = zodToJsonSchema(schema, {
    target: "openAi",
    $refStrategy: "none",
  });

  const maxTokens = options?.maxTokens ?? DEFAULT_STRUCTURED_MAX_TOKENS;

  return resilientCall(
    async () => {
      const start = performance.now();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": runtimeConfig.azureApiKey,
        },
        body: JSON.stringify({
          messages,
          temperature: options?.temperature ?? 0.7,
          max_tokens: maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: schemaName,
              strict: true,
              schema: derived,
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI structured output (${schemaName}) failed ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage?: AzureOpenAIUsage;
      };
      const latencyMs = Math.round(performance.now() - start);

      auditLlmCall(deployment, json.usage, latencyMs, auditCtx, schemaName);

      const choice = json.choices[0];
      const raw = choice?.message?.content;
      if (!raw) {
        throw new Error(`Azure OpenAI returned no content for structured output (${schemaName}).`);
      }

      // Detect truncation FIRST — if the LLM hit max_tokens, its JSON is
      // guaranteed to be malformed. Throw a typed error so callers can
      // retry with compacted context instead of silently failing.
      if (choice.finish_reason === "length") {
        throw new LlmTruncatedOutputError(
          schemaName,
          json.usage?.completion_tokens ?? -1,
          maxTokens,
        );
      }

      return schema.parse(JSON.parse(raw));
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}

/** Stream a chat completion response from Azure OpenAI, returning the raw byte stream. */
export async function chatCompletionStream(
  deploymentKey: "ceoDeployment" | "workerDeployment",
  messages: ChatMessage[],
  auditCtx?: LlmAuditContext,
): Promise<ReadableStream<Uint8Array>> {
  const deployment = ensureDeployment(deploymentKey);
  const url = deploymentUrl(deployment);

  return resilientCall(
    async () => {
      const start = performance.now();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": runtimeConfig.azureApiKey
        },
        body: JSON.stringify({ messages, temperature: 0.7, stream: true })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI ${deployment} stream error ${response.status}: ${body}`);
      }

      if (!response.body) {
        throw new Error("Azure OpenAI returned no stream body.");
      }

      // For streaming, we can't read usage from the response (it's chunked).
      // Audit a start event with latency-to-first-byte.
      const latencyMs = Math.round(performance.now() - start);
      audit({
        companyId: auditCtx?.companyId ?? "_system",
        category: "agent_action",
        severity: "debug",
        eventType: "llm_stream_started",
        agentRole: auditCtx?.agentRole ?? null,
        summary: `LLM stream ${auditCtx?.label ?? deployment} started (TTFB ${latencyMs}ms)`,
        detail: { deployment, latencyMs },
        correlationId: auditCtx?.correlationId ?? null,
      });

      return response.body;
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}

