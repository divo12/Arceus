/**
 * Spec 22 / Spec 34 v3 PR 9 — File-change graph events.
 */
import { graphStore, type FileChange } from "../graph-store.js";

const GRAPH_FILE_IGNORE = new Set([
  "node_modules", ".git", "dist", ".next", ".turbo", ".cache",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".env", ".env.local", "tsconfig.tsbuildinfo",
]);

/** Record file changes on a graph node, filtering out common noise (node_modules, lockfiles, etc.). */
export function emitGraphFileChanges(
  sprintId: string,
  nodeId: string,
  files: { path: string; action?: "created" | "modified" | "deleted"; linesChanged?: number | null }[],
): void {
  const filtered: FileChange[] = files
    .filter((f) => {
      const firstSegment = f.path.split("/")[0];
      return !GRAPH_FILE_IGNORE.has(firstSegment) && !GRAPH_FILE_IGNORE.has(f.path);
    })
    .map((f) => ({
      path: f.path,
      action: f.action ?? "modified",
      linesChanged: f.linesChanged ?? null,
    }));
  if (filtered.length > 0) {
    graphStore.addFileChanges(sprintId, nodeId, filtered);
  }
}
