/**
 * Runtime configuration.
 * Azure OpenAI credentials, deployment names, and OpenCode host/port.
 */
import { readNumberEnv, readOptionalEnv, readRequiredEnv } from "./env";

export const runtimeConfig = {
  azureEndpoint: readRequiredEnv("ARCEUS_AZURE_OPENAI_ENDPOINT"),
  azureApiKey: readRequiredEnv("ARCEUS_AZURE_OPENAI_API_KEY"),
  azureApiVersion: readRequiredEnv("ARCEUS_AZURE_OPENAI_API_VERSION"),
  azureResourceName: readRequiredEnv("ARCEUS_AZURE_OPENAI_RESOURCE_NAME"),
  defaultDeployment: readOptionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  ceoDeployment:
    readOptionalEnv("ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT") ||
    readOptionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  workerDeployment:
    readOptionalEnv("ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT") ||
    readOptionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  // Auxiliary LLM traffic (Hippocampus fact extraction, action decisions,
  // habit matching). Falls back to the worker deployment so PROD without
  // the env var behaves exactly as before. Point this at a small model
  // (e.g. gpt-5-nano) so memory-pipeline calls stop competing with beats
  // for the worker deployment's TPM quota.
  memoryDeployment:
    readOptionalEnv("ARCEUS_AZURE_OPENAI_MEMORY_DEPLOYMENT") ||
    readOptionalEnv("ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT") ||
    readOptionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  opencodeHost: readOptionalEnv("ARCEUS_OPENCODE_HOST", "127.0.0.1"),
  opencodePort: readNumberEnv("ARCEUS_OPENCODE_PORT", 4096),
};

const DEPLOYMENT_ENV_HINTS = {
  ceoDeployment: "ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT",
  workerDeployment: "ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT",
  memoryDeployment: "ARCEUS_AZURE_OPENAI_MEMORY_DEPLOYMENT",
} as const satisfies Record<string, string>;

/** Named deployments resolvable via `ensureDeployment`. */
export type DeploymentKey = keyof typeof DEPLOYMENT_ENV_HINTS;

/** Resolve a named deployment, throwing if not configured. */
export function ensureDeployment(name: DeploymentKey) {
  const value = runtimeConfig[name];
  if (!value) {
    throw new Error(
      `Missing Azure deployment name for ${name}. Set ${DEPLOYMENT_ENV_HINTS[name]} or ARCEUS_AZURE_OPENAI_DEPLOYMENT.`
    );
  }
  return value;
}