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
import { observability } from "@arceus/contracts";
import { updateSuccessRate, ROLE_SOULS, getSkillById } from "@arceus/company-runtime";
import { createBeatSession, destroyBeatSession } from "../infra/opencode.js";
import { getOpencode } from "../infra/opencode.js";
import { ensureDeployment } from "../config/index.js";
import { buildBeatContext, renderStateForAgent, countOpenTasksForRole } from "./beat-context-builder.js";
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
  const beatStartedAt = Date.now();
  startBeatTokenAccumulator(beatId);

  // Step 3: create session
  const session = await createBeatSession(input.role, beatId);
  const sessionId = session.id;

  // Step 2+4: build context, register
  const ctx = await buildBeatContext(input.role, input.companyId, beatId, sessionId);
  registerSessionContext(ctx);

  // Spec 32 — narrate beat start; OTEL sink opens the parent span here.
  observability.logEvent({
    event: "beat.started",
    beatId,
    companyId: input.companyId,
    role: input.role,
    sprintId: ctx.sprintId,
    trustBand: ctx.trustBand,
    ts: beatStartedAt,
  });

  // Vision guard — if the agent has nothing to do, skip the prompt entirely.
  // Without this, a bored LLM with no claimed task invents filler artifacts
  // (e.g. placeholder.md, noop.md) just to fill the response window.
  const openTaskCount = countOpenTasksForRole(input.role);
  const incomingHandoffCount = ctx.incomingHandoffs.length;
  if (openTaskCount === 0 && incomingHandoffCount === 0) {
    unregisterSessionContext(sessionId);
    await destroyBeatSession(sessionId);
    const tokensUsed = drainBeatTokenAccumulator(beatId);
    observability.logEvent({
      event: "beat.completed",
      beatId,
      role: input.role,
      verdictOutcome: "pass",
      verdictScore: 1,
      durationMs: Date.now() - beatStartedAt,
      ts: Date.now(),
    });
    return { beatId, sessionId, verdict: "pass", cause: "no-work", tokensUsed };
  }

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
    // Spec 32 — narrate the failure cause as an error event before cleanup.
    observability.logEvent({
      event: "error",
      where: "run_beat",
      message: msg || "unknown beat failure",
      stack: (e as Error).stack,
      beatId,
      ts: Date.now(),
    });
  } finally {
    // Steps 16–22: scoring + cleanup, always runs
    const verdict = cause === "beat_hard_cap"
      ? "fail"
      : await scoreBeatVerdict(beatId);

    const usedSkills = getBeatSkillUsage(beatId);
    for (const skillId of usedSkills) {
      updateSuccessRate(skillId, verdict === "pass" ? 1 : 0);
    }

    // Spec 29 Phase G.3 — EMA-drop trigger. After Pass-1 EMA update, check
    // each used skill against its prior baseline; enqueue an evolve job if
    // success rate has dropped > 0.15 below the baseline AND the skill has
    // ≥10 invocations.
    if (process.env.ARCEUS_SKILL_EVOLVE_TRIGGER_EMA === "1") {
      try {
        const { getRevisionBaselineEma, maybeEnqueueEvolveJob, EMA_BASELINE_DEFAULT } = await import("../skills/triggers.js");
        for (const skillId of usedSkills) {
          const skill = getSkillById(skillId);
          if (!skill) continue;
          const baseline = (await getRevisionBaselineEma(skillId)) ?? EMA_BASELINE_DEFAULT;
          if (skill.successRate < baseline - 0.15 && skill.usageCount >= 10) {
            await maybeEnqueueEvolveJob({
              companyId: input.companyId,
              trigger: "ema_drop",
              targetSkillId: skillId,
              payload: { baselineEma: baseline, currentEma: skill.successRate, usageCount: skill.usageCount },
            });
          }
        }
      } catch (err) {
        observability.logEvent({
          event: "error",
          where: "run_beat.ema_drop_trigger",
          message: err instanceof Error ? err.message : String(err),
          beatId,
          ts: Date.now(),
        });
      }
    }

    clearBeatSkillUsage(beatId);
    clearBeatTaskTransitions(beatId);

    unregisterSessionContext(sessionId);
    await destroyBeatSession(sessionId);
    await cleanupBeatScratch(beatId);

    const tokensUsed = drainBeatTokenAccumulator(beatId);
    const beatEndedAt = Date.now();

    // Spec 32 — narrate beat end. OTEL sink closes the parent span and
    // attaches the verdict; pino sink writes one JSON line.
    observability.logEvent({
      event: "beat.completed",
      beatId,
      role: input.role,
      durationMs: beatEndedAt - beatStartedAt,
      verdictOutcome: verdict,
      verdictScore: verdict === "pass" ? 1 : 0,
      ts: beatEndedAt,
    });

    // eslint-disable-next-line no-unsafe-finally
    return { beatId, sessionId, verdict, cause, tokensUsed };
  }
}
