import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listArceusSkills, syncArceusSkills } from "./skills.js";

export const arceusAdapter: ServerAdapterModule = {
  type: "arceus",
  execute,
  testEnvironment,
  listSkills: listArceusSkills,
  syncSkills: syncArceusSkills,
  supportsLocalAgentJwt: true,
  models: [
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    { id: "gpt-5.1-chat", label: "GPT-5.1 Chat" },
  ],
  agentConfigurationDoc: `# Arceus adapter configuration

Adapter: arceus

Built-in AI agent runtime powered by Azure OpenAI. No external CLI tools required.

Core fields:
- model (string, optional): Azure OpenAI deployment name. Default: uses ARCEUS_MODEL_CEO env var.
- azureEndpoint (string, optional): Override Azure OpenAI endpoint. Default: ARCEUS_AZURE_OPENAI_ENDPOINT env var.
- azureApiKey (string, optional): Override API key. Default: ARCEUS_AZURE_OPENAI_API_KEY env var.
- azureApiVersion (string, optional): API version. Default: ARCEUS_AZURE_OPENAI_API_VERSION or "2024-12-01-preview".
- timeoutSec (number, optional): Request timeout in seconds. Default: 300.

Environment variables (automatically picked up):
- ARCEUS_AZURE_OPENAI_ENDPOINT
- ARCEUS_AZURE_OPENAI_API_KEY
- ARCEUS_AZURE_OPENAI_API_VERSION
- ARCEUS_MODEL_CEO (default deployment name)
`,
};
