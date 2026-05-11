/**
 * Workspace manifest walker — produces a per-beat snapshot of what's in
 * a tenant's product workspace beyond the scaffold seed.
 *
 * Wired into prepareBeatRender so the developer/CTO/tester sees:
 *
 *   ## Workspace state (beyond seed)
 *   src/components/SearchBar.tsx       (modified 2026-05-11T18:14, 2.1KB)
 *   specs/spec-v1-search.md            (created 2026-05-11T17:17, PM)
 *   design/tokens.yaml                 (created 2026-05-11T18:02, UI Designer)
 *   ...
 *
 * The model opens the beat already knowing what's there. The 30-60s of
 * "glob+read to figure out the workspace" pattern disappears because
 * the discovery answer is already in the prompt.
 *
 * What gets FILTERED:
 *   - node_modules/, .git/, dist/, .vite/, lost+found/  (runtime noise)
 *   - The scaffold seed files (package.json, vite.config.ts, src/App.tsx, etc.)
 *     — these are already covered by skill(developer-workspace-layout).
 *     Echoing them back would defeat the point of moving them to a skill.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface WorkspaceManifestEntry {
  /** Path relative to the product workspace root. */
  path: string;
  /** Bytes. */
  size: number;
  /** ISO-8601 mtime. */
  modifiedAt: string;
  /** True if the file is a directory (rare in the manifest; we mostly want files). */
  isDir: boolean;
}

/** Files in the workspace seed — filtered out of the manifest. */
const SCAFFOLD_SEED_PATHS = new Set<string>([
  ".gitignore",
  ".gitkeep",
  "README.md",
  "index.html",
  "package.json",
  "postcss.config.js",
  "tailwind.config.js",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "src/App.tsx",
  "src/index.css",
  "src/main.tsx",
  "src/lib/utils.ts",
  "src/components/.gitkeep",
]);

/** Directory entries to skip entirely (don't descend). */
const SKIP_DIRS = new Set<string>([
  "node_modules",
  ".git",
  ".opencode",
  "dist",
  "dist-ssr",
  ".vite",
  ".cache",
  "lost+found",
  "coverage",
]);

/** Files matching these globs are skipped (build artifacts, lockfiles). */
const SKIP_FILE_PATTERNS = [
  /\.log$/,
  /package-lock\.json$/,
  /bun\.lockb$/,
  /\.DS_Store$/,
];

interface WalkOptions {
  maxDepth?: number;
  maxEntries?: number;
}

/**
 * Walk a workspace directory and return the manifest of "interesting" files
 * (everything the agent produced or received, minus the scaffold + noise).
 *
 * Safe to call on non-existent dirs (returns empty array).
 */
export async function walkWorkspaceManifest(
  productDir: string,
  opts: WalkOptions = {},
): Promise<WorkspaceManifestEntry[]> {
  if (!existsSync(productDir)) return [];
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 40;
  const entries: WorkspaceManifestEntry[] = [];

  await walk(productDir, "", 0, maxDepth, maxEntries, entries);

  // Sort: newest first within same depth. Caps applied above.
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return entries;
}

async function walk(
  productDir: string,
  rel: string,
  depth: number,
  maxDepth: number,
  maxEntries: number,
  out: WorkspaceManifestEntry[],
): Promise<void> {
  if (depth > maxDepth) return;
  if (out.length >= maxEntries) return;

  const abs = rel ? join(productDir, rel) : productDir;
  let dirents: string[];
  try {
    dirents = await readdir(abs);
  } catch {
    return;
  }

  for (const name of dirents) {
    if (out.length >= maxEntries) return;
    if (SKIP_DIRS.has(name)) continue;
    if (SKIP_FILE_PATTERNS.some((re) => re.test(name))) continue;

    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = join(productDir, childRel);
    let st;
    try {
      st = await stat(childAbs);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      // Skip the scaffold's pre-seeded src/components and src/lib dirs IF
      // they're empty beyond the seed (.gitkeep, utils.ts). We don't have
      // a cheap test for that here so just descend; the seed-file filter
      // below excludes the seeded files from the output.
      await walk(productDir, childRel, depth + 1, maxDepth, maxEntries, out);
      continue;
    }

    // Skip the scaffold's seeded files
    if (SCAFFOLD_SEED_PATHS.has(childRel)) continue;

    out.push({
      path: childRel,
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      isDir: false,
    });
  }
}

/** Format a manifest entry's size in human-readable form. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Cheap relative time. */
export function formatRelativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// Re-exports for the renderer
export { relative };
