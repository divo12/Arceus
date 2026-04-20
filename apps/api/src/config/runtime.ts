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
  opencodeHost: readOptionalEnv("ARCEUS_OPENCODE_HOST", "127.0.0.1"),
  opencodePort: readNumberEnv("ARCEUS_OPENCODE_PORT", 4096),
};

/** Resolve a named deployment, throwing if not configured. */
export function ensureDeployment(name: "ceoDeployment" | "workerDeployment") {
  const value = runtimeConfig[name];
  if (!value) {
    throw new Error(
      `Missing Azure deployment name for ${name}. Set ${
        name === "ceoDeployment"
          ? "ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT"
          : "ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT"
      }.`
    );
  }
  return value;
}