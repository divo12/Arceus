import { z, type ZodType } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { runtimeConfig, ensureDeployment } from "../config/index.js";
import { resilientCall, breakers, isRetryableError } from "./resilience.js";
import { audit } from "../observability/audit-ledger.js";
import { recordLlmCost } from "../observability/cost-recorder.js";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Optional context for audit logging LLM calls. */
export interface LlmAuditContext {
  companyId: string;
  agentRole?: string;
  correlationId?: string;
  /** Caller label for the summary, e.g. "ceo_classification" */
  label?: string;
  /**
   * Spec 31 Phase 6 — cost-event routing. When set, the cost_events row
   * inserted by `auditLlmCall` populates these FKs so dashboards can
   * group spend by beat or by task. Both accept friendly ids (e.g.
   * "beat_abc...", "tsk_xyz...") — they're hashed to the matching DB
   * uuids via the same uuidv5 boundary used elsewhere.
   */
  runId?: string;
  taskId?: string;
}

/** Build the Azure OpenAI chat completions URL for a given deployment. */
function deploymentUrl(deployment: string) {
  const base = runtimeConfig.azureEndpoint.replace(/\/+$/, "");
  return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${runtimeConfig.azureApiVersion}`;
}

interface AzureOpenAIUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

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

  // Spec 31 Phase 6 — durable cost mirror. Single fan-out point covers
  // every structuredCompletion + chatCompletion caller (the audit log
  // already had to be uniform). Skipped for system-scoped calls where
  // ctx.companyId is missing/_system (recordLlmCost no-ops in that case).
  void recordLlmCost({
    provider: "azure",
    model: deployment,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    companyId: ctx?.companyId,
    agentRole: ctx?.agentRole,
    runId: ctx?.runId,
    taskId: ctx?.taskId,
  }).catch(() => { /* recordLlmCost already swallows + warns */ });
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
        body: JSON.stringify({ messages, temperature: 0.7 }),
        signal: AbortSignal.timeout(AZURE_OPENAI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI ${deployment} error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        choices: { message: { content: string } }[];
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

/**
 * Per-request timeout for Azure OpenAI calls. Used by both the streaming
 * chat completion path and `structuredCompletion`. 90s is well above p99
 * for sprint proposal / strategy generation prompts (~30-40s) but short
 * enough that a stuck deployment fails the beat instead of hanging the
 * whole heartbeat loop.
 */
const AZURE_OPENAI_REQUEST_TIMEOUT_MS = 90_000;

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
          max_completion_tokens: maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: schemaName,
              strict: true,
              schema: derived,
            },
          },
        }),
        signal: AbortSignal.timeout(AZURE_OPENAI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI structured output (${schemaName}) failed ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        choices: { message: { content: string }; finish_reason?: string }[];
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
        // Spec 31 Phase 6 — request the trailing usage chunk so we can
        // record cost_events. Without `include_usage:true`, Azure/OpenAI's
        // SSE stream omits the final usage object and we can't tell how
        // many tokens the call consumed.
        body: JSON.stringify({
          messages,
          temperature: 0.7,
          stream: true,
          stream_options: { include_usage: true },
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI ${deployment} stream error ${response.status}: ${body}`);
      }

      if (!response.body) {
        throw new Error("Azure OpenAI returned no stream body.");
      }

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

      // Tee the stream: the caller consumes one branch as raw bytes,
      // we consume the other looking for the trailing `usage` chunk
      // and fire recordLlmCost once we find it. The tee is fully
      // backpressure-aware — caller's consumption rate isn't blocked
      // by ours and vice versa.
      const [forCaller, forUsageWatcher] = response.body.tee();
      void watchForUsageAndRecord(forUsageWatcher, deployment, auditCtx).catch((err: unknown) => {
        console.warn(`[stream-usage] watcher failed for ${deployment}:`, err);
      });
      return forCaller;
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}

/**
 * Drain a teed copy of the SSE byte stream, parse each `data: {...}`
 * line, and fire `recordLlmCost` when we find the chunk that carries
 * the `usage` object (the trailing chunk emitted by Azure/OpenAI when
 * `stream_options.include_usage=true`).
 *
 * Tolerant to:
 *   - Multi-line buffer splits (we accumulate until newline)
 *   - The `data: [DONE]` sentinel (skipped, not parsed)
 *   - Earlier chunks without `usage` (skipped silently)
 */
async function watchForUsageAndRecord(
  stream: ReadableStream<Uint8Array>,
  deployment: string,
  auditCtx?: LlmAuditContext,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let recorded = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited. Split on `\n` and keep the
      // trailing partial line in the buffer for the next iteration.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "" || payload === "[DONE]") continue;

        let parsed: { usage?: AzureOpenAIUsage } | undefined;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // partial chunk or malformed — skip
        }

        if (!recorded && parsed?.usage) {
          recorded = true;
          const promptTokens = parsed.usage.prompt_tokens ?? 0;
          const completionTokens = parsed.usage.completion_tokens ?? 0;
          accumulateBeatTokens(promptTokens + completionTokens);
          void recordLlmCost({
            provider: "azure",
            model: deployment,
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            companyId: auditCtx?.companyId,
            agentRole: auditCtx?.agentRole,
            runId: auditCtx?.runId,
            taskId: auditCtx?.taskId,
          }).catch(() => { /* recordLlmCost already swallows + warns */ });
          // Continue draining (we don't break) so the tee'd reader doesn't
          // back-pressure the caller's branch.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

