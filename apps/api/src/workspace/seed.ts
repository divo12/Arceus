/**
 * Workspace seed — copy the canonical scaffold from
 * `packages/workspace-template/template/` into a freshly-provisioned
 * company directory.
 *
 * Called from `workspaceManager.provision()` BEFORE `git init` so the
 * initial commit captures the scaffold as the starting point.
 *
 * The seed is idempotent and SAFE: it copies only when the target
 * directory has no product files (it's empty, or only contains git/
 * OpenCode runtime artifacts). A workspace with existing source code
 * is left untouched — the helper returns `false` to signal "skipped"
 * so the caller can audit it.
 */
import { existsSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the monorepo root by walking up from this file until we hit
 * the directory that has both `opencode.json` and a `packages/` dir.
 * Mirrors the same probe used by `infra/opencode.ts`, kept local here
 * to avoid coupling.
 */
function findMonorepoRoot(): string {
  let dir = resolve(
    import.meta.dirname ?? dirname(new URL(import.meta.url).pathname),
  );
  if (process.platform === "win32" && dir.startsWith("/")) dir = dir.slice(1);
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "opencode.json")) && existsSync(resolve(dir, "packages"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const TEMPLATE_DIR = resolve(findMonorepoRoot(), "packages", "workspace-template", "template");

/**
 * Files/dirs that are NOT product code — their presence shouldn't
 * make us skip the seed. `.git` is from a prior `ensureGitRepository`
 * call; `.opencode` is OpenCode's session-tracking artifacts; `.arceus`
 * is for any future runtime metadata.
 */
const RUNTIME_ONLY_ENTRIES = new Set([".git", ".opencode", ".arceus", ".DS_Store"]);

/**
 * Copy the workspace template into `targetDir` if (and only if) the
 * directory contains no product files. Returns true when the seed was
 * applied, false when skipped.
 *
 * Caller is responsible for ensuring `targetDir` exists (mkdir -p)
 * before calling.
 */
export async function seedWorkspaceIfEmpty(targetDir: string): Promise<{
  seeded: boolean;
  reason?: string;
}> {
  if (!existsSync(TEMPLATE_DIR)) {
    return { seeded: false, reason: `template_dir_missing: ${TEMPLATE_DIR}` };
  }

  let entries: string[];
  try {
    entries = await readdir(targetDir);
  } catch (err) {
    return {
      seeded: false,
      reason: `readdir_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const productEntries = entries.filter((e) => !RUNTIME_ONLY_ENTRIES.has(e));
  if (productEntries.length > 0) {
    return { seeded: false, reason: `non_empty: ${productEntries.slice(0, 3).join(",")}` };
  }

  // Recursive copy. `cp` with `recursive: true` works on Node 16.7+.
  // `force: false` would error on existing files — but we've already
  // confirmed no product files exist, so the only collisions would be
  // hidden runtime dirs we want to preserve. Use `force: true` so the
  // copy is idempotent if rerun, and trust the empty-check above.
  await cp(TEMPLATE_DIR, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  return { seeded: true };
}
