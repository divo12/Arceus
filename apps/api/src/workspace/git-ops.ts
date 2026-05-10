/**
 * Low-level git helpers for workspace versioning — init, commit, bundle,
 * clone, tag, and diff operations backed by `git` CLI.
 *
 * Concurrency note: every public function below runs the git CLI through
 * `withKeyedLock(workspacePath, ...)` so concurrent heartbeats never
 * collide on `.git/index.lock` and never produce interleaved commits.
 * Internal helpers (`runGit`, `pathExists`) are NOT locked — they're
 * composed inside the locked public wrappers, so locking once at the
 * boundary is sufficient. Different workspaces use different keys and
 * still run in parallel.
 *
 * Lock granularity is intentional: per-workspace, not global. We expect
 * ≤ 1 active product workspace at a time today, but the per-key shape
 * means future per-beat git-worktree isolation can reuse the same code
 * unchanged.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withKeyedLock } from "./async-queue.js";

const execFileAsync = promisify(execFile);

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], cwd: string, allowError = false) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (allowError) {
      return "";
    }

    const message = error instanceof Error ? error.message : "Unknown git error";
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

// ── Internal (unlocked) implementations ───────────────────────────────────
// Public wrappers below acquire the per-workspace lock and call into these.
// Keeping internals unlocked lets one public op (e.g. commitAllChanges) call
// another (ensureGitRepository, getHeadSha) without queue ping-pong while
// still holding a single critical section.

async function ensureGitRepositoryUnlocked(workspacePath: string) {
  await mkdir(workspacePath, { recursive: true });

  if (!(await pathExists(join(workspacePath, ".git")))) {
    await runGit(["init", "-b", "main"], workspacePath);
  }

  await runGit(["config", "user.name", "Arceus"], workspacePath, true);
  await runGit(["config", "user.email", "arceus@local.invalid"], workspacePath, true);

  if (!(await pathExists(join(workspacePath, ".gitkeep")))) {
    await writeFile(join(workspacePath, ".gitkeep"), "", { flag: "a" });
  }
}

async function getHeadShaUnlocked(workspacePath: string) {
  const sha = await runGit(["rev-parse", "HEAD"], workspacePath, true);
  return sha || null;
}

async function commitAllChangesUnlocked(workspacePath: string, message: string) {
  await ensureGitRepositoryUnlocked(workspacePath);

  const status = await runGit(["status", "--porcelain"], workspacePath, true);
  const currentHead = await getHeadShaUnlocked(workspacePath);

  if (!status && currentHead) {
    return currentHead;
  }

  await runGit(["add", "-A"], workspacePath);
  if (status) {
    await runGit(["commit", "-m", message], workspacePath);
  } else {
    await runGit(["commit", "--allow-empty", "-m", message], workspacePath);
  }

  const sha = await getHeadShaUnlocked(workspacePath);
  if (!sha) {
    throw new Error("Repository commit completed but HEAD is unavailable.");
  }

  return sha;
}

// ── Public (locked) API ───────────────────────────────────────────────────

/** Ensure the directory is a git repository with an initial commit-ready state. */
export async function ensureGitRepository(workspacePath: string) {
  return withKeyedLock(workspacePath, () => ensureGitRepositoryUnlocked(workspacePath));
}

/** Return the current HEAD SHA, or null if the repo has no commits. */
export async function getHeadSha(workspacePath: string) {
  return withKeyedLock(workspacePath, () => getHeadShaUnlocked(workspacePath));
}

/**
 * Stage all changes and commit; returns the resulting HEAD SHA.
 *
 * Critical section: the entire ensure → status → add → commit → rev-parse
 * sequence runs under one lock. Without it, two concurrent beats could
 * each see the same `git status`, both `git add -A`, and produce
 * interleaved commits or trip on `.git/index.lock`.
 */
export async function commitAllChanges(workspacePath: string, message: string) {
  return withKeyedLock(workspacePath, () => commitAllChangesUnlocked(workspacePath, message));
}

/** Create a git bundle containing the full repository history. */
export async function createBundleFromWorkspace(workspacePath: string, bundlePath: string) {
  return withKeyedLock(workspacePath, async () => {
    await ensureGitRepositoryUnlocked(workspacePath);
    if (!(await getHeadShaUnlocked(workspacePath))) {
      await commitAllChangesUnlocked(workspacePath, "Initialize workspace repository");
    }

    await mkdir(dirname(bundlePath), { recursive: true });
    await rm(bundlePath, { force: true });
    await runGit(["bundle", "create", bundlePath, "--all"], workspacePath);
    return bundlePath;
  });
}

/**
 * Clone a workspace from a git bundle file into the target directory.
 *
 * Locked on `targetPath` because that's the workspace being mutated;
 * the bundle file itself is read-only and doesn't need a lock.
 */
export async function cloneWorkspaceFromBundle(bundlePath: string, targetPath: string) {
  return withKeyedLock(targetPath, async () => {
    await rm(targetPath, { recursive: true, force: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await runGit(["clone", bundlePath, targetPath], dirname(targetPath));
    return targetPath;
  });
}

/** Create a lightweight git tag (idempotent — skips if tag already exists). */
export async function tagWorkspace(workspacePath: string, tagName: string) {
  return withKeyedLock(workspacePath, async () => {
    await ensureGitRepositoryUnlocked(workspacePath);

    const existing = await runGit(["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], workspacePath, true);
    if (!existing) {
      await runGit(["tag", tagName], workspacePath);
    }

    return tagName;
  });
}

/** Return a `--stat` diff between two git refs. */
export async function diffWorkspaceRefs(workspacePath: string, fromRef: string, toRef: string) {
  return withKeyedLock(workspacePath, async () => {
    await ensureGitRepositoryUnlocked(workspacePath);
    return runGit(["diff", "--stat", fromRef, toRef], workspacePath, true);
  });
}