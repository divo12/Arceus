/**
 * Spec 29 Phase A.3 — Atomic skill revision writer.
 *
 * Writes a new revision in three coordinated steps (file, git commit, db row,
 * git tag). Any failure rolls the prior steps back so we never end up with an
 * orphan tag / orphan row / dirty working tree.
 *
 * NOT used directly by agents — called by the Track B `skill_register`,
 * `skill_update`, `skill_deprecate` MCP tools (Phase C). No LLM in this path.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { getDb } from "@arceus/db";
import { skillRevisions } from "@arceus/db";
import { and, eq, desc } from "drizzle-orm";
import {
  GitError,
  gitCommitFiles,
  gitTag,
  gitDeleteTag,
  gitResetHard,
  gitHeadSha,
  getRepoRoot,
} from "./git.js";
import { swallowAndAudit, swallowAndReport } from "../observability/swallow.js";

export type RevisionIntent = "register" | "update" | "deprecate";

export interface WriteRevisionArgs {
  /** uuid — skill_artifacts.id (FK target). */
  skillArtifactId: string;
  /** Stable slug used for filesystem path and git tag (e.g. "code-reviewer"). */
  skillSlug: string;
  /** Full SKILL.md body. Ignored when intent === "deprecate". */
  content: string;
  intent: RevisionIntent;
  /** Session id, "manual", "seed", or worker id. */
  appliedBy: string;
  /** Track C job id when this revision came from the orchestrator. */
  proposalId?: string;
  /** Tag we're rolling back to — informational only, recorded for audit. */
  rollbackFromTag?: string;
  /** Commit message + revisions.summary (≤ 280 chars). */
  summary: string;
  /** Spec 29 Phase G.3 — record EMA at apply-time for the rollback monitor's
   *  baseline. Embedded as `[ema=N.NN]` at the end of `summary`. */
  emaAtApply?: number;
  /** Override repo root (tests). */
  cwd?: string;
}

export interface WriteRevisionResult {
  revisionId: string;
  revisionNumber: number;
  gitTag: string;
  gitSha: string;
}

const SEED_DIR = ".arceus/skills-seed";

function relSkillPath(slug: string): string {
  return `${SEED_DIR}/${slug}/SKILL.md`;
}

function gitTagFor(intent: RevisionIntent, slug: string, revisionNumber: number): string {
  if (intent === "deprecate") return `skill-deprecated/${slug}`;
  return `skill-evolve/${slug}/${revisionNumber}`;
}

/** Phase G.3 — append `[ema=N.NN]` to a summary, capped at 280 chars total. */
function embedEmaInSummaryLocal(summary: string, ema: number): string {
  const tag = ` [ema=${ema.toFixed(2)}]`;
  const max = 280;
  if (summary.length + tag.length <= max) return summary + tag;
  const room = max - tag.length;
  return summary.slice(0, Math.max(0, room - 1)).trimEnd() + tag;
}

/**
 * Writes a revision atomically. On success returns the persisted row info.
 * On failure throws and guarantees no orphan side-effects.
 */
export async function writeRevisionAtomic(
  args: WriteRevisionArgs,
): Promise<WriteRevisionResult> {
  if (args.summary.length > 280) {
    throw new RangeError("summary must be ≤ 280 chars");
  }
  // Phase G.3 — embed `[ema=N.NN]` for the rollback monitor.
  const summary = typeof args.emaAtApply === "number" && Number.isFinite(args.emaAtApply)
    ? embedEmaInSummaryLocal(args.summary, args.emaAtApply)
    : args.summary;
  args = { ...args, summary };

  const cwd = args.cwd ?? getRepoRoot();
  const db = getDb();

  // Step 1 — compute next revision number from DB
  const latest = await db
    .select({ n: skillRevisions.revisionNumber })
    .from(skillRevisions)
    .where(eq(skillRevisions.skillId, args.skillArtifactId))
    .orderBy(desc(skillRevisions.revisionNumber))
    .limit(1);
  const revisionNumber = (latest[0]?.n ?? 0) + 1;
  const gitTagName = gitTagFor(args.intent, args.skillSlug, revisionNumber);

  // For deprecate: no file write, but still tag the current HEAD so audit
  // history shows when deprecation happened. Skip commit too.
  if (args.intent === "deprecate") {
    const sha = await gitHeadSha({ cwd });
    let inserted: { id: string } | null = null;
    try {
      const [row] = await db
        .insert(skillRevisions)
        .values({
          skillId: args.skillArtifactId,
          revisionNumber,
          gitTag: gitTagName,
          gitSha: sha,
          appliedBy: args.appliedBy,
          proposalId: args.proposalId,
          rollbackFromTag: args.rollbackFromTag,
          summary: args.summary,
        })
        .returning({ id: skillRevisions.id });
      inserted = row;

      await gitTag({ tag: gitTagName, sha, message: args.summary, cwd });

      return { revisionId: row.id, revisionNumber, gitTag: gitTagName, gitSha: sha };
    } catch (err) {
      if (inserted) {
        await swallowAndReport("skill.revision.rollback_db_deprecate", () =>
          db.delete(skillRevisions).where(eq(skillRevisions.id, inserted!.id)).then(() => undefined),
        { agentRole: "skills_lead", detail: { revisionId: inserted.id, intent: "deprecate" } });
      }
      throw err;
    }
  }

  // Register / update path: file write → commit → DB insert → tag
  const relPath = relSkillPath(args.skillSlug);
  const absPath = path.join(cwd, relPath);

  // Capture prior state for rollback
  let priorContent: string | null = null;
  try {
    priorContent = await fs.readFile(absPath, "utf8");
  } catch {
    priorContent = null; // file did not exist
  }
  const priorHead = await gitHeadSha({ cwd });

  // Step 2 — write file
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, args.content, "utf8");

  // Step 3 — commit
  let commitSha: string | null = null;
  try {
    const { sha } = await gitCommitFiles({ paths: [relPath], message: args.summary, cwd });
    commitSha = sha;
  } catch (err) {
    // restore file & abort — no commit was made (or it failed mid-way)
    await restoreFile(absPath, priorContent);
    // safety: if HEAD moved unexpectedly, hard-reset
    const head = await swallowAndReport("skill.revision.head_probe", () => gitHeadSha({ cwd }),
      { agentRole: "skills_lead", detail: { phase: "post_commit_rollback" } }) ?? priorHead;
    if (head !== priorHead) {
      await swallowAndReport("skill.revision.reset_post_commit_fail", () =>
        gitResetHard({ ref: priorHead, cwd }).then(() => undefined),
      { agentRole: "skills_lead", detail: { priorHead, observedHead: head } });
    }
    throw err;
  }

  // Step 4 — DB insert (UNIQUE on git_tag is the idempotency anchor)
  let revisionId: string;
  try {
    const [row] = await db
      .insert(skillRevisions)
      .values({
        skillId: args.skillArtifactId,
        revisionNumber,
        gitTag: gitTagName,
        gitSha: commitSha,
        appliedBy: args.appliedBy,
        proposalId: args.proposalId,
        rollbackFromTag: args.rollbackFromTag,
        summary: args.summary,
      })
      .returning({ id: skillRevisions.id });
    revisionId = row.id;
  } catch (err) {
    // roll the commit back and restore the file
    await swallowAndReport("skill.revision.reset_post_db_fail", () =>
      gitResetHard({ ref: priorHead, cwd }).then(() => undefined),
    { agentRole: "skills_lead", detail: { priorHead, phase: "post_db_insert_rollback" } });
    await restoreFile(absPath, priorContent);
    throw err;
  }

  // Step 5 — git tag (last step — if this fails we undo DB + commit)
  try {
    await gitTag({ tag: gitTagName, sha: commitSha, message: args.summary, cwd });
  } catch (err) {
    await swallowAndReport("skill.revision.rollback_db_post_tag_fail", () =>
      db.delete(skillRevisions).where(eq(skillRevisions.id, revisionId)).then(() => undefined),
    { agentRole: "skills_lead", detail: { revisionId, gitTagName } });
    await swallowAndReport("skill.revision.delete_tag_partial", () =>
      gitDeleteTag({ tag: gitTagName, cwd }).then(() => undefined),
    { agentRole: "skills_lead", detail: { gitTagName } });
    await swallowAndReport("skill.revision.reset_post_tag_fail", () =>
      gitResetHard({ ref: priorHead, cwd }).then(() => undefined),
    { agentRole: "skills_lead", detail: { priorHead, gitTagName } });
    await restoreFile(absPath, priorContent);
    throw err;
  }

  return {
    revisionId,
    revisionNumber,
    gitTag: gitTagName,
    gitSha: commitSha,
  };
}

async function restoreFile(absPath: string, priorContent: string | null): Promise<void> {
  if (priorContent === null) {
    await fs.rm(absPath, { force: true });
  } else {
    await fs.writeFile(absPath, priorContent, "utf8");
  }
}

// `and` import kept for future filtered queries; silence unused-import lint.
void and;
