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
import { takeResumableSession, storeResumableSession, isSessionAlive, SESSION_RESUME_LIMIT } from "./session-resume.js";
import { cleanupBeatScratch } from "../infra/beat-paths.js";
import { forgetBeatActivity } from "../heartbeats/watchdog.js";
import { scoreBeatVerdict, clearBeatTaskTransitions } from "./beat-scoring.js";
import { getBeatSkillUsage, clearBeatSkillUsage } from "../routes/internal-telemetry.routes.js";
import { registerPromptCompletion, rejectPromptCompletion, isNudgeActive } from "../prompts/llm.js";
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
import { setTaskStatus, setTaskHeartbeat } from "../tasks/mutations.js";
import { emitEmployeeActivity, shortBeat } from "../observability/activity.js";
import { swallowAndAudit, swallowAndReport } from "../observability/swallow.js";
import { getHeadSha } from "../workspace/git-ops.js";
import { workspaceManager } from "../workspace/manager.js";
import { reviewBeatAndAutoFix } from "./code-review.js";
import { checkSprintCompletion } from "../sprints/lifecycle.js";

// Aligned with beatTimeoutMs in config/heartbeat.json (15 min).
//
// History: 15 → 10 (2026-06-11 morning) when stalls were undetectable and
// the cap was the only defense; 10 → 15 (same day, evening) once the
// stall stack landed. With the silence watchdog + stall-nudge reaping
// hung requests in ~2.5-5 min, ONLY productive beats ever reach this
// ceiling — and post-stall-fix telemetry showed 6 developer beats killed
// at 10:00 mid-work ("Beat timed out before serialize phase") while
// 4 passed. The cap should serve working beats, not kill them. The
// wrap-up nudge (prompts/llm.ts) fires 2 min before this cap so beats
// finish clean instead of getting guillotined.
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

  // Spec 18 — capture the workspace HEAD before a developer beat so the
  // post-beat code review can diff exactly what THIS beat wrote. Read-only
  // and best-effort (null on a repo with no commits → that beat is skipped,
  // the next one has a baseline). Developer beats only.
  let reviewBeforeSha: string | null = null;
  if (input.role === "developer") {
    reviewBeforeSha = (await swallowAndReport(
      "code_review.before_sha",
      () => getHeadSha(workspaceManager.getLocalPath(input.companyId)),
      { companyId: input.companyId, agentRole: input.role, beatId },
    )) ?? null;
  }

  // Sprint progression (gate-free self-heal) — finalize a fully-completed
  // sprint DETERMINISTICALLY at the start of a CEO beat, rather than
  // relying on the CEO agent remembering to call sprint_finalize (and on
  // the per-task `setTaskStatus` trigger not racing its own commit on the
  // last task). Pairs with `roleHasClaimableWork` (runtime.ts) which now
  // wakes the CEO when the sprint is all-terminal — without that wake no
  // beat would ever run to reach here. Idempotent (sprintCompletionGate) +
  // best-effort; never blocks the beat. On finalize, checkSprintCompletion
  // emits the reactive "sprint_completed" CEO wake, so this same beat's
  // agent (its context is built below) sees a completed sprint and plans
  // the next one. Bug found live 2026-06-13 — see project_sprint_chaining_stuck.
  if (input.role === "ceo") {
    await swallowAndReport(
      "sprint.finalize_on_ceo_beat",
      () => checkSprintCompletion(input.companyId),
      { companyId: input.companyId, agentRole: "ceo", beatId },
    );
  }

  // Step 3: acquire session — F7 resume-or-create.
  //
  // If the role's previous beat parked a session with an UNFINISHED task
  // (released after a reap, or passed-but-incomplete), and that task is
  // still open, and OpenCode still holds the session, this beat continues
  // the SAME conversation: files already read stay read, design decisions
  // stay in working memory, and the cold-start re-derivation cost (the
  // original over-read pathology) disappears. Falls back to a fresh
  // session on any doubt — dead session, finished task, resume cap hit.
  const acquired = await (async (): Promise<{
    sessionId: string;
    resumedFrom: { taskId: string; resumeCount: number } | null;
  }> => {
    const resumeCandidate = takeResumableSession(input.companyId, input.role);
    if (resumeCandidate) {
      const task = await swallowAndReport(
        "session_resume.task_check",
        () => tasksRepo.findByIdHydrated(getDb(), resumeCandidate.taskId),
        { companyId: input.companyId, agentRole: input.role, beatId },
      );
      const taskStillOpen = task != null && (task.status === "planned" || task.status === "in_progress");
      if (taskStillOpen && resumeCandidate.resumeCount < SESSION_RESUME_LIMIT && (await isSessionAlive(resumeCandidate.sessionId))) {
        const resumeCount = resumeCandidate.resumeCount + 1;
        emitEmployeeActivity(
          input.role,
          "info",
          `${shortBeat(beatId)}: resuming previous session (${resumeCandidate.sessionId.slice(0, 12)}…, resume ${resumeCount}/${SESSION_RESUME_LIMIT}) — task ${resumeCandidate.taskId} still open`,
          { beatId, detail: { sessionId: resumeCandidate.sessionId, taskId: resumeCandidate.taskId } },
        );
        return {
          sessionId: resumeCandidate.sessionId,
          resumedFrom: { taskId: resumeCandidate.taskId, resumeCount },
        };
      }
      // Stale entry — finished task, dead session, or resume cap hit.
      // Retire the old session quietly and start fresh.
      swallowAndAudit("session_resume.discard", () => destroyBeatSession(resumeCandidate.sessionId), {
        companyId: input.companyId,
        agentRole: input.role,
        beatId,
      });
    }
    const session = await createBeatSession(input.role, beatId);
    return { sessionId: session.id, resumedFrom: null };
  })();
  const sessionId = acquired.sessionId;
  const resumedFrom = acquired.resumedFrom;

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

  // Step 5 (V1): skills are materialized statically at boot (and on
  // company-create) into productWorkspace/.opencode/skills/ via
  // materializeStaticSkillsForCompany. The per-beat materialize+symlink
  // dance is gone — there's no observed scenario where the skill set
  // changes between beats of the same company, and the per-beat write
  // was paying for that non-existent invariant. Skill mutations during
  // runtime do NOT propagate to disk in V1 (deferred to a future hook
  // off setSkillRegistryDeps); they take effect on next boot.

  let cause: string | undefined;
  try {
    // Step 6: wake the agent (blocks, with hard cap). State text was
    // built from the beat-render batch fetch above; no second pass.
    const stateText = beatRender.stateText;
    // F7 — on a resumed session the prior conversation is already in the
    // model's context; the banner stops it from re-deriving what it
    // already knows. Fresh sessions get the plain state text.
    const promptText = resumedFrom
      ? `[resume] This conversation continues YOUR OWN previous beat on task ${resumedFrom.taskId}. ` +
        `Everything above is your prior context — files you already read are still read, your design decisions stand. ` +
        `CRITICAL FIRST STEP: your previous beat's claim was RELEASED when it ended — you do NOT currently own the task, ` +
        `even though you remember claiming it. Call task_claim({taskId: "${resumedFrom.taskId}"}) FIRST; without it, ` +
        `task_complete will be rejected with snapshot_stale. After claiming, do NOT re-read files or re-plan — ` +
        `pick up exactly where your trail ends. Current state follows.\n\n${stateText}`
      : stateText;
    const soul = ROLE_SOULS[input.role].systemPrompt;
    // All employee beats use the CEO-class deployment (gpt-5.2). Craft
    // quality for websites depends on model power across designer, developer,
    // tester, and planning roles — not only the CEO chat path.
    const deployment = ensureDeployment("ceoDeployment");

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

    // Fire-and-forget the SDK call (mirrors runPromptText): completion is
    // detected via SSE session.idle + the polling fallback, both feeding
    // completionPromise. The prompt call's own rejection still fails the
    // beat fast — UNLESS a stall-nudge owns the session, in which case the
    // rejection is our own abort and the nudged attempt continues on the
    // same completionPromise. Sequential await of the prompt call would
    // also hang for the full undici body timeout (30m) if opencode never
    // returns, swallowing the hard cap entirely.
    opencode.client.session.prompt({
      path: { id: sessionId },
      // The OpenCode SDK's body type doesn't expose `agent` in the public
      // typings yet; the runtime accepts it. Coerce through the SDK's
      // own parameter type rather than `any`.
      body: {
        model: { providerID: "azure", modelID: deployment },
        agent: input.role,
        system: soul,
        tools: toolFilter,
        parts: [{ type: "text", text: promptText }],
      },
    }).catch((err: unknown) => {
      if (isNudgeActive(sessionId)) return;
      rejectPromptCompletion(
        sessionId,
        err instanceof Error ? err : new Error(String(err)),
      );
    });

    await Promise.race([
      completionPromise,
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

    // F6 harvest — tasks that should receive this beat's outcome trail.
    // Fail path: filled from the claim release below. Pass path: filled
    // after the drains from the still-claimed set (a passing beat that
    // didn't finish its task leaves the claim in place).
    let harvestTaskIds: string[] = [];

    // F6 harvest — last assistant note, fetched BEFORE the session is
    // destroyed. Only on fail: passing beats persist their own state via
    // task_complete/artifact_create; the tail matters when the beat was
    // reaped and its narrative would otherwise vanish with the session.
    const lastNote = verdict === "fail"
      ? (await swallowAndReport("beat.harvest_last_note", async () => {
          const opencode = await getOpencode();
          const messagesResult = await opencode.client.session.messages({ path: { id: sessionId } });
          const assistant = (messagesResult.data ?? []).filter((m) => m.info?.role === "assistant");
          const last = assistant[assistant.length - 1];
          return (last?.parts ?? [])
            .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(-180);
        }, { companyId: input.companyId, agentRole: input.role, beatId })) ?? ""
      : "";

    // Vision §11 — release any claims this beat still holds. A claimed
    // task that didn't reach completed/blocked is orphaned; without this
    // it stays in_progress with checkout_run_id pointing at a dead beat,
    // and the next beat for the same role sees shownClaimableCount=0.
    if (verdict === "fail") {
      try {
        const released = await tasksRepo.releaseClaimsForBeat(getDb(), beatId);
        harvestTaskIds = released;
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
    // F7 — session destruction is deferred to the park-or-retire decision
    // below, after harvestTaskIds is finalized (it names the unfinished
    // task that justifies keeping the session alive).
    await cleanupBeatScratch(beatId);
    forgetBeatActivity(beatId);

    const tokensUsed = drainBeatTokenAccumulator(beatId);
    const toolCalls = drainBeatToolCallAccumulator(beatId);
    const beatEndedAt = Date.now();

    // F6 harvest-on-kill — stamp a one-line outcome onto every task this
    // beat had claimed, rendered next beat under "Previously on this
    // task" (beat-context-builder). Pass-but-unfinished beats leave a
    // trail too: their claims survive, so the still-claimed set is the
    // harvest target. Without this, a reaped beat's work narrative
    // vanishes with the session and the next claimant re-derives
    // everything from scratch.
    if (verdict !== "fail") {
      harvestTaskIds = (await swallowAndReport(
        "beat.harvest_targets",
        () => tasksRepo.listClaimedTaskIdsForBeat(getDb(), beatId),
        { companyId: input.companyId, agentRole: input.role, beatId },
      )) ?? [];
    }
    if (harvestTaskIds.length > 0) {
      const outcome =
        `⏹ beat ${shortBeat(beatId)} ended ${verdict}${cause ? ` (${cause})` : ""} — ` +
        `${toolCalls} tool calls, ${Math.round(tokensUsed / 1000)}k tokens` +
        (lastNote ? ` — last note: "${lastNote}"` : "");
      for (const tid of harvestTaskIds) {
        // Beat-end safety stamp into the heartbeat's done-log (accumulates), so
        // continuity survives even if the agent didn't write its own heartbeat.
        // setTaskHeartbeat swallows + reports its own failures.
        await setTaskHeartbeat(tid, { done: [outcome] });
      }
    }

    // Spec 18 — non-blocking code review of what this developer beat
    // wrote. Fire-and-forget: it commits + diffs the workspace, reviews
    // the diff with a cheap LLM, and on critical/high findings auto-spawns
    // a bug_fix task the heartbeat picks up (gate-free auto-fix loop). It
    // NEVER awaits in the beat path or affects this beat's verdict — the
    // review runs in parallel with subsequent beats; git-ops' per-workspace
    // lock serializes its commit safely against the next beat.
    if (input.role === "developer" && verdict === "pass" && reviewBeforeSha) {
      void reviewBeatAndAutoFix({
        companyId: input.companyId,
        beatId,
        taskId: harvestTaskIds[0] ?? null,
        taskTitle: `beat ${shortBeat(beatId)}`,
        beforeSha: reviewBeforeSha,
      });
    }

    // F7 — park or retire the session. A beat that leaves its task
    // unfinished (harvestTaskIds[0]: released on fail, still-claimed on
    // pass) parks its session so the role's next beat resumes the same
    // conversation instead of cold-starting. Finished/idle beats and
    // sessions at the resume cap retire normally; a dead/respawned
    // OpenCode makes the parked entry fail its liveness probe next beat,
    // so parking is always safe.
    const resumeTaskId = harvestTaskIds[0] ?? null;
    const priorResumes = resumedFrom?.resumeCount ?? 0;
    if (resumeTaskId && priorResumes < SESSION_RESUME_LIMIT) {
      storeResumableSession(input.companyId, input.role, {
        sessionId,
        taskId: resumeTaskId,
        resumeCount: priorResumes,
      });
      emitEmployeeActivity(
        input.role,
        "info",
        `${shortBeat(beatId)}: session parked for resume on ${resumeTaskId} (resumes so far: ${priorResumes}/${SESSION_RESUME_LIMIT})`,
        { beatId, detail: { sessionId, taskId: resumeTaskId } },
      );
    } else {
      await destroyBeatSession(sessionId);
    }

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
