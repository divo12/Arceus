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
import { getOpencode, resetOpencodeConnection } from "../infra/opencode.js";
import { ensureDeployment } from "../config/index.js";
import { buildBeatContext, prepareBeatRender } from "./beat-context-builder.js";
import { registerSessionContext, unregisterSessionContext } from "./session-context.js";
import { materializeBeatSkills } from "../opencode/materialize-beat-skills.js";
import { cleanupBeatScratch } from "../infra/beat-paths.js";
import { scoreBeatVerdict, clearBeatTaskTransitions } from "./beat-scoring.js";
import { getBeatSkillUsage, clearBeatSkillUsage } from "../routes/internal-telemetry.routes.js";
import { registerPromptCompletion } from "../prompts/llm.js";
import {
  startBeatTokenAccumulator,
  drainBeatTokenAccumulator,
  startBeatToolCallAccumulator,
  drainBeatToolCallAccumulator,
} from "../infra/azure-openai.js";
import { startHeartbeatRun, finishHeartbeatRun, bindSession, unbindSession } from "./beat-lifecycle.js";
import { updateTrustScore } from "../governance/trust.js";
import { persistSkillUsageEvent } from "../skills/usage-persistence.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { getDb } from "@arceus/db";
import { setTaskStatus } from "../tasks/mutations.js";
import { emitEmployeeActivity, shortBeat } from "../observability/activity.js";
import { swallowAndAudit, swallowAndReport } from "../observability/swallow.js";

const HARD_CAP_MS = 15 * 60 * 1000;

interface BeatResult {
  beatId: string;
  sessionId: string;
  verdict: "pass" | "fail";
  cause?: string;
  tokensUsed: number;
  /** Total tool calls observed during the beat (arceus_* MCP + built-in OpenCode tools). */
  toolCalls: number;
}

/**
 * Classify an error as an OpenCode connection failure that warrants
 * invalidating the cached `opencodePromise`. Covers undici's generic
 * "fetch failed", explicit ECONNREFUSED / ECONNRESET, and the SDK's
 * own connection-related messages. We deliberately match on substrings
 * because the SDK wraps undici errors and the .cause chain isn't
 * reliably exposed across all paths.
 */
function isOpencodeConnectionFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const msg = `${e.message ?? ""} ${e.cause?.message ?? ""}`.toLowerCase();
  if (e.cause?.code === "ECONNREFUSED" || e.cause?.code === "ECONNRESET") return true;
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("other side closed")
  );
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
  startBeatToolCallAccumulator(beatId);

  // Step 3: create session
  const session = await createBeatSession(input.role, beatId);
  const sessionId = session.id;

  // Step 2+4: build context, register
  const ctx = await buildBeatContext(input.role, input.companyId, beatId, sessionId);
  registerSessionContext(ctx);

  // Spec 31 Phase 5 — durable run + session binding rows. Returns null if
  // dual-write was skipped (e.g. agent FK not yet persisted); subsequent
  // helpers no-op cleanly in that case.
  const runDbId = await startHeartbeatRun({
    beatId,
    companyId: input.companyId,
    role: input.role,
    sessionId,
    trustBand: ctx.trustBand,
  });
  await bindSession({
    sessionId,
    beatDbId: runDbId,
    companyId: input.companyId,
    role: input.role,
    trustBand: ctx.trustBand,
    allowedTools: ctx.allowedTools,
  });

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

  // Spec 31 Phase 7.B.3 — single batch fetch yields shownTasks +
  // openTaskCount + stateText. Replaces three separate snapshot derefs.
  const beatRender = await prepareBeatRender(input.role, input.companyId);

  // Diagnostic — capture exactly what the agent will see in `## Your Tasks`.
  // If the LLM later claims an id that's not in this list, we know it
  // hallucinated rather than picked from rendered state.
  observability.logEvent({
    event: "beat.context",
    beatId,
    role: input.role,
    shownTasks: beatRender.shownTasks,
    ts: Date.now(),
  });

  // Vision guard — if the agent has nothing to do, skip the prompt entirely.
  // Without this, a bored LLM with no claimed task invents filler artifacts
  // (e.g. placeholder.md, noop.md) just to fill the response window.
  const openTaskCount = beatRender.openTaskCount;
  const incomingHandoffCount = ctx.incomingHandoffs.length;
  if (openTaskCount === 0 && incomingHandoffCount === 0) {
    unregisterSessionContext(sessionId);
    await destroyBeatSession(sessionId);
    const tokensUsed = drainBeatTokenAccumulator(beatId);
    const toolCalls = drainBeatToolCallAccumulator(beatId);
    await finishHeartbeatRun({ runDbId, beatId, verdict: "pass", cause: "no-work", totalTokens: tokensUsed });
    await unbindSession(sessionId);
    swallowAndAudit("trust.update.no_work", () => updateTrustScore(input.role, input.companyId, "pass"), {
      companyId: input.companyId,
      agentRole: input.role,
      beatId,
    });
    observability.logEvent({
      event: "beat.completed",
      beatId,
      role: input.role,
      verdictOutcome: "pass",
      verdictScore: 1,
      durationMs: Date.now() - beatStartedAt,
      ts: Date.now(),
    });
    return { beatId, sessionId, verdict: "pass", cause: "no-work", tokensUsed, toolCalls };
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
    // Step 6: wake the agent (blocks, with hard cap). State text was
    // built from the beat-render batch fetch above; no second pass.
    const stateText = beatRender.stateText;
    const soul = ROLE_SOULS[input.role].systemPrompt;
    const deployment = ensureDeployment("workerDeployment");

    const opencode = await getOpencode();
    const completionPromise = registerPromptCompletion(sessionId, HARD_CAP_MS);

    // Vision Step 6 — pass per-beat tool allowlist so the LLM only sees
    // function schemas it's allowed to call this beat. Mirrors the static
    // opencode.json pattern: deny all arceus_* by default, re-enable the
    // ones in ctx.allowedTools. Built-in tools (bash, edit, read, ...) are
    // not listed here, so they stay enabled.
    const toolFilter: Record<string, boolean> = { "arceus_*": false };
    for (const name of ctx.allowedTools) {
      toolFilter[`arceus_${name}`] = true;
    }

    // Race the SDK call AND the completion poll against the hard cap.
    // Sequential await would hang for the full undici body timeout (30m)
    // if opencode never returns, swallowing the 15m cap entirely.
    const promptPromise = opencode.client.session.prompt({
      path: { id: sessionId },
      // The OpenCode SDK's body type doesn't expose `agent` in the public
      // typings yet; the runtime accepts it. Coerce through the SDK's
      // own parameter type rather than `any`.
      body: {
        model: { providerID: "azure", modelID: deployment },
        agent: input.role,
        system: soul,
        tools: toolFilter,
        parts: [{ type: "text", text: stateText }],
      },
    });

    await Promise.race([
      Promise.all([promptPromise, completionPromise]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => { reject(new Error(`Beat ${beatId} timed out after ${HARD_CAP_MS}ms (hard cap)`)); },
          HARD_CAP_MS,
        ).unref(),
      ),
    ]);
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

    // Cascade breaker: when the failure is a connection/fetch error to
    // OpenCode (TypeError: fetch failed, ECONNREFUSED, socket hang up,
    // undici-stack network errors), the cached `opencodePromise` is
    // pointing at a dead subprocess. Without invalidating it, every
    // subsequent beat resolves the same dead instance and fails the
    // exact same way — we observed 11+ consecutive beat_failed events
    // in production after a single OpenCode death.
    //
    // Fire-and-forget so we don't delay this beat's cleanup. Next
    // beat's getOpencode() will see opencodePromise === null and
    // respawn against whatever port is actually free. Self-healing.
    if (isOpencodeConnectionFailure(e)) {
      void resetOpencodeConnection().catch(() => { /* best effort */ });
    }
  } finally {
    // Steps 16–22: scoring + cleanup, always runs
    const verdict = cause === "beat_hard_cap"
      ? "fail"
      : await scoreBeatVerdict(beatId);

    const usedSkills = getBeatSkillUsage(beatId);
    const outcomeScore = verdict === "pass" ? 1 : 0;
    if (usedSkills.length > 0) {
      const names = usedSkills
        .map((sid) => getSkillById(sid)?.name ?? sid)
        .join(", ");
      emitEmployeeActivity(
        input.role,
        "context",
        `${shortBeat(beatId)}: skills used (${usedSkills.length}) — ${names} → ${verdict}`,
        { beatId, detail: { skillIds: usedSkills, verdict } },
      );
    }
    for (const skillId of usedSkills) {
      updateSuccessRate(skillId, outcomeScore);
      // Spec 31 Phase 5 — durable mirror for the EMA. Read the registry
      // *after* updateSuccessRate so the persisted row carries the new
      // rate; the event row independently captures this beat's verdict.
      const skill = getSkillById(skillId);
      if (skill) {
        swallowAndAudit("skill_usage.persist", () => persistSkillUsageEvent({
          skill,
          companyId: input.companyId,
          role: input.role,
          beatDbId: runDbId,
          outcomeScore,
        }), {
          companyId: input.companyId,
          agentRole: input.role,
          beatId,
          detail: { skillId },
        });
      }
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
            emitEmployeeActivity(
              "skills_lead",
              "decision",
              `Evolution job enqueued: ${skill.name} (EMA ${skill.successRate.toFixed(2)} < baseline ${baseline.toFixed(2)} − 0.15, n=${skill.usageCount})`,
              { beatId, detail: { skillId, trigger: "ema_drop", baseline, currentEma: skill.successRate } },
            );
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

    // Vision §11 — release any claims this beat still holds. A claimed
    // task that didn't reach completed/blocked is orphaned; without this
    // it stays in_progress with checkout_run_id pointing at a dead beat,
    // and the next beat for the same role sees shownClaimableCount=0.
    if (verdict === "fail") {
      try {
        const released = await tasksRepo.releaseClaimsForBeat(getDb(), beatId);
        for (const tid of released) {
          // setTaskStatus is best-effort here — the canonical claim is
          // already released by the repo call above; this keeps any
          // optional in-memory mirror in sync. Awaitable swallow so the
          // loop stays sequential (matches prior try/catch semantics).
          await swallowAndReport("task.status.release", () =>
            setTaskStatus(tid, "planned", `claim released after beat ${beatId} failed (${cause ?? "unknown"})`),
          { companyId: input.companyId, agentRole: input.role, beatId, detail: { taskId: tid } });
        }
        if (released.length > 0) {
          // task_lifecycle is a freeform legacy variant on ArceusEvent;
          // the typed schema doesn't pin every field, so we widen via the
          // event union itself rather than `any`.
          observability.logEvent({
            event: "task_lifecycle",
            beatId,
            role: input.role,
            kind: "claim_released",
            taskIds: released,
            cause: cause ?? "beat_failed",
            ts: Date.now(),
          } as unknown as Parameters<typeof observability.logEvent>[0]);
        }
      } catch (err) {
        observability.logEvent({
          event: "error",
          where: "run_beat.release_claims",
          message: err instanceof Error ? err.message : String(err),
          beatId,
          ts: Date.now(),
        });
      }
    }

    unregisterSessionContext(sessionId);
    await destroyBeatSession(sessionId);
    await cleanupBeatScratch(beatId);

    const tokensUsed = drainBeatTokenAccumulator(beatId);
    const toolCalls = drainBeatToolCallAccumulator(beatId);
    const beatEndedAt = Date.now();

    // Spec 31 Phase 5 — close out the run + binding, EMA-update trust.
    await finishHeartbeatRun({ runDbId, beatId, verdict, cause, totalTokens: tokensUsed });
    await unbindSession(sessionId);
    swallowAndAudit("trust.update.beat_end", () => updateTrustScore(input.role, input.companyId, verdict), {
      companyId: input.companyId,
      agentRole: input.role,
      beatId,
      detail: { verdict, cause },
    });

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
    return { beatId, sessionId, verdict, cause, tokensUsed, toolCalls };
  }
}
