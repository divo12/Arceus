/**
 * Runtime readiness checks for Azure OpenAI deployment configuration.
 */
import { runtimeConfig } from "../config/index.js";

/** Check which Azure OpenAI deployments are configured and return readiness flags. */
export function getRuntimeStatus() {
  const missing: string[] = [];
  const missingChat: string[] = [];
  const missingBuild: string[] = [];

  if (!runtimeConfig.ceoDeployment) {
    const key = "ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT";
    missing.push(key);
    missingChat.push(key);
  }

  if (!runtimeConfig.workerDeployment) {
    const key = "ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT";
    missing.push(key);
    missingBuild.push(key);
  }

  return {
    ready: missingChat.length === 0,
    chatReady: missingChat.length === 0,
    buildReady: missingBuild.length === 0,
    missing,
    missingChat,
    missingBuild,
    runtime: {
      provider: "azure-openai",
      endpoint: runtimeConfig.azureEndpoint,
      resourceName: runtimeConfig.azureResourceName,
      ceoDeploymentConfigured: Boolean(runtimeConfig.ceoDeployment),
      workerDeploymentConfigured: Boolean(runtimeConfig.workerDeployment)
    }
  };
}
