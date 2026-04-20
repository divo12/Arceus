/**
 * Spec 14 – Phase 5: Pattern Learning → Skill Formation (Pure Logic Layer)
 *
 * Recurring task patterns accumulate into clusters. When a cluster is strong
 * enough (4+ members, high combined success, no matching skill), it becomes a
 * skill candidate and is promoted through the ATA pipeline.
 *
 * Architecture (same DI pattern as skill-mutator / skill-tester):
 *   company-runtime/pattern-learner.ts  → decides WHAT to cluster and WHEN to promote
 *   apps/api/skill-evolution.ts         → provides HOW (embedding + synthesis LLM calls)
 *
 * Data flow:
 *   1. extractPattern(outcome)       → called after every terminal task
 *   2. clusterPatterns(companyId)    → compute clusters via cosine similarity
 *   3. checkSkillCandidates(...)     → find clusters ready for promotion
 *   4. proposeSkillFromCluster(...)  → synthesize skill, store as mutation, hand to ATA
 */

import type {
  Pattern,
  PatternCluster,
  PatternOutcome,
  SkillArtifact,
  SkillCandidate,
  SkillMutation,
} from "@arceus/contracts";
import { getAllSkills, matchSkills, storeMutation } from "./skill-registry";

// ── Dependency injection ─────────────────────────────────

export interface PatternLearnerDeps {
  /** Produce a deterministic vector embedding for a piece of text. */
  embedText(text: string): Promise<number[]>;

  /** Synthesize a SKILL.md from a skill candidate. */
  synthesizeSkill(candidate: SkillCandidate): Promise<{
    name: string;
    trigger: string;
    content: string;
    description: string;
  }>;
}

let deps: PatternLearnerDeps | null = null;

export function setPatternLearnerDeps(d: PatternLearnerDeps): void {
  deps = d;
}

export function hasPatternLearnerDeps(): boolean {
  return deps !== null;
}

// ── Constants ────────────────────────────────────────────

/** Cosine similarity threshold for clustering (spec §1063). */
const CLUSTER_SIMILARITY_THRESHOLD = 0.7;

/** Minimum cluster size for promotion (spec §1069). */
const MIN_CLUSTER_SIZE_FOR_PROMOTION = 4;

/** Combined success rate required to promote a cluster. */
const MIN_CLUSTER_SUCCESS_RATE = 0.6;

/** Cosine threshold for merging a new trajectory into an existing pattern. */
const PATTERN_MERGE_THRESHOLD = 0.9;

/** EMA learning rate for pattern success_rate updates. */
const SUCCESS_RATE_LR = 0.15;

// ── In-memory store ──────────────────────────────────────

const patternsById = new Map<string, Pattern>();

// ── Task outcome input ───────────────────────────────────

export interface PatternObservation {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  assignedRole: string;
  companyId: string;
  outcome: PatternOutcome;
  /** Optional compressed trajectory text (output summary, tool trace, etc). */
  trajectory?: string;
  /** Skills that were active during the task. */
  activeSkillIds?: string[];
  /** Optional tags for categorization. */
  tags?: string[];
  /** Sprint the source task belongs to (Phase 6 cross-sprint transfer). */
  sprintId?: string | null;
}

// ── Pure helpers ─────────────────────────────────────────

/** Cosine similarity between two equal-length vectors. Returns 0 if either is zero-length. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Compute EMA: new_rate = old * (1 - lr) + outcome * lr. */
export function applyEma(oldRate: number, outcome: number, lr: number = SUCCESS_RATE_LR): number {
  const clampedOutcome = Math.max(0, Math.min(1, outcome));
  return Math.max(0, Math.min(1, oldRate * (1 - lr) + clampedOutcome * lr));
}

/** Convert a task outcome to a numeric score: success=1, high_friction=0.5, failure=0. */
function outcomeToScore(outcome: PatternOutcome): number {
  if (outcome === "success") return 1.0;
  if (outcome === "high_friction") return 0.5;
  return 0.0; // failure
}

/** Build the trajectory text for embedding from title + description + optional trace. */
function buildTrajectoryText(obs: PatternObservation): string {
  return [obs.taskTitle, obs.taskDescription, obs.trajectory ?? ""].filter(Boolean).join("\n");
}

/** Build a human-readable summary describing the task outcome. */
function buildSummary(obs: PatternObservation): string {
  const outcomeLabel = obs.outcome === "success"
    ? "succeeded"
    : obs.outcome === "high_friction" ? "completed with friction" : "failed";
  return `${obs.assignedRole} ${outcomeLabel} on "${obs.taskTitle}"`;
}

// ── extractPattern ───────────────────────────────────────

/**
 * Record a task trajectory as a Pattern.
 *
 * If a near-duplicate pattern already exists (cosine >= PATTERN_MERGE_THRESHOLD,
 * same company + role), merge into it — increment usageCount, update successRate
 * via EMA, and append sourceTaskId.
 *
 * Otherwise create a new pattern.
 *
 * Fire-and-forget: failures are thrown so the orchestrator can catch + log.
 */
export async function extractPattern(obs: PatternObservation): Promise<Pattern> {
  if (!deps) {
    throw new Error("[PatternLearner] deps not configured — call setPatternLearnerDeps() first");
  }

  const trajectoryText = buildTrajectoryText(obs);
  const embedding = await deps.embedText(trajectoryText);
  const outcomeScore = outcomeToScore(obs.outcome);
  const now = new Date().toISOString();

  // Look for a near-duplicate pattern to merge into
  const duplicate = findNearDuplicate(obs.companyId, obs.assignedRole, embedding);
  if (duplicate) {
    const merged: Pattern = {
      ...duplicate,
      usageCount: duplicate.usageCount + 1,
      successRate: applyEma(duplicate.successRate, outcomeScore),
      sourceTaskIds: duplicate.sourceTaskIds.includes(obs.taskId)
        ? duplicate.sourceTaskIds
        : [...duplicate.sourceTaskIds, obs.taskId],
      matchedSkillIds: mergeUnique(duplicate.matchedSkillIds, obs.activeSkillIds ?? []),
      tags: mergeUnique(duplicate.tags, obs.tags ?? []),
      sprintIds: obs.sprintId
        ? mergeUnique(duplicate.sprintIds ?? [], [obs.sprintId])
        : (duplicate.sprintIds ?? []),
      updatedAt: now,
    };
    patternsById.set(merged.id, merged);
    return merged;
  }

  // Create new pattern
  const id = `pattern-${obs.companyId}-${obs.assignedRole}-${Date.now()}-${patternsById.size}`;
  const pattern: Pattern = {
    id,
    companyId: obs.companyId,
    role: obs.assignedRole,
    taskTitle: obs.taskTitle,
    taskDescription: obs.taskDescription,
    summary: buildSummary(obs),
    outcome: obs.outcome,
    embedding,
    usageCount: 1,
    successRate: outcomeScore,
    sourceTaskIds: [obs.taskId],
    matchedSkillIds: [...(obs.activeSkillIds ?? [])],
    tags: [...(obs.tags ?? [])],
    firstSeenSprintId: obs.sprintId ?? null,
    sprintIds: obs.sprintId ? [obs.sprintId] : [],
    createdAt: now,
    updatedAt: now,
  };
  patternsById.set(id, pattern);
  return pattern;
}

/** Find an existing pattern in the same company/role with cosine >= PATTERN_MERGE_THRESHOLD. */
function findNearDuplicate(
  companyId: string,
  role: string,
  embedding: readonly number[],
): Pattern | null {
  let best: { pattern: Pattern; sim: number } | null = null;
  for (const pattern of patternsById.values()) {
    if (pattern.companyId !== companyId || pattern.role !== role) continue;
    const sim = cosineSimilarity(embedding, pattern.embedding);
    if (sim >= PATTERN_MERGE_THRESHOLD && (!best || sim > best.sim)) {
      best = { pattern, sim };
    }
  }
  return best?.pattern ?? null;
}

/** Merge two string arrays into a unique set. */
function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set<string>(a);
  for (const item of b) set.add(item);
  return [...set];
}

// ── clusterPatterns ──────────────────────────────────────

/**
 * Group patterns whose embeddings are mutually similar.
 *
 * Implementation: single-pass greedy agglomerative clustering.
 * Two patterns join the same cluster if cosine >= CLUSTER_SIMILARITY_THRESHOLD
 * against the cluster's *centroid* (running average of member embeddings).
 *
 * Clusters are computed on demand — no storage.
 */
export function clusterPatterns(companyId: string): PatternCluster[] {
  const patterns = getPatternsForCompany(companyId);
  if (patterns.length === 0) return [];

  // Sort by createdAt so clustering is deterministic given same inputs
  const sorted = [...patterns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const clusters: { members: Pattern[]; centroid: number[] }[] = [];

  for (const pattern of sorted) {
    let joined = false;
    for (const cluster of clusters) {
      if (cluster.members[0].role !== pattern.role) continue;
      const sim = cosineSimilarity(pattern.embedding, cluster.centroid);
      if (sim >= CLUSTER_SIMILARITY_THRESHOLD) {
        cluster.members.push(pattern);
        cluster.centroid = updateCentroid(cluster.centroid, cluster.members.length - 1, pattern.embedding);
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({ members: [pattern], centroid: [...pattern.embedding] });
    }
  }

  // Only return clusters with more than 1 member — singletons aren't useful
  const activeSkills = getAllSkills(companyId).filter((s) => s.status === "active");

  return clusters
    .filter((c) => c.members.length >= 2)
    .map((c) => buildClusterArtifact(companyId, c.members, activeSkills));
}

/** Incrementally update a cluster centroid when a new member is added. */
function updateCentroid(centroid: number[], previousSize: number, newVector: readonly number[]): number[] {
  // centroid_new = (centroid * previousSize + newVector) / (previousSize + 1)
  const newSize = previousSize + 1;
  const result = new Array<number>(centroid.length);
  for (let i = 0; i < centroid.length; i++) {
    result[i] = (centroid[i] * previousSize + (newVector[i] ?? 0)) / newSize;
  }
  return result;
}

function buildClusterArtifact(
  companyId: string,
  members: Pattern[],
  activeSkills: SkillArtifact[],
): PatternCluster {
  const dominantRole = members[0].role;
  const combinedUsage = members.reduce((sum, p) => sum + p.usageCount, 0);
  const combinedSuccess = members.reduce((sum, p) => sum + p.successRate * p.usageCount, 0) / (combinedUsage || 1);

  // Match against active skills: if any pattern's matched skills overlap with the
  // cluster's dominant role, we consider the cluster "covered" by that skill.
  const matched = matchSkills(companyId, dominantRole, members.map((m) => m.taskTitle).join(" "));
  const activeMatch = matched.length > 0 ? matched[0] : null;
  const hasMatchingSkill = activeMatch !== null && activeSkills.some((s) => s.id === activeMatch.id);

  const title = members[0].taskTitle.slice(0, 80);
  const summary = summarizeCluster(members);

  return {
    id: `cluster-${companyId}-${dominantRole}-${hashMemberIds(members)}`,
    companyId,
    role: dominantRole,
    patternIds: members.map((m) => m.id),
    representativeTitle: title,
    representativeSummary: summary,
    combinedUsageCount: combinedUsage,
    combinedSuccessRate: Math.max(0, Math.min(1, combinedSuccess)),
    dominantRole,
    hasMatchingSkill,
    matchingSkillId: hasMatchingSkill ? activeMatch?.id ?? null : null,
    createdAt: new Date().toISOString(),
  };
}

function summarizeCluster(members: Pattern[]): string {
  const successCount = members.filter((m) => m.outcome === "success").length;
  return `${members.length} related trajectories (${successCount} successful). Shared intent: "${members[0].taskTitle}".`;
}

function hashMemberIds(members: Pattern[]): string {
  // Deterministic cluster id from member ids — order-independent
  return [...members.map((m) => m.id)].sort().join("|").slice(0, 40);
}

// ── checkSkillCandidates ─────────────────────────────────

/**
 * Find clusters that meet the promotion criteria:
 *   1. At least MIN_CLUSTER_SIZE_FOR_PROMOTION members
 *   2. combinedSuccessRate >= MIN_CLUSTER_SUCCESS_RATE
 *   3. No active skill already covers this cluster
 */
export function checkSkillCandidates(companyId: string): SkillCandidate[] {
  const clusters = clusterPatterns(companyId);
  const now = new Date().toISOString();
  const candidates: SkillCandidate[] = [];

  for (const cluster of clusters) {
    if (cluster.patternIds.length < MIN_CLUSTER_SIZE_FOR_PROMOTION) continue;
    if (cluster.combinedSuccessRate < MIN_CLUSTER_SUCCESS_RATE) continue;
    if (cluster.hasMatchingSkill) continue;

    const memberSummaries = cluster.patternIds
      .map((id) => patternsById.get(id)?.summary)
      .filter((s): s is string => typeof s === "string");

    candidates.push({
      clusterId: cluster.id,
      companyId,
      role: cluster.dominantRole,
      representativeTitle: cluster.representativeTitle,
      representativeSummary: cluster.representativeSummary,
      memberCount: cluster.patternIds.length,
      combinedUsageCount: cluster.combinedUsageCount,
      combinedSuccessRate: cluster.combinedSuccessRate,
      memberSummaries,
      proposedAt: now,
    });
  }

  return candidates;
}

// ── analyzeSprintPatterns (Phase 6 — cross-sprint transfer) ──

/**
 * Spec 14 Phase 6 — narrow candidate search to patterns observed *within*
 * `sprintId` with `usageCount >= minFrequency`. Used at sprint boundary to
 * ship emergent skills to Sprint N+1, rather than the all-time sweep.
 *
 * Differs from checkSkillCandidates:
 *   - Filters patterns by sprintIds containing the target sprint
 *   - Requires `usageCount >= minFrequency` (default 3 per spec §1095)
 *   - Still applies the promotion gate (≥4 members, ≥60% success, no matching skill)
 */
export function analyzeSprintPatterns(
  companyId: string,
  sprintId: string,
  minFrequency: number = 3,
): SkillCandidate[] {
  // Sprint-scoped patterns with sufficient frequency
  const sprintPatterns = getPatternsForCompany(companyId).filter(
    (p) =>
      (p.sprintIds ?? []).includes(sprintId) &&
      p.usageCount >= minFrequency,
  );
  if (sprintPatterns.length === 0) return [];

  // Cluster *only* those patterns
  const sorted = [...sprintPatterns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const clusters: { members: Pattern[]; centroid: number[] }[] = [];

  for (const pattern of sorted) {
    let joined = false;
    for (const cluster of clusters) {
      if (cluster.members[0].role !== pattern.role) continue;
      const sim = cosineSimilarity(pattern.embedding, cluster.centroid);
      if (sim >= CLUSTER_SIMILARITY_THRESHOLD) {
        cluster.members.push(pattern);
        cluster.centroid = updateCentroid(
          cluster.centroid,
          cluster.members.length - 1,
          pattern.embedding,
        );
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({ members: [pattern], centroid: [...pattern.embedding] });
    }
  }

  const activeSkills = getAllSkills(companyId).filter((s) => s.status === "active");
  const now = new Date().toISOString();
  const candidates: SkillCandidate[] = [];

  for (const raw of clusters) {
    // Path A: variety cluster — 4+ different-but-similar patterns in one sprint
    const isVarietyCluster = raw.members.length >= MIN_CLUSTER_SIZE_FOR_PROMOTION;

    // Path B: cross-sprint recurrence — same pattern seen in ≥2 sprints with
    // usageCount ≥ minFrequency. Single pattern repeated across sprint boundaries
    // is the strongest possible signal that a skill is needed.
    const leadMember = raw.members[0]!;
    const isCrossSprintRecurrence =
      (leadMember.sprintIds ?? []).length >= 2 &&
      leadMember.usageCount >= minFrequency;

    if (!isVarietyCluster && !isCrossSprintRecurrence) continue;

    const cluster = buildClusterArtifact(companyId, raw.members, activeSkills);
    if (cluster.combinedSuccessRate < MIN_CLUSTER_SUCCESS_RATE) continue;
    if (cluster.hasMatchingSkill) continue;

    const memberSummaries = cluster.patternIds
      .map((id) => patternsById.get(id)?.summary)
      .filter((s): s is string => typeof s === "string");

    candidates.push({
      clusterId: cluster.id,
      companyId,
      role: cluster.dominantRole,
      representativeTitle: cluster.representativeTitle,
      representativeSummary: cluster.representativeSummary,
      memberCount: cluster.patternIds.length,
      combinedUsageCount: cluster.combinedUsageCount,
      combinedSuccessRate: cluster.combinedSuccessRate,
      memberSummaries,
      proposedAt: now,
    });
  }

  return candidates;
}

// ── proposeSkillFromCluster ──────────────────────────────

/**
 * Synthesize a new skill from a SkillCandidate and hand it to the ATA pipeline
 * as a standard SkillMutation (status="proposed", originalSkillId=null).
 *
 * The caller (sprint boundary handler) is expected to trigger runATAPipeline()
 * on the returned mutation id.
 */
export async function proposeSkillFromCluster(candidate: SkillCandidate): Promise<SkillMutation> {
  if (!deps) {
    throw new Error("[PatternLearner] deps not configured");
  }

  const synthesized = await deps.synthesizeSkill(candidate);
  const skillName = synthesized.name || `emergent-${Date.now()}`;
  const proposedAt = new Date().toISOString();

  const proposedSkill: SkillArtifact = {
    id: `skill-${skillName}-v1`,
    companyId: candidate.companyId,
    name: skillName,
    role: candidate.role,
    version: 1,
    status: "draft",
    trigger: synthesized.description || synthesized.trigger,
    content: synthesized.content,
    testCases: [],
    successRate: candidate.combinedSuccessRate,
    usageCount: 0,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: "pattern_learner",
    mutationReason: `Emergent from ${candidate.memberCount} related patterns (combined success ${candidate.combinedSuccessRate.toFixed(2)})`,
    createdAt: proposedAt,
    approvedAt: null,
  };

  const mutation: SkillMutation = {
    id: `mutation-emergent-${skillName}-${Date.now()}`,
    companyId: candidate.companyId,
    originalSkillId: null,
    proposedSkill,
    reason: `Emergent skill from pattern cluster ${candidate.clusterId}`,
    failureTraceId: candidate.clusterId,
    status: "proposed",
    revisionCycle: 0,
    testResults: [],
    reviewFeedback: null,
    proposedBy: "pattern_learner",
    proposedAt,
    resolvedAt: null,
  };

  storeMutation(mutation);
  return mutation;
}

// ── Query + admin ────────────────────────────────────────

/** Retrieve a single pattern by ID, or null if not found. */
export function getPatternById(id: string): Pattern | null {
  return patternsById.get(id) ?? null;
}

/** Get all patterns for a company, sorted by creation time. */
export function getPatternsForCompany(companyId: string): Pattern[] {
  const results: Pattern[] = [];
  for (const p of patternsById.values()) {
    if (p.companyId === companyId) results.push(p);
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Get the total number of patterns across all companies. */
export function getPatternCount(): number {
  return patternsById.size;
}

/** Clear all patterns from the in-memory store (testing only). */
export function resetPatternStore(): void {
  patternsById.clear();
}
