/**
 * Spec 29 Phase A.2 — Git helpers for skill revisions.
 *
 * Pure shell-out wrappers around `git`. Each helper takes only the
 * workspace-relative arguments it needs and returns typed output.
 *
 * - All commands run via `execFile("git", [...])` against `cwd = REPO_ROOT`.
 * - Errors throw a tagged `GitError` with stderr captured.
 * - These helpers do NOT push to a remote; pushing is an ops concern.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
// apps/api/src/skills/git.ts → repo root is 4 levels up
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..", "..", "..");

export class GitError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, opts: { stderr?: string; exitCode?: number | null } = {}) {
    super(message);
    this.name = "GitError";
    this.stderr = opts.stderr ?? "";
    this.exitCode = opts.exitCode ?? null;
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Override the repo root. Used by tests against temp repos. */
  cwd?: string;
}

async function runGit(args: string[], opts: GitOptions = {}): Promise<ExecResult> {
  const cwd = opts.cwd ?? REPO_ROOT;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | null };
    throw new GitError(`git ${args.join(" ")} failed: ${e.message}`, {
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : null,
    });
  }
}

export async function gitCommitFiles(
  opts: { paths: string[]; message: string } & GitOptions,
): Promise<{ sha: string }> {
  if (opts.paths.length === 0) throw new GitError("gitCommitFiles requires at least one path");
  await runGit(["add", "--", ...opts.paths], opts);
  // Allow empty in case the file content didn't actually change — caller decides
  // whether to treat that as an error. Default behavior: fail on empty commit.
  await runGit(["commit", "-m", opts.message, "--", ...opts.paths], opts);
  const { stdout } = await runGit(["rev-parse", "HEAD"], opts);
  return { sha: stdout.trim() };
}

export async function gitTag(
  opts: { tag: string; sha: string; message: string } & GitOptions,
): Promise<void> {
  await runGit(["tag", "-a", opts.tag, opts.sha, "-m", opts.message], opts);
}

export async function gitShowFileAtTag(
  opts: { tag: string; path: string } & GitOptions,
): Promise<string> {
  const { stdout } = await runGit(["show", `${opts.tag}:${opts.path}`], opts);
  return stdout;
}

export async function gitListTagsMatching(
  opts: { pattern: string } & GitOptions,
): Promise<string[]> {
  const { stdout } = await runGit(["tag", "--list", opts.pattern], opts);
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function gitDeleteTag(
  opts: { tag: string } & GitOptions,
): Promise<void> {
  await runGit(["tag", "-d", opts.tag], opts);
}

export async function gitResetHard(
  opts: { ref: string } & GitOptions,
): Promise<void> {
  await runGit(["reset", "--hard", opts.ref], opts);
}

export async function gitHeadSha(opts: GitOptions = {}): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], opts);
  return stdout.trim();
}

export function getRepoRoot(): string {
  return REPO_ROOT;
}
