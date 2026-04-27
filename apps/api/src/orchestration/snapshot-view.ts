/**
 * Snapshot view — Spec 31 Phase 7.B.4 / 7.C.a.
 *
 * `buildSnapshotView(companyId)` assembles a fresh `CompanySnapshot`
 * from canonical reads. Phase 7.B.4 introduced the adapter populating
 * five fields. Phase 7.C.a extends it to the full snapshot shape so
 * callers that previously read the in-memory snapshot directly can
 * migrate without losing fields.
 *
 * Populated from canonical (10 parallel queries):
 *   company, idea, strategy, agents, sprints, hierarchy, memories,
 *   tasks, approvals, meetings, meetingSchedules, chatMessages.
 *
 * Left at empty defaults (owned elsewhere):
 *   sessions          — per-beat surface; lookup via `session_bindings`
 *                       at point of use, not the snapshot view.
 *   artifacts         — orchestration runtime state (`state.ts`).
 *   transitions,
 *   feedbackRounds    — orchestration runtime state (`state.ts`).
 *   memoryUnits,
 *   habits, priming   — hippocampus subsystem maintains its own reads.
 *
 * Performance: one Promise.all of ~12 parallel queries per call. Hot
 * paths that need the view multiple times in close succession should
 * cache the result for the duration of the operation rather than
 * re-fetching.
 */
import type {
  AgentIdentity,
  Approval,
  ChatMessage,
  CompanySnapshot,
  Meeting,
  MeetingSchedule,
  MemorySummary,
  HierarchyNode,
  Sprint,
  Task,
} from "@arceus/contracts";
import { createEmptyCompanySnapshot } from "@arceus/company-runtime";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as hierarchyNodesRepo from "@arceus/db/src/repos/hierarchy_nodes.js";
import * as ideasRepo from "@arceus/db/src/repos/ideas.js";
import * as meetingsRepo from "@arceus/db/src/repos/meetings.js";
import * as meetingSchedulesRepo from "@arceus/db/src/repos/meeting_schedules.js";
import * as memorySummariesRepo from "@arceus/db/src/repos/memory_summaries.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as strategyBriefsRepo from "@arceus/db/src/repos/strategy_briefs.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";

/** Cap on chatMessages loaded into a snapshot view. Bounded to keep
 *  hot-path latency stable as boards age — consumers that need full
 *  history should query board_messages directly with cursor pagination. */
const CHAT_HISTORY_LIMIT = 200;

/**
 * Hydrate the canonical agent row to the contracts.AgentIdentity
 * shape expected by `snapshot.agents`. The runtime fields the
 * snapshot carries (`title`, `profile`, `capabilities`, `soul`,
 * etc.) all live on the canonical `agents` schema after spec 31
 * Phase 7.A — no separate fetch needed.
 */
function rowToAgentIdentity(row: Awaited<ReturnType<typeof agentsRepo.listAgentsByCompany>>[number]): AgentIdentity {
  return {
    id: row.id,
    companyId: row.companyId,
    nodeId: "",
    name: row.displayName,
    role: row.role as AgentIdentity["role"],
    title: row.title ?? "",
    managerAgentId: row.managerAgentId ?? null,
    reportAgentIds: row.reportAgentIds ?? [],
    capabilities: row.capabilities ?? [],
    profile: row.profile ?? "",
    soul: (row.soul ?? {}) as AgentIdentity["soul"],
    status: (row.status ?? "idle") as AgentIdentity["status"],
    sessionBindingId: "",
    memorySummaryId: `memory_${row.id}`,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
  };
}

/**
 * Build a full CompanySnapshot view for the given company. Twelve fields
 * populated from canonical; the four runtime-state fields and `sessions`
 * default to the empty shape (see file-level comment for rationale).
 *
 * Throws when the company id can't be resolved — the snapshot view
 * is meaningful only for an existing company.
 */
export async function buildSnapshotView(companyId: string): Promise<CompanySnapshot> {
  const db = getDb();
  const [
    company,
    idea,
    strategy,
    agentRows,
    sprintRows,
    hierarchyRows,
    memorySummaryRows,
    tasks,
    approvalRows,
    meetingRows,
    meetingScheduleRows,
    chatMessageRows,
  ] = await Promise.all([
    companiesRepo.findByIdHydrated(db, companyId),
    ideasRepo.findByCompanyHydrated(db, companyId),
    strategyBriefsRepo.findActiveByCompany(db, companyId),
    agentsRepo.listAgentsByCompany(db, companyId),
    sprintsRepo.listSprintsByCompany(db, companyId),
    hierarchyNodesRepo.listByCompany(db, companyId),
    memorySummariesRepo.listByCompany(db, companyId),
    tasksRepo.listByCompanyHydrated(db, companyId),
    approvalsRepo.listApprovalsByCompany(db, companyId),
    meetingsRepo.listMeetingsByCompany(db, companyId),
    meetingSchedulesRepo.listByCompany(db, companyId),
    boardMessagesRepo.listBoardMessages(db, companyId, CHAT_HISTORY_LIMIT),
  ]);

  if (!company) {
    throw new Error(`buildSnapshotView: company ${companyId} not found`);
  }

  const empty = createEmptyCompanySnapshot();

  const agents: AgentIdentity[] = agentRows.map(rowToAgentIdentity);
  const sprints: Sprint[] = sprintRows.map(sprintsRepo.rowToSprint);
  const hierarchy: HierarchyNode[] = hierarchyRows.map(hierarchyNodesRepo.rowToNode);
  const memories: MemorySummary[] = memorySummaryRows.map(memorySummariesRepo.rowToSummary);
  const approvals: Approval[] = approvalRows.map(approvalsRepo.rowToApproval);
  const meetings: Meeting[] = meetingRows.map(meetingsRepo.rowToMeeting);
  const meetingSchedules: MeetingSchedule[] = meetingScheduleRows.map(meetingSchedulesRepo.rowToSchedule);
  // board_messages.listBoardMessages returns DESC for cursor-style paging;
  // restore ascending order for the snapshot's chronological chat log.
  const chatMessages: ChatMessage[] = chatMessageRows
    .map(boardMessagesRepo.rowToChatMessage)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    ...empty,
    company,
    idea: idea ?? empty.idea,
    strategy: strategy ? strategyBriefsRepo.rowToStrategy(strategy) : empty.strategy,
    agents,
    sprints,
    hierarchy,
    memories,
    tasks: tasks as Task[],
    approvals,
    meetings,
    meetingSchedules,
    chatMessages,
  };
}
