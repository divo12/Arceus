/**
 * Beat path utilities + symlink swap.
 *
 * Per-beat isolation uses `/tmp/arceus/beats/<beatId>/` as ephemeral scratch.
 * The product workspace's `.opencode/skills` is a symlink swapped per beat
 * to point at the current beat's skill tree.
 *
 * Phase 6.5 — Package C.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { productWorkspace } from "./opencode.js";

export const beatScratchDir = (beatId: string): string =>
  path.join("/tmp", "arceus", "beats", beatId);

export const beatSkillsDir = (beatId: string): string =>
  path.join(beatScratchDir(beatId), "skills");

export const productWorkspaceSkillsSymlink = (): string =>
  path.join(productWorkspace, ".opencode", "skills");

export async function swapSkillsSymlink(targetDir: string): Promise<void> {
  const link = productWorkspaceSkillsSymlink();
  try { await fs.unlink(link); } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== "ENOENT") throw e;
  }
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(targetDir, link);
}

export async function cleanupBeatScratch(beatId: string): Promise<void> {
  await fs.rm(beatScratchDir(beatId), { recursive: true, force: true });
}
