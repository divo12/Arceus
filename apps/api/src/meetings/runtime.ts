/**
 * Meeting runtime factory.
 * Spec 18 / Spec 24 / Spec 31 / Spec 34 v3 PR 12.
 *
 * Constructs the MeetingPipeline (collect → synthesize → resolve → execute
 * → brief → memories → escalation) plus the MeetingScheduler that owns the
 * 30s tick + dailySync cadence. Returned values are started by the
 * bootstrap orchestrator only when an active sprint is executing.
 */
import { z } from "zod";
import {
  MeetingPipeline,
  MeetingScheduler,
  extractMeetingMemories,
  getRoleSoul,
} from "@arceus/company-runtime";
import { MEETING_EXTRACTION_PROMPT, buildMeetingExtractionPrompt } from "@arceus/hippocampus";
import { drainMeetingTokenAccumulator, startMeetingTokenAccumulator, structuredCompletion } from "../infra/azure-openai.js";
import { hippocampus } from "../memory/extractors.js";
import { runFacilitatorSession } from "./facilitator.js";
import { buildContributionPrompt } from "./contribution-prompt.js";
import { executeMeetingDecisions, postDailySyncSummary } from "./resolution.js";
import { ensureAgentSession, runPromptText } from "../prompts/llm.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getMostRecentCompanyId } from "../companies/resolve-company.js";
import {
  appendChatMessage,
  commitScheduledMeeting,
  flush,
  recordScheduleSkip,
  transitionMeetingStatus,
  updateMeeting,
  updateMeetingSchedule,
  updateTask,
  upsertApproval,
  upsertMeeting,
  upsertMeetingSchedule,
  upsertTask,
} from "../persistence/mutations/index.js";

interface Contribution {
  whatIDid: string;
  whatImDoing: string;
  blockers: string;
  learnings: string;
  questionsForTeam: string;
}

const extractedFactSchema = z.object({
  facts: z.array(z.object({
    content: z.string(),
    type: z.enum(["static", "dynamic", "procedural"]),
    confidence: z.number(),
    is_temporal: z.boolean(),
    expiry_days: z.number().nullable(),
    trigger: z.string().nullable(),
    action: z.string().nullable(),
  })),
});

export interface MeetingRuntime {
  pipeline: MeetingPipeline;
  scheduler: MeetingScheduler;
}

/**
 * Spec 31 Phase 7.C.b — package deps consume async getSnapshot. Native
 * multi-tenant: resolves the most-recent company from canonical (no global
 * pointer). No company → throw, since the meeting pipeline can't operate before
 * bootstrap. NOTE: the meeting pipeline is single-tenant-shaped here; meetings
 * are gated off in prod (ARCEUS_MEETINGS_ENABLED). A future redesign threads a
 * per-meeting companyId through the company-runtime deps to make this per-tenant.
 */
async function getSnapshotForPackages() {
  const id = await getMostRecentCompanyId();
  if (!id) throw new Error("No company; meeting pipeline cannot read snapshot.");
  return buildSnapshotView(id);
}

export function createMeetingRuntime(): MeetingRuntime {
  const pipeline = new MeetingPipeline({
    getSnapshot: getSnapshotForPackages,
    updateMeeting,
    transitionMeetingStatus,
    flush,

    // Phase 8: Token tracking for meeting pipeline
    startTokenTracking: (meetingId) => { startMeetingTokenAccumulator(meetingId); },
    drainTokens: (meetingId) => drainMeetingTokenAccumulator(meetingId),

    // Phase 4a (Spec 24): Collect contributions by directly prompting each agent's session.
    // Spec 31 Phase 7.C.c — canonical-backed snapshot.
    async collectContributions(meeting) {
      const snap = await getSnapshotForPackages();
      console.log(`[MEETING] ${meeting.id} (${meeting.type}) collecting contributions from ${meeting.participantAgentIds.length} participant(s)`);

      for (const agentId of meeting.participantAgentIds) {
        const agent = snap.agents.find((a) => a.id === agentId);
        if (!agent) continue;

        try {
          const soul = getRoleSoul(agent.role);
          const meetingCompanyId = snap.company.id;
          const session = await ensureAgentSession(snap, agent.role, meetingCompanyId);

          const agentTasks = snap.tasks.filter((t) => t.assignedRole === agent.role);
          const taskSummary = agentTasks.length > 0
            ? agentTasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
            : "No tasks assigned.";

          const prompt = buildContributionPrompt(meeting, taskSummary);

          const output = await runPromptText(agent.role, session.sessionId, soul.systemPrompt, prompt, undefined, meetingCompanyId);
          const jsonMatch = /\{[\s\S]*\}/.exec(output);
          // The agent emits a JSON contribution; fall back to a default
          // shape if no JSON object is found. Cast at the boundary so
          // updateMeeting's Contribution type is satisfied without `any`.
          const contribution: Contribution = jsonMatch
            ? (JSON.parse(jsonMatch[0]) as Contribution)
            : { whatIDid: output, whatImDoing: "", blockers: "", learnings: "", questionsForTeam: "" };

          await updateMeeting(meeting.id, (m) => ({
            ...m,
            contributions: [
              ...m.contributions,
              {
                agentId: agent.id,
                agentName: agent.name,
                agentRole: agent.role,
                contribution,
                submittedAt: new Date().toISOString(),
              },
            ],
          }));
          await flush();
          console.log(`[MEETING] ${meeting.id} contribution received from ${agent.role}`);
        } catch (err) {
          console.warn(`[MEETING] Failed to collect contribution from ${agent.role}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const post = await getSnapshotForPackages();
      return post.meetings.find((m) => m.id === meeting.id) ?? meeting;
    },

    // Phase 4b (Spec 24): Facilitator Agent — synthesize, resolve, brief in one session
    async synthesizeMeeting(meeting) {
      const snap = await getSnapshotForPackages();
      const result = await runFacilitatorSession(meeting, snap);

      const updated = await updateMeeting(meeting.id, (m) => ({
        ...m,
        synthesis: result.synthesis,
        resolutions: result.resolutions,
        brief: result.brief ?? m.brief,
      }));
      await flush();
      return updated ?? meeting;
    },

    // Resolution is now handled inside synthesizeMeeting via facilitator session
    async resolveMeeting(meeting) {
      // Resolutions already set by facilitator in synthesizeMeeting
      return meeting;
    },

    // Phase 5: Execute resolution decisions
    async executeMeetingDecisions(meeting) {
      const snap = await getSnapshotForPackages();
      const result = await executeMeetingDecisions(meeting, snap, { upsertTask, updateTask, upsertApproval, appendChatMessage, flush });
      await flush();
      return result;
    },

    // Phase 5: Produce daily sync brief — already generated by facilitator, just post the card
    async produceBrief(meeting) {
      if (!meeting.brief) return meeting;
      const snap = await getSnapshotForPackages();
      await postDailySyncSummary(meeting, meeting.brief, snap, appendChatMessage);
      await flush();
      return meeting;
    },

    // Phase 6: Extract meeting memories for each participant
    async extractMemories(meeting) {
      const snap = await getSnapshotForPackages();

      const meetingFactExtractor = async (transcript: string, role: string, name: string) => {
        const userPrompt = buildMeetingExtractionPrompt(role, name, transcript);
        const result = await structuredCompletion(
          "workerDeployment",
          [
            { role: "system", content: MEETING_EXTRACTION_PROMPT },
            { role: "user", content: userPrompt },
          ],
          extractedFactSchema,
          "meeting_fact_extraction",
          { temperature: 0.3 },
        );
        return result.facts.map((f) => ({
          ...f,
          trigger: f.trigger ?? undefined,
          action: f.action ?? undefined,
        }));
      };

      const results = await extractMeetingMemories(meeting, snap, meetingFactExtractor);
      let totalStored = 0;

      for (const { memories } of results) {
        try {
          totalStored += await hippocampus.storeMemories(memories);
        } catch (err) {
          console.warn(`[MEETING-MEMORY] Failed to store memories: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return totalStored;
    },

    // Phase 7: Re-escalate if blocker is still unresolved after escalation meeting.
    // Spec 31 Phase 7.C.c — async; canonical-backed snapshot.
    async onEscalationComplete(meeting) {
      // Extract related task ID from title format: "Escalation: ... [taskId]"
      const taskIdMatch = /\[([^\]]+)\]$/.exec(meeting.title);
      const relatedTaskId = taskIdMatch?.[1] ?? null;

      if (relatedTaskId && relatedTaskId !== "general") {
        const snap = await getSnapshotForPackages();
        const task = snap.tasks.find((t) => t.id === relatedTaskId);
        if (task?.status === "blocked") {
          console.log(`[ESCALATION] Task ${relatedTaskId} still blocked after escalation meeting ${meeting.id} — escalating up`);
          await scheduler.escalateUp(
            snap,
            meeting,
            `Task "${task.title}" still blocked after escalation to ${snap.agents.find((a) => a.id === meeting.facilitatorAgentId)?.role ?? "manager"}`,
            relatedTaskId,
          );
        }
      }
    },
  });

  const scheduler = new MeetingScheduler(
    { tickIntervalMs: 30_000, defaultDailySyncIntervalMs: 300_000 },
    {
      getSnapshot: getSnapshotForPackages,
      upsertMeeting,
      upsertMeetingSchedule,
      updateMeetingSchedule,
      recordScheduleSkip,
      commitScheduledMeeting,
      flush,
      runPipeline: (meetingId) => pipeline.run(meetingId),
    },
  );

  return { pipeline, scheduler };
}
