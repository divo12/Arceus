import { z, type ZodType } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { runtimeConfig, ensureDeployment } from "./config/index";
import { resilientCall, breakers, isRetryableError } from "./resilience";
import { audit } from "./audit-ledger";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Optional context for audit logging LLM calls. */
export type LlmAuditContext = {
  companyId: string;
  agentRole?: string;
  correlationId?: string;
  /** Caller label for the summary, e.g. "ceo_classification" */
  label?: string;
};

function deploymentUrl(deployment: string) {
  const base = runtimeConfig.azureEndpoint.replace(/\/+$/, "");
  return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${runtimeConfig.azureApiVersion}`;
}

type AzureOpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

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
export async function structuredCompletion<T>(
  deploymentKey: "ceoDeployment" | "workerDeployment",
  messages: ChatMessage[],
  schema: ZodType<T>,
  schemaName: string,
  options?: { temperature?: number },
  auditCtx?: LlmAuditContext,
): Promise<T> {
  const deployment = ensureDeployment(deploymentKey);
  const url = deploymentUrl(deployment);

  // Derive JSON Schema from Zod — single source of truth
  const derived = zodToJsonSchema(schema, {
    target: "openAi",
    $refStrategy: "none",
  });

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
        choices: Array<{ message: { content: string } }>;
        usage?: AzureOpenAIUsage;
      };
      const latencyMs = Math.round(performance.now() - start);

      auditLlmCall(deployment, json.usage, latencyMs, auditCtx, schemaName);

      const raw = json.choices[0]?.message?.content;
      if (!raw) {
        throw new Error(`Azure OpenAI returned no content for structured output (${schemaName}).`);
      }

      return schema.parse(JSON.parse(raw));
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}

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
