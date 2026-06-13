import { z, type ZodType } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { runtimeConfig, ensureDeployment, type DeploymentKey } from "../config/index.js";
import { resilientCall, breakers, isRetryableError } from "./resilience.js";
import { audit } from "../observability/audit-ledger.js";
import { recordLlmCost } from "../observability/cost-recorder.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { deploymentSupportsTemperature as supportsTemperature } from "./temperature-support.js";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Optional context for audit logging LLM calls. */
interface LlmAuditContext {
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

/**
 * Does this deployment's model accept a custom `temperature`? Thin wrapper
 * over the pure helper, supplying the locked-deployment CSV from config.
 * See `temperature-support.ts` for the why (HTTP 400 → shared breaker trip).
 */
function deploymentSupportsTemperature(deployment: string): boolean {
  return supportsTemperature(deployment, runtimeConfig.temperatureLockedDeployments);
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

// ── Per-beat tool-call accumulator ────────────────────────
// Counts every tool invocation observed during a beat window — both
// arceus_* MCP tools (bumped by the MCP middleware on each request) and
// built-in OpenCode tools (bumped by the watchdog-reset endpoint when the
// plugin posts a tool body). Drained by runBeat so heartbeat_runs.
// tool_call_count carries an accurate signal instead of the hardcoded 0
// it carried previously. The map only retains entries for beats whose
// accumulator was explicitly started; out-of-band bumps (e.g. a stray
// late tool result) are silently dropped to avoid leaking memory.
const beatToolCallAccumulators = new Map<string, number>();

/** Begin counting tool calls for a beat. Call once at beat start. */
export function startBeatToolCallAccumulator(beatId: string) {
  beatToolCallAccumulators.set(beatId, 0);
}

/** Increment the tool-call counter for a beat. No-op if not started. */
export function bumpBeatToolCallAccumulator(beatId: string, by = 1): void {
  const current = beatToolCallAccumulators.get(beatId);
  if (current === undefined) return;
  beatToolCallAccumulators.set(beatId, current + by);
}

/** Read and clear the accumulated tool-call count for a beat. */
export function drainBeatToolCallAccumulator(beatId: string): number {
  const count = beatToolCallAccumulators.get(beatId) ?? 0;
  beatToolCallAccumulators.delete(beatId);
  return count;
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
async function chatCompletion(
  deploymentKey: DeploymentKey,
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
        body: JSON.stringify({
          messages,
          // Omit temperature for deployments that only accept the default —
          // sending it 400s and trips the shared breaker (see deploymentSupportsTemperature).
          ...(deploymentSupportsTemperature(deployment) ? { temperature: 0.7 } : {}),
        }),
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
  deploymentKey: DeploymentKey,
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
          // Omit temperature for deployments that only accept the default
          // (e.g. gpt-5-nano) — sending it 400s and trips the shared
          // azure-openai breaker. See deploymentSupportsTemperature.
          ...(deploymentSupportsTemperature(deployment) ? { temperature: options?.temperature ?? 0.7 } : {}),
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

      return schema.parse(parseJsonTolerant(raw, schemaName));
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}

/**
 * Tolerant JSON parser for LLM structured output. Some Azure deployments
 * (notably gpt-5.x and reasoning models) ignore `strict: true` and append
 * commentary like `}\n\nThis strategy will...` after the closing brace,
 * causing JSON.parse to throw "Unexpected non-whitespace character after
 * JSON". This walks the string from the first `{`/`[` and slices at the
 * matching close brace, ignoring trailing text. String literals are
 * tracked so braces inside strings don't fool the depth counter.
 */
function parseJsonTolerant(raw: string, schemaName: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.search(/[{[]/);
    if (start === -1) {
      throw new Error(`Azure OpenAI returned non-JSON content (${schemaName}): ${raw.slice(0, 200)}`);
    }
    const open = raw[start] as "{" | "[";
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(raw.slice(start, i + 1));
        }
      }
    }
    throw new Error(`Azure OpenAI returned unbalanced JSON (${schemaName}): ${raw.slice(0, 200)}`);
  }
}

/** Stream a chat completion response from Azure OpenAI, returning the raw byte stream. */
async function chatCompletionStream(
  deploymentKey: DeploymentKey,
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
          // Omit temperature for deployments that only accept the default —
          // sending it 400s and trips the shared breaker (see deploymentSupportsTemperature).
          ...(deploymentSupportsTemperature(deployment) ? { temperature: 0.7 } : {}),
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
      // The usage watcher is best-effort cost telemetry — its failure
      // shouldn't taint the caller's stream. Route through swallowAndAudit
      // so the failure surfaces to operators instead of console.
      swallowAndAudit("openai.usage_watcher", () =>
        watchForUsageAndRecord(forUsageWatcher, deployment, auditCtx),
        { detail: { deployment } },
      );
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
          parsed = JSON.parse(payload) as { usage?: AzureOpenAIUsage };
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

