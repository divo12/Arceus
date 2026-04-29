/**
 * Spec 29 Phase F — ATA pipeline orchestrator.
 *
 * Composes the 8 primitives wired by `initSkillEvolution()`:
 *   analyzeFailure → propose{Mutation|Discovery} → generateTestScenarios
 *   → executeDryRun (per scenario) → reviewResults → [reviseSkill] → synthesizeSkill
 *
 * The primitives themselves live in `apps/api/src/skills/evolution.ts`,
 * wired via `setSkillMutatorDeps` / `setSkillTesterDeps` / `setPatternLearnerDeps`.
 * The orchestrator pulls them via the new `getSkill*Deps()` getters and is
 * itself just composition — no LLM calls of its own.
 *
 * Output on accept:
 *   1 handoff artifact (kind="plan") + 1 task assigned to skills_lead
 *   (kind="skill_apply_proposal"). The SL reviews and triggers the
 *   write-side MCP tools (skill_register / skill_update) with a
 *   sl_apply_skill_revision action prefix from their checklist.
 */
import {
  getSkillMutatorDeps,
  getSkillTesterDeps,
  getPatternLearnerDeps,
  type TaskOutcomeContext,
} from "@arceus/company-runtime";
import type {
  FailureAttribution,
  SkillArtifact,
  SkillMutation,
  SkillCandidate,
  ATATestScenario,
  ATADryRunResult,
} from "@arceus/contracts";
import { getDb, skillArtifacts as skillArtifactsTable } from "@arceus/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addArtifactSync, attachArtifactToTask } from "../tasks/mutations.js";
import { upsertTask } from "../persistence/mutations.js";
import { gitShowFileAtTag } from "./git.js";
import type { Task } from "@arceus/contracts";
import type { SkillEvolveJob } from "@arceus/db/src/repos/skill_evolve_jobs.js";

const MAX_REVISION_CYCLES = 2;

export type PipelineStatus = "accepted" | "rejected" | "skipped" | "stubbed" | "rollback_proposed";

export interface PipelineResult {
  status: PipelineStatus;
  proposalId?: string;
  artifactId?: string;
  taskId?: string;
  reason?: string;
  audit?: Record<string, unknown>;
}

interface JobPayload {
  taskOutcome?: Partial<TaskOutcomeContext> & { failureSummary?: string };
  role?: string;
  /** SkillCandidate-shaped payload for trigger="cron" / "candidate". */
  candidate?: SkillCandidate;
  /** Free-form context summary used when the job carries no task outcome. */
  contextSummary?: string;
}

/** Load and shape a `skill_artifacts` row into the in-memory `SkillArtifact` type. */
async function loadSkillArtifact(skillId: string): Promise<SkillArtifact | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(skillArtifactsTable)
    .where(eq(skillArtifactsTable.id, skillId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    role: row.role,
    version: row.version,
    status: row.status as SkillArtifact["status"],
    trigger: row.triggerCondition,
    content: row.content,
    testCases: [],
    successRate: Number(row.successRate),
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    mutatedFromId: null,
    mutatedBy: null,
    mutationReason: null,
    createdAt: row.createdAt.toISOString(),
    approvedAt: null,
    resources: [],
  };
}

function shapeTaskOutcomeContext(job: SkillEvolveJob, payload: JobPayload): TaskOutcomeContext {
  const t = payload.taskOutcome ?? {};
  return {
    taskId: t.taskId ?? `evolve-${job.id}`,
    taskTitle: t.taskTitle ?? `skill_evolve_job:${job.trigger}`,
    taskDescription: t.taskDescription ?? payload.contextSummary ?? "",
    assignedRole: t.assignedRole ?? payload.role ?? "developer",
    companyId: t.companyId ?? job.companyId,
    status: (t.status!) ?? "failed",
    iterationCount: t.iterationCount ?? 3,
    executionTrace: t.executionTrace ?? payload.taskOutcome?.failureSummary ?? "",
  };
}

function buildAttribution(
  ctx: TaskOutcomeContext,
  raw: Awaited<ReturnType<ReturnType<typeof getSkillMutatorDeps>["analyzeFailure"]>>,
): FailureAttribution {
  return {
    taskId: ctx.taskId,
    outcome: ctx.status === "failed" ? "failed" : "high_friction",
    attributedSkillId: raw.attributedSkillId,
    failureMode: raw.failureMode,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    suggestedFix: raw.suggestedFix,
    isSkillGap: raw.isSkillGap,
    createdAt: new Date().toISOString(),
  };
}

function wrapAsMutation(args: {
  companyId: string;
  originalSkill: SkillArtifact | null;
  proposal: { content: string; trigger: string; description: string; name?: string };
  attribution: FailureAttribution | null;
  reason: string;
  proposedBy: string;
  role: string;
}): SkillMutation {
  const now = new Date().toISOString();
  const proposed: SkillArtifact = args.originalSkill
    ? {
        ...args.originalSkill,
        version: args.originalSkill.version + 1,
        content: args.proposal.content,
        trigger: args.proposal.trigger,
        status: "active",
      }
    : {
        id: `skl_${randomUUID().slice(0, 10)}`,
        companyId: args.companyId,
        name: args.proposal.name ?? args.proposal.description.slice(0, 80),
        role: args.role,
        version: 1,
        status: "active",
        trigger: args.proposal.trigger,
        content: args.proposal.content,
        testCases: [],
        successRate: 0.5,
        usageCount: 0,
        lastUsedAt: null,
        mutatedFromId: null,
        mutatedBy: args.proposedBy,
        mutationReason: args.reason,
        createdAt: now,
        approvedAt: null,
        resources: [],
      };
  return {
    id: `mut_${randomUUID().slice(0, 10)}`,
    companyId: args.companyId,
    originalSkillId: args.originalSkill?.id ?? null,
    proposedSkill: proposed,
    reason: args.reason,
    failureTraceId: args.attribution?.taskId ?? null,
    status: "proposed",
    revisionCycle: 0,
    testResults: [],
    reviewFeedback: null,
    proposedBy: args.proposedBy,
    proposedAt: now,
    resolvedAt: null,
  };
}

async function runDryRunSequential(
  scenarios: ATATestScenario[],
  skill: SkillArtifact,
): Promise<ATADryRunResult[]> {
  const tester = getSkillTesterDeps();
  const out: ATADryRunResult[] = [];
  for (const scenario of scenarios) {
    out.push(await tester.executeDryRun(skill, scenario));
  }
  return out;
}

function buildHandoffPayload(args: {
  job: SkillEvolveJob;
  mutation: SkillMutation;
  attribution: FailureAttribution | null;
  scenarios: ATATestScenario[];
  results: ATADryRunResult[];
  verdict: { gate: string; overallScore: number; revisionGuidance?: string | null };
  finalContent: string;
  synthesis: { name: string; trigger: string; content: string; description: string };
}): string {
  const lines: string[] = [];
  lines.push(`# Skill apply proposal: ${args.synthesis.name}`);
  lines.push("");
  lines.push(`- Job: ${args.job.id} (${args.job.trigger})`);
  lines.push(`- Target skill: ${args.job.targetSkillId ?? "<new>"}`);
  lines.push(`- Verdict gate: ${args.verdict.gate} (score=${args.verdict.overallScore})`);
  lines.push(`- Revision cycles: ${args.mutation.revisionCycle}`);
  if (args.attribution) {
    lines.push(`- Failure mode: ${args.attribution.failureMode} (conf=${args.attribution.confidence})`);
    lines.push(`- Suggested fix: ${args.attribution.suggestedFix}`);
  }
  lines.push("");
  lines.push("## Proposed SKILL.md");
  lines.push("");
  lines.push("```markdown");
  lines.push(args.finalContent);
  lines.push("```");
  lines.push("");
  lines.push("## Test scenarios");
  for (const [i, s] of args.scenarios.entries()) {
    const r = args.results[i];
    const passed = r ? r.outcomeMatches.every(Boolean) && r.edgeCaseMatches.every(Boolean) : false;
    lines.push(`- **${s.scenario}** → ${passed ? "PASS" : "FAIL"}`);
  }
  if (args.verdict.revisionGuidance) {
    lines.push("");
    lines.push("## Reviewer guidance");
    lines.push(args.verdict.revisionGuidance);
  }
  return lines.join("\n");
}

async function createApplyProposalTask(args: {
  companyId: string;
  artifactId: string;
  summary: string;
  jobId: string;
  targetSkillId: string | null;
}): Promise<string> {
  const taskId = `tsk_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const task: Task = {
    id: taskId,
    companyId: args.companyId,
    sprintId: null,
    kind: "skill_apply_proposal" as Task["kind"],
    title: `Apply skill revision (job ${args.jobId})`,
    description: args.summary,
    problemStatement: args.summary,
    deliverable: "Apply or reject the proposed SKILL.md via skill_register / skill_update.",
    definitionOfDone: [
      "Reviewed the proposed SKILL.md.",
      "Either applied via skill_register/skill_update OR rejected with reasoning.",
    ],
    status: "created",
    priority: "medium",
    assignedRole: "skills_lead",
    assignedAgentId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: args.summary, planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [args.artifactId],
    createdAt: now,
  };
  await upsertTask(task);
  await attachArtifactToTask(taskId, args.artifactId);
  return taskId;
}

/**
 * Run the full ATA pipeline for one queued job.
 *
 * Returns terminal status (`accepted` / `rejected` / `skipped`). Throws on
 * unexpected infrastructure errors so the scheduler can call `failJob`.
 */
export async function runATAPipeline(job: SkillEvolveJob): Promise<PipelineResult> {
  if (job.trigger === "rollback") {
    return runRollbackShortCircuit(job);
  }

  const payload = (job.payload ?? {}) as JobPayload;
  const mutator = getSkillMutatorDeps();
  const tester = getSkillTesterDeps();
  const patternLearner = getPatternLearnerDeps();

  // ── 1. Analyze failure (or stand in a stub when no task outcome present)
  const ctx = shapeTaskOutcomeContext(job, payload);
  const original = job.targetSkillId ? await loadSkillArtifact(job.targetSkillId) : null;
  const matched = original ? [original] : [];
  const rawAttribution = await mutator.analyzeFailure(ctx, matched);
  const attribution = buildAttribution(ctx, rawAttribution);

  // ── 2. Propose mutation (existing skill) OR discovery (new skill)
  let proposal: { content: string; trigger: string; description: string; name?: string };
  if (original) {
    proposal = await mutator.proposeSkillMutation(original, attribution);
  } else {
    const discovered = await mutator.proposeSkillDiscovery(attribution, ctx.assignedRole);
    proposal = discovered;
  }

  let mutation = wrapAsMutation({
    companyId: job.companyId,
    originalSkill: original,
    proposal,
    attribution,
    reason: attribution.suggestedFix || `Triggered by ${job.trigger}`,
    proposedBy: `evolve-job:${job.id}`,
    role: ctx.assignedRole,
  });

  // ── 3-5. ATA loop: TGA → EAA → ROA (+ optional revise)
  let scenarios: ATATestScenario[] = [];
  let results: ATADryRunResult[] = [];
  let verdict: Awaited<ReturnType<typeof tester.reviewResults>> | null = null;
  let revisionCycles = 0;

  for (;;) {
    scenarios = await tester.generateTestScenarios(mutation);
    results = await runDryRunSequential(scenarios, mutation.proposedSkill);
    verdict = await tester.reviewResults(mutation, scenarios, results);

    if (verdict.verdict === "approve" || verdict.verdict === "reject") break;
    if (revisionCycles >= MAX_REVISION_CYCLES) {
      verdict = { ...verdict, verdict: "reject" };
      break;
    }
    const revised = await tester.reviseSkill(
      mutation,
      verdict.revisionGuidance ?? "Improve the skill to pass all scenarios.",
    );
    mutation = {
      ...mutation,
      revisionCycle: revisionCycles + 1,
      proposedSkill: {
        ...mutation.proposedSkill,
        content: revised.content,
        trigger: revised.trigger || mutation.proposedSkill.trigger,
      },
    };
    revisionCycles++;
  }

  if (!verdict) {
    return { status: "rejected", reason: "no verdict produced" };
  }

  if (verdict.verdict === "reject") {
    return {
      status: "rejected",
      audit: {
        gate: verdict.verdict,
        overallScore: verdict.overallScore,
        revisionGuidance: verdict.revisionGuidance,
        revisionCycles,
      },
    };
  }

  // ── 6. Synthesize final SKILL.md (canonicalize via Pattern Learner primitive)
  const candidate: SkillCandidate = payload.candidate ?? {
    clusterId: `evolve-${job.id}`,
    companyId: job.companyId,
    role: ctx.assignedRole,
    representativeTitle: mutation.proposedSkill.name,
    representativeSummary: proposal.description,
    memberCount: 1,
    combinedUsageCount: 1,
    combinedSuccessRate: mutation.proposedSkill.successRate,
    memberSummaries: [proposal.description],
    proposedAt: new Date().toISOString(),
  };
  let synthesis: { name: string; trigger: string; content: string; description: string };
  try {
    synthesis = await patternLearner.synthesizeSkill(candidate);
  } catch {
    synthesis = {
      name: mutation.proposedSkill.name,
      trigger: mutation.proposedSkill.trigger,
      content: mutation.proposedSkill.content,
      description: proposal.description,
    };
  }

  // ── 7. Create handoff artifact + SL delegation task
  const handoffMd = buildHandoffPayload({
    job,
    mutation,
    attribution,
    scenarios,
    results,
    verdict: { gate: verdict.verdict, overallScore: verdict.overallScore, revisionGuidance: verdict.revisionGuidance },
    finalContent: synthesis.content,
    synthesis,
  });

  const artifact = await addArtifactSync(
    `skill-orchestrator:${job.id}`,
    "plan",
    `Skill apply proposal — ${synthesis.name}`,
    handoffMd,
  );
  const taskId = await createApplyProposalTask({
    companyId: job.companyId,
    artifactId: artifact.id,
    summary: synthesis.description.slice(0, 280),
    jobId: job.id,
    targetSkillId: job.targetSkillId ?? null,
  });

  return {
    status: "accepted",
    proposalId: job.id,
    artifactId: artifact.id,
    taskId,
    audit: { revisionCycles, overallScore: verdict.overallScore },
  };
}

/**
 * Spec 29 Phase H.2 — Rollback short-circuit.
 *
 * Zero LLM calls. Reads the prior revision content from git at `fromTag`,
 * writes one handoff artifact, and creates a `skill_apply_rollback` task
 * for the SL to gate. The SL beat calls `skill_update` with the prior
 * content and `rollbackFromTag`.
 */
async function runRollbackShortCircuit(job: SkillEvolveJob): Promise<PipelineResult> {
  const payload = (job.payload ?? {}) as { fromTag?: string; applied_at?: string };
  const fromTag = payload.fromTag;
  const skillId = job.targetSkillId;
  if (!fromTag || !skillId) {
    return { status: "skipped", reason: "rollback job missing fromTag or targetSkillId" };
  }

  const skill = await loadSkillArtifact(skillId);
  if (!skill) {
    return { status: "skipped", reason: `skill ${skillId} not found` };
  }
  // Slug needed for the seed-tree path. We pull it directly from the
  // skill_artifacts row (loadSkillArtifact does not surface slug yet).
  const db = getDb();
  const slugRow = await db
    .select({ slug: skillArtifactsTable.slug })
    .from(skillArtifactsTable)
    .where(eq(skillArtifactsTable.id, skillId))
    .limit(1);
  const slug = slugRow[0]?.slug;
  if (!slug) {
    return { status: "skipped", reason: `slug for skill ${skillId} not found` };
  }

  let priorContent: string;
  try {
    priorContent = await gitShowFileAtTag({
      tag: fromTag,
      path: `.arceus/skills-seed/${slug}/SKILL.md`,
    });
  } catch (err) {
    return {
      status: "skipped",
      reason: `git show failed for ${fromTag}: ${err instanceof Error ? err.message : err}`,
    };
  }

  const summary = `Rollback ${slug} → ${fromTag} after EMA regression.`;
  const md = [
    `# Rollback proposal: ${skill.name}`,
    "",
    `- Job: ${job.id} (rollback)`,
    `- Skill: ${skillId} (${slug})`,
    `- Revert to tag: ${fromTag}`,
    payload.applied_at ? `- Bad revision applied at: ${payload.applied_at}` : "",
    "",
    "## Prior SKILL.md (target)",
    "",
    "```markdown",
    priorContent,
    "```",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  const artifact = await addArtifactSync(
    `skill-orchestrator:${job.id}`,
    "plan",
    `Skill rollback proposal — ${slug}`,
    md,
  );

  const taskId = `tsk_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const task: Task = {
    id: taskId,
    companyId: job.companyId,
    sprintId: null,
    kind: "skill_apply_rollback" as Task["kind"],
    title: `Rollback skill ${slug} to ${fromTag}`,
    description: summary,
    problemStatement: summary,
    deliverable: `Apply rollback via skill_update with rollbackFromTag="${fromTag}".`,
    definitionOfDone: [
      "Reviewed the prior SKILL.md content.",
      `Applied via skill_update with content from ${fromTag} OR rejected with reasoning.`,
    ],
    status: "created",
    priority: "high",
    assignedRole: "skills_lead",
    assignedAgentId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: summary, planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [artifact.id],
    createdAt: now,
  };
  await upsertTask(task);
  await attachArtifactToTask(taskId, artifact.id);

  return {
    status: "rollback_proposed",
    proposalId: job.id,
    artifactId: artifact.id,
    taskId,
    audit: { fromTag, slug },
  };
}