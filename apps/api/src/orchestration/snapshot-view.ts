/**
 * Snapshot view — Spec 31 Phase 7.B.4.
 *
 * `buildSnapshotView(companyId)` assembles a fresh `CompanySnapshot`
 * from canonical reads. The B.4 plan flagged a decision: restructure
 * `@arceus/task-engine` to take `(companyId, repos)`, OR build a
 * snapshot-view adapter that lets task-engine keep its
 * `(snapshot, …)` signature. We chose the adapter — smaller blast
 * radius, no cross-package coordination.
 *
 * Audit (`grep snapshot\.\\w+ packages/task-engine/src`) shows
 * task-engine reads exactly five top-level fields: `company`,
 * `agents`, `sprints`, `tasks`, `approvals`. We populate those from
 * canonical and leave the rest at the empty-snapshot defaults — they
 * carry no information task-engine consumes today.
 *
 * Performance: one Promise.all of 5 parallel queries per call. Hot
 * paths that need the view multiple times in close succession should
 * cache the result for the duration of the operation rather than
 * re-fetching.
 */
import type {
  AgentIdentity,
  Approval,
  CompanySnapshot,
  Sprint,
  Task,
} from "@arceus/contracts";
import { createEmptyCompanySnapshot } from "@arceus/company-runtime";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";

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
    /** No canonical hierarchy_nodes row materialised by default; nodeId is empty until B.5 wires hierarchy reads. */
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
    /** Session binding lookup is per-beat; the snapshot view leaves
     *  this empty so task-engine code paths that don't need it
     *  don't pay the FK lookup cost. */
    sessionBindingId: "",
    memorySummaryId: `memory_${row.id}`,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
  };
}

/**
 * Build a CompanySnapshot view for the given company. Five fields
 * are populated from canonical (`company`, `agents`, `sprints`,
 * `tasks`, `approvals`) — the five task-engine reads. Other
 * snapshot fields default to the empty shape; callers must not
 * assume `idea`, `strategy`, `hierarchy`, `memories`,
 * `meetingSchedules`, `transitions`, `feedbackRounds`,
 * `chatMessages`, `meetings`, `artifacts`, `sessions`,
 * `memoryUnits`, `habits`, or `priming` are populated.
 *
 * Throws when the company id can't be resolved — the snapshot view
 * is meaningful only for an existing company.
 */
export async function buildSnapshotView(companyId: string): Promise<CompanySnapshot> {
  const db = getDb();
  const [company, agentRows, sprintRows, tasks, approvalRows] = await Promise.all([
    companiesRepo.findByIdHydrated(db, companyId),
    agentsRepo.listAgentsByCompany(db, companyId),
    sprintsRepo.listSprintsByCompany(db, companyId),
    tasksRepo.listByCompanyHydrated(db, companyId),
    approvalsRepo.listApprovalsByCompany(db, companyId),
  ]);

  if (!company) {
    throw new Error(`buildSnapshotView: company ${companyId} not found`);
  }

  const agents: AgentIdentity[] = agentRows.map(rowToAgentIdentity);
  const sprints: Sprint[] = sprintRows.map(sprintsRepo.rowToSprint);
  const approvals: Approval[] = approvalRows.map(approvalsRepo.rowToApproval);

  const empty = createEmptyCompanySnapshot();
  return {
    ...empty,
    company,
    agents,
    sprints,
    tasks: tasks as Task[],
    approvals,
  };
}
