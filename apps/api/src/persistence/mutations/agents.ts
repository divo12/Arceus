/**
 * Agent mutations — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10.
 */
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";

export async function updateAgentStatus(
  agentId: string,
  status: string,
): Promise<void> {
  await agentsRepo.updateAgent(getDb(), agentId, { status });
}
