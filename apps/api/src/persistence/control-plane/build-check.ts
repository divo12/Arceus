/**
 * Control plane — workspace build status check.
 * Spec 11 / Spec 34 v3 PR 11.
 *
 * Owns:
 *   - buildCheckProductDir (set by server.ts at boot via cpSetBuildCheckDir)
 *   - lastBuildCheck (cached result)
 *
 * `runBuildCheck` is internal to this file; cpLoadAgentContext (in
 * `./snapshot.ts`) refreshes-if-stale via `refreshBuildCheckIfStale`
 * and reads the cached result via `getLastBuildCheck`.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let buildCheckProductDir: string | null = null;
let lastBuildCheck: { status: "ok" | "error" | "unknown"; detail: string; checkedAt: string } = {
  status: "unknown",
  detail: "Not yet checked",
  checkedAt: new Date().toISOString(),
};

/** Set the product directory for build status checks. Called once from server.ts at boot. */
export function cpSetBuildCheckDir(dir: string): void {
  buildCheckProductDir = dir;
}

/** Read the cached last build check result. */
export function getLastBuildCheck(): typeof lastBuildCheck {
  return lastBuildCheck;
}

/**
 * Refresh the cached build check IFF the product dir is configured AND the
 * cached result is older than 2 minutes (or has never been computed).
 * Called from the per-beat agent-context assembly path in `./snapshot.ts`.
 */
export function refreshBuildCheckIfStale(): void {
  if (!buildCheckProductDir) return;
  const staleMs = Date.now() - new Date(lastBuildCheck.checkedAt).getTime();
  if (staleMs > 120_000 || lastBuildCheck.status === "unknown") {
    runBuildCheck(buildCheckProductDir);
  }
}

/**
 * Run a build check in the product workspace directory. Updates the
 * cached result. Internal — exposed only via `refreshBuildCheckIfStale`.
 */
function runBuildCheck(productDir: string): typeof lastBuildCheck {
  if (!existsSync(productDir)) {
    lastBuildCheck = { status: "unknown", detail: `Product dir does not exist: ${productDir}`, checkedAt: new Date().toISOString() };
    return lastBuildCheck;
  }

  const pkgPath = join(productDir, "package.json");
  if (!existsSync(pkgPath)) {
    lastBuildCheck = { status: "ok", detail: "No package.json — no build check applicable", checkedAt: new Date().toISOString() };
    return lastBuildCheck;
  }

  try {
    // Prefer `npm run build` if it exists, otherwise `npx tsc --noEmit`
    let cmd = "npx tsc --noEmit";
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) cmd = "npm run build";
    } catch { /* use default */ }

    // `shell: true` works at runtime but the @types/node overload only allows
    // string | URL. We cast through `string` to satisfy the overload without
    // disabling type-checking on the rest of the call site.
    execSync(cmd, { cwd: productDir, timeout: 30_000, stdio: "pipe", shell: true as unknown as string });
    lastBuildCheck = { status: "ok", detail: `Build passed (${cmd})`, checkedAt: new Date().toISOString() };
  } catch (err: unknown) {
    // execSync errors carry a `stderr: Buffer` field but @types/node only
    // surfaces it on the rejected-promise path, not the thrown one. Read it
    // through a narrowed shape rather than `any`.
    const errWithStderr = err as { stderr?: { toString?: () => string } };
    const stderr = errWithStderr.stderr?.toString?.().slice(0, 500) ?? "";
    lastBuildCheck = { status: "error", detail: stderr || "Build failed", checkedAt: new Date().toISOString() };
  }

  return lastBuildCheck;
}
