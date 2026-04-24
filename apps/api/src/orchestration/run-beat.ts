/**
 * runBeat — the heartbeat-driven orchestration entry point.
 *
 * Replaces `executeSpecialistTask` per-beat. Creates a session, builds context,
 * materialises skills, wakes the agent with a hard-cap timeout, scores the
 * outcome, updates skill success rates, and cleans up.
 *
 * Phase 6.5 — Package J.
 */
import crypto from "node:crypto";
import type { RoleType } from "@arceus/contracts";
import { updateSuccessRate, ROLE_SOULS } from "@arceus/company-runtime";
import { createBeatSession, destroyBeatSession } from "../infra/opencode.js";
import { getOpencode } from "../infra/opencode.js";
import { ensureDeployment } from "../config/index.js";
import { buildBeatContext, renderStateForAgent } from "./beat-context-builder.js";
import { registerSessionContext, unregisterSessionContext } from "./session-context.js";
import { materializeBeatSkills } from "../opencode/materialize-beat-skills.js";
import { cleanupBeatScratch } from "../infra/beat-paths.js";
import { scoreBeatVerdict, clearBeatTaskTransitions } from "./beat-scoring.js";
import { getBeatSkillUsage, clearBeatSkillUsage } from "../routes/internal-telemetry.routes.js";
import { registerPromptCompletion } from "../prompts/llm.js";
import { startBeatTokenAccumulator, drainBeatTokenAccumulator } from "../infra/azure-openai.js";

const HARD_CAP_MS = 15 * 60 * 1000;

export interface BeatResult {
  beatId: string;
  sessionId: string;
  verdict: "pass" | "fail";
  cause?: string;
  tokensUsed: number;
}

export async function runBeat(input: {
  role: RoleType;
  companyId: string;
  /** Optional external beat id (e.g. from HeartbeatEngine). When omitted runBeat generates one. */
  beatId?: string;
}): Promise<BeatResult> {
  const beatId = input.beatId ?? `beat_${crypto.randomBytes(6).toString("hex")}`;
  startBeatTokenAccumulator(beatId);

  // Step 3: create session
  const session = await createBeatSession(input.role, beatId);
  const sessionId = session.id;

  // Step 2+4: build context, register
  const ctx = await buildBeatContext(input.role, input.companyId, beatId, sessionId);
  registerSessionContext(ctx);

  // Step 5: materialize skills + swap symlink
  await materializeBeatSkills({
    beatId,
    companyId: input.companyId,
    role: input.role,
    trustBand: ctx.trustBand,
  });

  let cause: string | undefined;
  try {
    // Step 6: wake the agent (blocks, with hard cap)
    const stateText = renderStateForAgent(input.role, input.companyId);
    const soul = ROLE_SOULS[input.role].systemPrompt;
    const deployment = ensureDeployment("workerDeployment");

    const opencode = await getOpencode();
    const completionPromise = registerPromptCompletion(sessionId, HARD_CAP_MS);

    await opencode.client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: "azure", modelID: deployment },
        agent: input.role,
        system: soul,
        parts: [{ type: "text", text: stateText }],
      } as any,
    });

    await completionPromise;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    cause = msg.includes("timed out") ? "beat_hard_cap" : "prompt_failed";
  } finally {
    // Steps 16–22: scoring + cleanup, always runs
    const verdict = cause === "beat_hard_cap"
      ? "fail"
      : await scoreBeatVerdict(beatId);

    const usedSkills = getBeatSkillUsage(beatId);
    for (const skillId of usedSkills) {
      updateSuccessRate(skillId, verdict === "pass" ? 1 : 0);
    }
    clearBeatSkillUsage(beatId);
    clearBeatTaskTransitions(beatId);

    unregisterSessionContext(sessionId);
    await destroyBeatSession(sessionId);
    await cleanupBeatScratch(beatId);

    const tokensUsed = drainBeatTokenAccumulator(beatId);

    // eslint-disable-next-line no-unsafe-finally
    return { beatId, sessionId, verdict, cause, tokensUsed };
  }
}
