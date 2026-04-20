/**
 * Low-level git helpers for workspace versioning — init, commit, bundle,
 * clone, tag, and diff operations backed by `git` CLI.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

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

/** Ensure the directory is a git repository with an initial commit-ready state. */
export async function ensureGitRepository(workspacePath: string) {
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

/** Return the current HEAD SHA, or null if the repo has no commits. */
export async function getHeadSha(workspacePath: string) {
  const sha = await runGit(["rev-parse", "HEAD"], workspacePath, true);
  return sha || null;
}

/** Stage all changes and commit; returns the resulting HEAD SHA. */
export async function commitAllChanges(workspacePath: string, message: string) {
  await ensureGitRepository(workspacePath);

  const status = await runGit(["status", "--porcelain"], workspacePath, true);
  const currentHead = await getHeadSha(workspacePath);

  if (!status && currentHead) {
    return currentHead;
  }

  await runGit(["add", "-A"], workspacePath);
  if (status) {
    await runGit(["commit", "-m", message], workspacePath);
  } else {
    await runGit(["commit", "--allow-empty", "-m", message], workspacePath);
  }

  const sha = await getHeadSha(workspacePath);
  if (!sha) {
    throw new Error("Repository commit completed but HEAD is unavailable.");
  }

  return sha;
}

/** Create a git bundle containing the full repository history. */
export async function createBundleFromWorkspace(workspacePath: string, bundlePath: string) {
  await ensureGitRepository(workspacePath);
  if (!(await getHeadSha(workspacePath))) {
    await commitAllChanges(workspacePath, "Initialize workspace repository");
  }

  await mkdir(dirname(bundlePath), { recursive: true });
  await rm(bundlePath, { force: true });
  await runGit(["bundle", "create", bundlePath, "--all"], workspacePath);
  return bundlePath;
}

/** Clone a workspace from a git bundle file into the target directory. */
export async function cloneWorkspaceFromBundle(bundlePath: string, targetPath: string) {
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(dirname(targetPath), { recursive: true });
  await runGit(["clone", bundlePath, targetPath], dirname(targetPath));
  return targetPath;
}

/** Create a lightweight git tag (idempotent — skips if tag already exists). */
export async function tagWorkspace(workspacePath: string, tagName: string) {
  await ensureGitRepository(workspacePath);

  const existing = await runGit(["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], workspacePath, true);
  if (!existing) {
    await runGit(["tag", tagName], workspacePath);
  }

  return tagName;
}

/** Return a `--stat` diff between two git refs. */
export async function diffWorkspaceRefs(workspacePath: string, fromRef: string, toRef: string) {
  await ensureGitRepository(workspacePath);
  return runGit(["diff", "--stat", fromRef, toRef], workspacePath, true);
}