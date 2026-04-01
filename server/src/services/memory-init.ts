import type { Db } from "@paperclipai/db";
import { INITIAL_PRIMING_STATE } from "@paperclipai/shared";
import { memoryStoreService } from "./memory-store.js";
import { roleDefinitionService } from "./role-definitions.js";
import { getHippocampusBridge } from "./hippocampus-bridge.js";

export function memoryInitService(db: Db) {
  const memoryStore = memoryStoreService(db);
  const roleDefs = roleDefinitionService(db);

  async function getEmbeddingWithFallback(text: string): Promise<number[] | null> {
    try {
      const bridge = getHippocampusBridge();
      if (!bridge.getEmbedding) return null;
      const result = await bridge.getEmbedding(text);
      return result.embedding;
    } catch {
      return null;
    }
  }

  async function initializeAgentMemory(agent: {
    id: string;
    companyId: string;
    role: string;
    name: string;
    roleDefinitionId?: string | null;
  }) {
    const container = `company:${agent.companyId}:agent:${agent.id}`;

    await memoryStore.updatePrimingState(agent.id, agent.companyId, { ...INITIAL_PRIMING_STATE });

    await memoryStore.writeMemory({
      companyId: agent.companyId,
      agentId: agent.id,
      content: `I am ${agent.name}, serving as ${agent.role} in this organization.`,
      embedding: await getEmbeddingWithFallback(`${agent.name} ${agent.role} identity`),
      memoryType: "static",
      container,
      confidence: 1.0,
      visibility: "private",
      sourceType: "system",
      sourceId: "agent_creation",
    });

    const roleDef = agent.roleDefinitionId
      ? await roleDefs.getById(agent.roleDefinitionId).catch(() => null)
      : await roleDefs.getForAgent(agent.id);

    if (roleDef?.systemPrompt.trim()) {
      await memoryStore.writeMemory({
        companyId: agent.companyId,
        agentId: agent.id,
        content: roleDef.systemPrompt.trim(),
        embedding: await getEmbeddingWithFallback(roleDef.systemPrompt.trim()),
        memoryType: "static",
        container,
        confidence: 0.95,
        visibility: "private",
        sourceType: "system",
        sourceId: "role_definition_prompt",
      });
    }

    for (const skill of roleDef?.skillsSeed ?? []) {
      await memoryStore.writeMemory({
        companyId: agent.companyId,
        agentId: agent.id,
        content: `Core skill: ${skill}`,
        embedding: await getEmbeddingWithFallback(skill),
        memoryType: "static",
        container,
        confidence: 0.8,
        visibility: "private",
        sourceType: "system",
        sourceId: "role_definition_skill",
      });
    }

    await memoryStore.logOperation({
      companyId: agent.companyId,
      agentId: agent.id,
      operationType: "agent_init",
      success: true,
    });
  }

  return { initializeAgentMemory };
}
