/**
 * Spec 29 Phase A.2 — Tests for git helper round-trips against a temp repo.
 * No network, no DB. Just fs + git CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GitError,
  gitCommitFiles,
  gitTag,
  gitShowFileAtTag,
  gitListTagsMatching,
  gitDeleteTag,
  gitResetHard,
  gitHeadSha,
} from "./git.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spec29-git-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  // initial commit so HEAD exists
  await writeFile(join(dir, "README"), "init\n");
  await execFileAsync("git", ["add", "README"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("gitCommitFiles + gitHeadSha round-trip", async () => {
  const cwd = await makeTempRepo();
  try {
    await mkdir(join(cwd, "skills/x"), { recursive: true });
    await writeFile(join(cwd, "skills/x/SKILL.md"), "v1\n");
    const { sha } = await gitCommitFiles({
      paths: ["skills/x/SKILL.md"],
      message: "skill x v1",
      cwd,
    });
    assert.match(sha, /^[0-9a-f]{40}$/);
    const head = await gitHeadSha({ cwd });
    assert.equal(head, sha);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gitTag + gitShowFileAtTag + gitListTagsMatching", async () => {
  const cwd = await makeTempRepo();
  try {
    await mkdir(join(cwd, "skills/y"), { recursive: true });
    await writeFile(join(cwd, "skills/y/SKILL.md"), "y-v1\n");
    const { sha } = await gitCommitFiles({
      paths: ["skills/y/SKILL.md"],
      message: "y v1",
      cwd,
    });
    await gitTag({ tag: "skill-evolve/y/1", sha, message: "y v1", cwd });

    const tags = await gitListTagsMatching({ pattern: "skill-evolve/y/*", cwd });
    assert.deepEqual(tags, ["skill-evolve/y/1"]);

    const content = await gitShowFileAtTag({
      tag: "skill-evolve/y/1",
      path: "skills/y/SKILL.md",
      cwd,
    });
    assert.equal(content, "y-v1\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gitDeleteTag + gitResetHard rollback", async () => {
  const cwd = await makeTempRepo();
  try {
    const baseHead = await gitHeadSha({ cwd });
    await mkdir(join(cwd, "skills/z"), { recursive: true });
    await writeFile(join(cwd, "skills/z/SKILL.md"), "z\n");
    const { sha } = await gitCommitFiles({
      paths: ["skills/z/SKILL.md"],
      message: "z v1",
      cwd,
    });
    await gitTag({ tag: "skill-evolve/z/1", sha, message: "z v1", cwd });

    await gitDeleteTag({ tag: "skill-evolve/z/1", cwd });
    const tags = await gitListTagsMatching({ pattern: "skill-evolve/z/*", cwd });
    assert.deepEqual(tags, []);

    await gitResetHard({ ref: baseHead, cwd });
    assert.equal(await gitHeadSha({ cwd }), baseHead);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitError captures stderr on failure", async () => {
  const cwd = await makeTempRepo();
  try {
    await assert.rejects(
      () =>
        gitShowFileAtTag({
          tag: "does-not-exist",
          path: "nope",
          cwd,
        }),
      (err: unknown) => err instanceof GitError && err.stderr.length > 0,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
