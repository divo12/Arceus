/**
 * Ensure a product workspace has its dependencies installed before a baseline
 * typecheck. Without this, `workspace_verify_baseline` ran `tsc` against a tree
 * with no node_modules → "cannot find module 'hono'" + cascading implicit-any,
 * blocking the task and spawning a wasteful bug-fix detour.
 *
 * Install is lazy (only when node_modules is missing) so the lazy-install design
 * is preserved. The env is the bug-prone part: Railway sets NODE_ENV=production
 * container-wide, which makes `npm install` silently strip devDependencies
 * (typescript/tsc/vite) — so we force NODE_ENV=development + --include=dev.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface InstallSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Pure: the command/args/env for a baseline dependency install. */
export function baselineInstallSpec(baseEnv: NodeJS.ProcessEnv): InstallSpec {
  return {
    command: "npm",
    args: ["install", "--include=dev"],
    // Force development so npm keeps devDeps (tsc/typescript/vite) that the
    // typecheck depends on — Railway's container NODE_ENV=production strips them.
    env: { ...baseEnv, NODE_ENV: "development" },
  };
}

export interface EnsureDepsResult {
  skipped: boolean;
  installed: boolean;
  error?: string;
}

/** True when the workspace has no installed dependencies yet. */
export function needsInstall(cwd: string): boolean {
  return !existsSync(join(cwd, "node_modules"));
}

/**
 * Install deps if missing. Resolves (never rejects) with the outcome so the
 * caller can surface a clear message instead of a cryptic tsc error.
 */
export function ensureDepsInstalled(cwd: string, timeoutMs: number): Promise<EnsureDepsResult> {
  return new Promise((resolveP) => {
    if (!needsInstall(cwd)) {
      resolveP({ skipped: true, installed: false });
      return;
    }
    const spec = baselineInstallSpec(process.env);
    const child = spawn(spec.command, spec.args, { cwd, shell: true, env: spec.env });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { resolveP({ skipped: false, installed: false, error: `npm install timed out after ${timeoutMs}ms` }); return; }
      if (code === 0) { resolveP({ skipped: false, installed: true }); return; }
      resolveP({ skipped: false, installed: false, error: `npm install exited ${code}: ${out.slice(-300)}` });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ skipped: false, installed: false, error: `npm install failed to start: ${err.message}` });
    });
  });
}
