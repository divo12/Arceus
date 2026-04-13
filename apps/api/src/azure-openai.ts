import { z, type ZodType } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { runtimeConfig, ensureDeployment } from "./config/index";
import { resilientCall, breakers, isRetryableError } from "./resilience";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function deploymentUrl(deployment: string) {
  const base = runtimeConfig.azureEndpoint.replace(/\/+$/, "");
  return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${runtimeConfig.azureApiVersion}`;
}

export async function chatCompletion(
  deploymentKey: "ceoDeployment" | "workerDeployment",
  messages: ChatMessage[]
): Promise<string> {
  const deployment = ensureDeployment(deploymentKey);
  const url = deploymentUrl(deployment);

  return resilientCall(
    async () => {
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
      };

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
  options?: { temperature?: number }
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
      };

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
  messages: ChatMessage[]
): Promise<ReadableStream<Uint8Array>> {
  const deployment = ensureDeployment(deploymentKey);
  const url = deploymentUrl(deployment);

  // Retry the connection attempt; once streaming starts we can't retry mid-stream.
  return resilientCall(
    async () => {
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

      return response.body;
    },
    { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError },
  );
}
