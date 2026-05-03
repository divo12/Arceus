/**
 * Spec 29 Phase A.3 — Tests for writeRevisionAtomic.
 *
 * Skipped automatically when no DB env var is set. When run with a configured
 * Postgres URL, exercises:
 *   1. happy-path register (file + commit + row + tag)
 *   2. update increments revision number
 *   3. tag-collision (simulated) rolls back commit + DB row + file
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { companies, skillArtifacts, skillRevisions } from "@arceus/db";
import { eq, sql } from "drizzle-orm";
import { writeRevisionAtomic } from "./revisions.js";
import { gitTag, gitListTagsMatching } from "./git.js";

const execFileAsync = promisify(execFile);

async function checkSpec31SchemaApplied(): Promise<boolean> {
  if (!isDatabaseConfigured()) return false;
  try {
    await getDb().execute(sql`SELECT 1 FROM companies LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

const schemaReady = await checkSpec31SchemaApplied();
const skipIfNoDb = { skip: !schemaReady && "Spec 31 normalized schema not applied to test DB — skipping" };

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spec29-rev-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README"), "init\n");
  await execFileAsync("git", ["add", "README"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

interface Fixture {
  companyId: string;
  skillId: string;
}

async function seedSkillArtifact(slug: string): Promise<Fixture> {
  const db = getDb();
  const companyId = randomUUID();
  const skillId = randomUUID();
  const tag = randomUUID().slice(0, 6);
  await db.insert(companies).values({
    id: companyId,
    name: `spec29-test-${tag}`,
    slug: `spec29-test-${tag}`,
    boardOwnerEmail: "test@example.com",
    taskPrefix: `T${tag.toUpperCase()}`,
  } as never);
  await db.insert(skillArtifacts).values({
    id: skillId,
    companyId,
    slug,
    role: "developer",
    name: slug,
    description: "test fixture",
    triggerCondition: "trigger",
    content: "stub",
  } as never);
  return { companyId, skillId };
}

async function cleanupArtifact(fx: Fixture): Promise<void> {
  const db = getDb();
  await db.delete(skillRevisions).where(eq(skillRevisions.skillId, fx.skillId));
  await db.delete(skillArtifacts).where(eq(skillArtifacts.id, fx.skillId));
  await db.delete(companies).where(eq(companies.id, fx.companyId));
}

test("writeRevisionAtomic — happy path register", skipIfNoDb, async () => {
  const cwd = await makeTempRepo();
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const fx = await seedSkillArtifact(slug);
  try {
    const result = await writeRevisionAtomic({
      skillArtifactId: fx.skillId,
      skillSlug: slug,
      content: "# v1\n",
      intent: "register",
      appliedBy: "test",
      summary: "register v1",
      cwd,
    });
    assert.equal(result.revisionNumber, 1);
    assert.equal(result.gitTag, `skill-evolve/${slug}/1`);
    assert.match(result.gitSha, /^[0-9a-f]{40}$/);

    // file exists
    const written = await readFile(join(cwd, ".arceus/skills-seed", slug, "SKILL.md"), "utf8");
    assert.equal(written, "# v1\n");

    // tag exists
    const tags = await gitListTagsMatching({ pattern: `skill-evolve/${slug}/*`, cwd });
    assert.deepEqual(tags, [`skill-evolve/${slug}/1`]);
  } finally {
    await cleanupArtifact(fx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writeRevisionAtomic — update increments revision number", skipIfNoDb, async () => {
  const cwd = await makeTempRepo();
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const fx = await seedSkillArtifact(slug);
  try {
    const r1 = await writeRevisionAtomic({
      skillArtifactId: fx.skillId,
      skillSlug: slug,
      content: "# v1\n",
      intent: "register",
      appliedBy: "test",
      summary: "register v1",
      cwd,
    });
    const r2 = await writeRevisionAtomic({
      skillArtifactId: fx.skillId,
      skillSlug: slug,
      content: "# v2\n",
      intent: "update",
      appliedBy: "test",
      summary: "update v2",
      cwd,
    });
    assert.equal(r1.revisionNumber, 1);
    assert.equal(r2.revisionNumber, 2);
    assert.equal(r2.gitTag, `skill-evolve/${slug}/2`);

    const tags = await gitListTagsMatching({ pattern: `skill-evolve/${slug}/*`, cwd });
    assert.deepEqual(tags.sort(), [`skill-evolve/${slug}/1`, `skill-evolve/${slug}/2`]);
  } finally {
    await cleanupArtifact(fx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writeRevisionAtomic — tag collision rolls back commit + DB + file", skipIfNoDb, async () => {
  const cwd = await makeTempRepo();
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const fx = await seedSkillArtifact(slug);
  try {
    // Pre-create the tag we're about to collide with. Need a commit to anchor it.
    await mkdir(join(cwd, "decoy"), { recursive: true });
    await writeFile(join(cwd, "decoy/x"), "x");
    await execFileAsync("git", ["add", "decoy/x"], { cwd });
    await execFileAsync("git", ["commit", "-q", "-m", "decoy"], { cwd });
    const decoySha = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
    ).stdout.trim();
    await gitTag({
      tag: `skill-evolve/${slug}/1`,
      sha: decoySha,
      message: "pre-existing",
      cwd,
    });

    await assert.rejects(
      () =>
        writeRevisionAtomic({
          skillArtifactId: fx.skillId,
          skillSlug: slug,
          content: "# v1\n",
          intent: "register",
          appliedBy: "test",
          summary: "should fail",
          cwd,
        }),
    );

    // file should not exist (we're registering — prior content was null)
    await assert.rejects(() =>
      access(join(cwd, ".arceus/skills-seed", slug, "SKILL.md")),
    );

    // no DB row
    const db = getDb();
    const rows = await db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, fx.skillId));
    assert.equal(rows.length, 0);
  } finally {
    await cleanupArtifact(fx);
    await rm(cwd, { recursive: true, force: true });
  }
});
