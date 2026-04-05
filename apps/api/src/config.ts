import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoEnvPath = resolve(currentDir, "../../../.env.local");

loadEnv({ path: repoEnvPath, override: true });

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || "";
}

export const runtimeConfig = {
  azureEndpoint: requireEnv("ARCEUS_AZURE_OPENAI_ENDPOINT"),
  azureApiKey: requireEnv("ARCEUS_AZURE_OPENAI_API_KEY"),
  azureApiVersion: requireEnv("ARCEUS_AZURE_OPENAI_API_VERSION"),
  azureResourceName: requireEnv("ARCEUS_AZURE_OPENAI_RESOURCE_NAME"),
  defaultDeployment: optionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  ceoDeployment: optionalEnv("ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT") || optionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  workerDeployment: optionalEnv("ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT") || optionalEnv("ARCEUS_AZURE_OPENAI_DEPLOYMENT"),
  opencodeHost: process.env.ARCEUS_OPENCODE_HOST ?? "127.0.0.1",
  opencodePort: Number(process.env.ARCEUS_OPENCODE_PORT ?? 4096)
};

export function ensureDeployment(name: "ceoDeployment" | "workerDeployment") {
  const value = runtimeConfig[name];
  if (!value) {
    throw new Error(
      `Missing Azure deployment name for ${name}. Set ${name === "ceoDeployment" ? "ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT" : "ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT"}.`
    );
  }
  return value;
}
