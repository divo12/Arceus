/**
 * Spec 29 Phase D — One-shot backfill of skill_revisions for seed skills.
 *
 * For each `.arceus/skills-seed/<dir>/`:
 *   1. Look up skill_artifacts by slug = <dir>. Skip with warning if absent.
 *   2. If a skill_revisions row already exists for that skill, skip.
 *   3. Compute latest commit SHA touching <dir>/SKILL.md via `git log`.
 *   4. Insert skill_revisions(revision_number=1, git_tag="skill-evolve/<slug>/1",
 *      git_sha=<sha>, applied_by="seed", summary="seed: initial revision").
 *   5. Create the git tag locally (pointing at HEAD by default).
 *
 * Idempotent: UNIQUE(git_tag) blocks duplicate inserts on re-run, and the git
 * tag is created with `-f` skipped — pre-existing tag is treated as success.
 *
 * Run once per env (staging, prod) BEFORE Phase G triggers go live.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { getDb, skillArtifacts, skillRevisions } from "@arceus/db";
import { eq, and } from "drizzle-orm";
import { gitHeadSha, gitTag, getRepoRoot } from "../apps/api/src/skills/git.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

loadEnv({ path: path.resolve(getRepoRoot(), ".env.local"), override: false });
loadEnv({ path: path.resolve(getRepoRoot(), ".env"), override: false });

const SEED_DIR = ".arceus/skills-seed";

interface BackfillResult {
  slug: string;
  status: "inserted" | "skipped_existing" | "skipped_no_artifact" | "skipped_no_skillmd" | "error";
  detail?: string;
}

async function lastCommitForFile(relPath: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["log", "-1", "--format=%H", "--", relPath], { cwd });
    const sha = stdout.trim();
    return sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

async function tagExists(tag: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["tag", "--list", tag], { cwd });
    return stdout.trim() === tag;
  } catch {
    return false;
  }
}

async function backfillOne(slug: string, cwd: string, useHead: boolean): Promise<BackfillResult> {
  const relPath = `${SEED_DIR}/${slug}/SKILL.md`;
  const absPath = path.join(cwd, relPath);

  try {
    await fs.access(absPath);
  } catch {
    return { slug, status: "skipped_no_skillmd" };
  }

  const db = getDb();

  // Look up artifact by slug (across all companies — seed skills assumed unique
  // per slug; if multiple companies share the same slug we still backfill each).
  const artifacts = await db
    .select({ id: skillArtifacts.id, companyId: skillArtifacts.companyId })
    .from(skillArtifacts)
    .where(eq(skillArtifacts.slug, slug));

  if (artifacts.length === 0) {
    return { slug, status: "skipped_no_artifact", detail: "no skill_artifacts row for slug" };
  }

  const head = await gitHeadSha({ cwd });
  const fileSha = (await lastCommitForFile(relPath, cwd)) ?? head;
  const recordedSha = useHead ? head : fileSha;

  let firstStatus: BackfillResult["status"] | null = null;
  let firstDetail: string | undefined;

  for (const artifact of artifacts) {
    const existing = await db
      .select({ id: skillRevisions.id })
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, artifact.id))
      .limit(1);
    if (existing.length > 0) {
      firstStatus ??= "skipped_existing";
      continue;
    }

    const gitTagName = `skill-evolve/${slug}/1`;

    try {
      await db.insert(skillRevisions).values({
        skillId: artifact.id,
        revisionNumber: 1,
        gitTag: gitTagName,
        gitSha: recordedSha,
        appliedBy: "seed",
        summary: "seed: initial revision",
      });

      // Create the git tag at HEAD if not already present. We do not force —
      // pre-existing tag (e.g. left over from a partial run) is fine.
      if (!(await tagExists(gitTagName, cwd))) {
        try {
          await gitTag({ tag: gitTagName, sha: head, message: "seed: initial revision", cwd });
        } catch (err) {
          // Tag race or existing — continue, DB row is what matters.
          console.warn(`[backfill] tag ${gitTagName} not created: ${err instanceof Error ? err.message : err}`);
        }
      }

      firstStatus = "inserted";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // UNIQUE(git_tag) collision on re-run is expected idempotency.
      if (/duplicate key|unique constraint/i.test(msg)) {
        firstStatus ??= "skipped_existing";
        continue;
      }
      firstStatus = "error";
      firstDetail = msg;
      break;
    }
  }

  return { slug, status: firstStatus ?? "skipped_existing", detail: firstDetail };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const useHead = !args.has("--use-file-sha");
  const cwd = getRepoRoot();
  const seedRoot = path.join(cwd, SEED_DIR);

  let entries: string[];
  try {
    entries = await fs.readdir(seedRoot);
  } catch (err) {
    console.error(`[backfill] cannot read ${seedRoot}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const results: BackfillResult[] = [];
  for (const name of entries.sort()) {
    const stat = await fs.stat(path.join(seedRoot, name)).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const result = await backfillOne(name, cwd, useHead);
    results.push(result);
    const tag = result.detail ? ` (${result.detail})` : "";
    console.log(`[backfill] ${name}: ${result.status}${tag}`);
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\n[backfill] summary:", counts);

  if (counts.error) process.exit(2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
