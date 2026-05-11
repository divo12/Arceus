/**
 * Canonical seed — Spec 31 Phase 8.
 *
 * Idempotently creates one fully-populated company:
 *
 *   - 1 company (`company_seed_canonical`)
 *   - 8 agents (one per role)
 *   - 8 role_trust rows at band="standard"
 *   - 1 active sprint with 10 tasks across all status states
 *   - 5 artifacts (one per kind variety)
 *   - 2 meetings (one daily_sync, one decision)
 *   - 1 pending approval
 *   - 5 skill_artifacts × 10 skill_usage_events each = 50 events
 *   - 100 synthetic heartbeat_runs cycling across the 8 agents
 *
 * Used by:
 *   - `bun src/seed.ts` for manual reset of a dev DB to a known shape
 *   - `bun src/scripts/explain-audit.ts` for query plan testing on
 *     a non-empty table set so EXPLAIN reports realistic plans
 *   - integration tests that need a deterministic starting point
 *
 * Idempotent: re-running deletes the canonical company first, which
 * cascades to every child row via FK ON DELETE CASCADE / SET NULL.
 */
import "./load-env.js";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getDb } from "./client.js";
import { companies } from "./schema/companies.js";
import * as companiesRepo from "./repos/companies.js";
import * as agentsRepo from "./repos/agents.js";
import * as sprintsRepo from "./repos/sprints.js";
import * as tasksRepo from "./repos/tasks/index.js";
import * as artifactsRepo from "./repos/artifacts.js";
import * as meetingsRepo from "./repos/meetings.js";
import * as approvalsRepo from "./repos/approvals.js";
import * as roleTrustRepo from "./repos/role_trust.js";
import * as heartbeatRunsRepo from "./repos/heartbeat_runs.js";
import * as skillArtifactsRepo from "./repos/skill_artifacts.js";
import * as skillUsageEventsRepo from "./repos/skill_usage_events.js";

const COMPANY_ID = "company_seed_canonical";
const NOW_ISO = new Date().toISOString();
const NOW_DATE = new Date();

const ROLES = [
  "ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead",
] as const;
type Role = (typeof ROLES)[number];

interface SeedResult {
  companyId: string;
  agents: number;
  sprints: number;
  tasks: number;
  artifacts: number;
  meetings: number;
  approvals: number;
  skillArtifacts: number;
  skillUsageEvents: number;
  heartbeatRuns: number;
  roleTrust: number;
}

async function deleteCanonical(): Promise<void> {
  // ON DELETE CASCADE on every child FK to companies.id handles the
  // tear-down — agents, sprints, tasks, artifacts, meetings, approvals,
  // heartbeat_runs, skill_artifacts, role_trust all cascade. Workspaces +
  // sprint_snapshots (if any) cascade too.
  const db = getDb();
  const dbId = companiesRepo.toDbId(COMPANY_ID);
  await db.delete(companies).where(eq(companies.id, dbId));
}

async function seedCompany(): Promise<void> {
  const db = getDb();
  await companiesRepo.upsertCompany(db, {
    id: COMPANY_ID,
    name: "Canonical Seed Company",
    boardOwner: "seed",
    goal: "fixture company for explain-audit + integration tests",
    budgetCents: 1_000_000,
    spentCents: 0,
    status: "active",
    currentStrategyId: "strategy_seed_canonical",
    currentSprintId: "spr_seed_1",
    currentSprintNumber: 1,
    createdAt: NOW_ISO,
  });
}

async function seedAgents(): Promise<number> {
  const db = getDb();
  for (const role of ROLES) {
    await agentsRepo.upsertAgent(db, {
      id: `agent_${role}_seed`,
      companyId: COMPANY_ID,
      nodeId: `node_${role}_seed`,
      name: role,
      role,
      title: role.toUpperCase(),
      managerAgentId: null,
      reportAgentIds: [],
      capabilities: [],
      profile: "seed",
      // soul shape minimised — repo only reads `id`/`name`/`role`.
      soul: { systemPrompt: "seed", defaultCapabilities: [] } as never,
      status: "active",
      sessionBindingId: `session_${role}_seed`,
      memorySummaryId: `memory_${role}_seed`,
      lastHeartbeatAt: null,
    });
  }
  return ROLES.length;
}

async function seedRoleTrust(): Promise<number> {
  const db = getDb();
  const dbCompanyId = companiesRepo.toDbId(COMPANY_ID);
  for (const role of ROLES) {
    await roleTrustRepo.upsertTrust(db, {
      companyId: dbCompanyId,
      role,
      band: "standard",
      rollingPassRate: "0.500",
      beatsInBand: 0,
      lastVerdictAt: NOW_DATE,
    });
  }
  return ROLES.length;
}

async function seedSprint(): Promise<void> {
  const db = getDb();
  await sprintsRepo.upsertSprint(db, {
    id: "spr_seed_1",
    companyId: COMPANY_ID,
    strategyId: "strategy_seed_canonical",
    number: 1,
    title: "Seed Sprint 1",
    goal: "exercise every dual-write and explain-audit hot path",
    status: "executing",
    plannedByAgentId: "agent_ceo_seed",
    summary: "fixture sprint",
    reviewState: null,
    createdAt: NOW_ISO,
    startedAt: NOW_ISO,
    completedAt: null,
  });
}

async function seedTasks(): Promise<number> {
  const db = getDb();
  // 10 tasks spread across all 8 valid Zod statuses + variety. Status
  // and kind both come from contracts source-of-truth so the seed
  // doesn't drift from the CHECK constraints in 0010.
  const tasks: {
    suffix: string; status: "created" | "planned" | "in_progress" | "verifying" | "blocked" | "completed" | "failed" | "cancelled";
    kind: string; role: Role;
  }[] = [
    { suffix: "01", status: "created",     kind: "implementation",     role: "developer" },
    { suffix: "02", status: "planned",     kind: "technical_plan",     role: "cto" },
    { suffix: "03", status: "in_progress", kind: "implementation",     role: "developer" },
    { suffix: "04", status: "in_progress", kind: "qa_verification",    role: "tester" },
    { suffix: "05", status: "verifying",   kind: "design_direction",   role: "ui_designer" },
    { suffix: "06", status: "blocked",     kind: "service_validation", role: "tester" },
    { suffix: "07", status: "completed",   kind: "acceptance_spec",    role: "pm" },
    { suffix: "08", status: "completed",   kind: "launch_content",     role: "marketing" },
    { suffix: "09", status: "failed",      kind: "bug_fix",            role: "developer" },
    { suffix: "10", status: "cancelled",   kind: "skill_authoring",    role: "skills_lead" },
  ];
  for (const t of tasks) {
    await tasksRepo.upsertTask(db, {
      id: `tsk_seed_${t.suffix}`,
      companyId: COMPANY_ID,
      sprintId: "spr_seed_1",
      assignedRole: t.role,
      title: `Seed task ${t.suffix}`,
      description: `Status=${t.status}, kind=${t.kind}`,
      kind: t.kind as never,
      status: t.status,
      priority: "medium",
      dependsOnTaskIds: [],
      relatedTaskIds: [],
      childTaskIds: [],
      artifactIds: [],
      progress: [],
      planSteps: [],
      acceptance: [],
      evidence: null,
      sourceArtifactId: null,
      checkoutRunId: null,
      executionRunId: null,
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      blockedReason: null,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    } as never);
  }
  return tasks.length;
}

async function seedArtifacts(): Promise<number> {
  const db = getDb();
  const kinds = ["specification", "implementation", "qa_report", "launch_asset", "meeting_note"] as const;
  for (let i = 0; i < kinds.length; i += 1) {
    await artifactsRepo.upsertArtifact(db, {
      id: `art_seed_${i + 1}`,
      companyId: COMPANY_ID,
      sprintId: "spr_seed_1",
      taskId: `tsk_seed_0${i + 1}`,
      agentId: `agent_${ROLES[i % ROLES.length]}_seed`,
      kind: kinds[i],
      title: `Seed artifact ${i + 1}`,
      summary: `Fixture ${kinds[i]}`,
      location: `seed/artifact-${i + 1}.md`,
      contentType: "text/markdown",
      metadata: { seedIndex: i + 1 },
      createdAt: NOW_ISO,
    });
  }
  return kinds.length;
}

async function seedMeetings(): Promise<number> {
  const db = getDb();
  const fixtures = [
    { id: "mtg_seed_daily", type: "daily_sync", status: "completed" },
    { id: "mtg_seed_decision", type: "decision", status: "scheduled" },
  ] as const;
  for (const m of fixtures) {
    await meetingsRepo.upsertMeeting(db, {
      id: m.id,
      companyId: COMPANY_ID,
      scheduleId: null,
      type: m.type as never,
      title: `Seed ${m.type}`,
      status: m.status,
      facilitatorAgentId: "agent_ceo_seed",
      participantAgentIds: ["agent_ceo_seed", "agent_cto_seed"],
      contributions: [],
      synthesis: null,
      resolutions: null,
      brief: null,
      healthSnapshot: null,
      createdAt: NOW_ISO,
      completedAt: m.status === "completed" ? NOW_ISO : null,
    });
  }
  return fixtures.length;
}

async function seedApproval(): Promise<number> {
  const db = getDb();
  await approvalsRepo.upsertApproval(db, {
    id: "appr_seed_1",
    companyId: COMPANY_ID,
    type: "strategy",
    status: "pending",
    title: "Seed approval — strategy proposal",
    description: "Fixture pending approval for explain-audit testing",
    requestedByAgentId: "agent_ceo_seed",
    meetingId: null,
    agendaItemId: null,
    resolutionSummary: null,
  });
  return 1;
}

async function seedSkillArtifactsAndUsage(): Promise<{ skills: number; events: number }> {
  const db = getDb();
  const dbCompanyId = companiesRepo.toDbId(COMPANY_ID);
  const skillSpecs = [
    { friendlyId: "sk_orchestrate_meeting", role: "ceo" as Role },
    { friendlyId: "sk_decompose_task", role: "cto" as Role },
    { friendlyId: "sk_write_acceptance_criteria", role: "pm" as Role },
    { friendlyId: "sk_implement_feature", role: "developer" as Role },
    { friendlyId: "sk_run_qa", role: "tester" as Role },
  ];

  let eventsTotal = 0;
  for (const spec of skillSpecs) {
    const skill = await skillArtifactsRepo.upsertSkillArtifact(db, {
      friendlyId: spec.friendlyId,
      companyId: COMPANY_ID,
      companyDbId: dbCompanyId,
      name: spec.friendlyId,
      slug: spec.friendlyId,
      role: spec.role,
      triggerCondition: `seed trigger for ${spec.friendlyId}`,
      description: "fixture",
      content: "# Seed skill",
      successRate: 0.65,
      usageCount: 10,
      status: "active",
      version: 1,
    });
    // 10 usage events per skill — alternating outcomes to seed a
    // realistic EMA distribution (7 pass, 3 fail).
    const dbAgentId = await agentsRepo.resolveAgentDbId(db, dbCompanyId, spec.role);
    for (let i = 0; i < 10; i += 1) {
      const outcomeScore = i % 3 === 0 ? 0 : 1;
      await skillUsageEventsRepo.recordUsageEvent(db, {
        companyId: dbCompanyId,
        skillId: skill.id,
        beatId: null,
        agentId: dbAgentId,
        outcomeScore,
        occurredAt: new Date(NOW_DATE.getTime() - (10 - i) * 60_000),
      });
      eventsTotal += 1;
    }
  }
  return { skills: skillSpecs.length, events: eventsTotal };
}

async function seedHeartbeatRuns(): Promise<number> {
  const db = getDb();
  const dbCompanyId = companiesRepo.toDbId(COMPANY_ID);
  // Cycle across the 8 agents — 12 runs each plus a few extras to hit 100.
  // Mix of completed/failed/stranded states for realistic plan auditing.
  const total = 100;
  for (let i = 0; i < total; i += 1) {
    const role = ROLES[i % ROLES.length];
    const dbAgentId = await agentsRepo.resolveAgentDbId(db, dbCompanyId, role);
    if (!dbAgentId) continue;
    const startedAt = new Date(NOW_DATE.getTime() - (total - i) * 60_000);
    const status = i % 10 === 0 ? "failed" : i % 25 === 0 ? "stranded" : "completed";
    const verdictOutcome = status === "completed" ? "pass" : "fail";
    await heartbeatRunsRepo.startRun(db, {
      companyId: dbCompanyId,
      agentId: dbAgentId,
      beatNumber: i + 1,
      trigger: "scheduled",
      triggerDetail: { friendlyBeatId: `beat_seed_${i + 1}` },
      status,
      sessionId: `session_seed_${i + 1}`,
      trustBand: "standard",
      verdictScore: status === "completed" ? 1 : 0,
      verdictOutcome,
      totalTokens: 100 + (i * 7) % 500,
      startedAt,
      finishedAt: status === "stranded" ? null : new Date(startedAt.getTime() + 30_000),
      processStartedAt: startedAt,
    });
  }
  return total;
}


export async function seedCanonical(): Promise<SeedResult> {
  console.log(`[seed] resetting canonical company ${COMPANY_ID} …`);
  await deleteCanonical();

  console.log("[seed] companies → agents → role_trust → sprints → tasks → artifacts → meetings → approvals → skills → heartbeat_runs");
  await seedCompany();
  const agents = await seedAgents();
  const roleTrust = await seedRoleTrust();
  await seedSprint();
  const tasks = await seedTasks();
  const artifacts = await seedArtifacts();
  const meetings = await seedMeetings();
  const approvals = await seedApproval();
  const { skills, events } = await seedSkillArtifactsAndUsage();
  const heartbeatRuns = await seedHeartbeatRuns();

  const result: SeedResult = {
    companyId: COMPANY_ID,
    agents,
    sprints: 1,
    tasks,
    artifacts,
    meetings,
    approvals,
    skillArtifacts: skills,
    skillUsageEvents: events,
    heartbeatRuns,
    roleTrust,
  };

  console.log("[seed] done.", result);
  return result;
}

export const CANONICAL_COMPANY_ID = COMPANY_ID;

// CLI entrypoint — works in Bun (import.meta.main) and Node.js/tsx (argv check)
const _isMain = (import.meta as { main?: boolean }).main
  ?? resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "");

if (_isMain) {
  seedCanonical()
    .then((result) => {
      console.log("[seed] done.", result);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[seed] FAIL:", err);
      process.exit(1);
    });
}
