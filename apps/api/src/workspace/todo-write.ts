/**
 * Dream-style todo_write — maintain a markdown checklist in the company workspace.
 *
 * Port of dream's TodoWriteTool (item + checked → `- [ ]` / `- [x]` lines in TODO.md).
 * Chorus uses this as the cross-beat resume protocol: list steps up front, check off
 * the moment each is done, read + reconcile on every beat start.
 *
 * Pure filesystem helper — callers resolve the company workspace root.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const SEED = "# TODO\n";
const DEFAULT_RELATIVE_PATH = "TODO.md";

export interface TodoWriteInput {
  item: string;
  checked?: boolean;
  /** Relative path inside the workspace. Defaults to TODO.md. */
  path?: string;
}

export interface TodoWriteResult {
  changed: boolean;
  summary: string;
  relativePath: string;
  content: string;
}

/** Confine a relative path to the workspace root (no traversal). */
export function confineWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const cleaned = relativePath.replace(/^\/+/, "").trim() || DEFAULT_RELATIVE_PATH;
  const abs = resolve(workspaceRoot, cleaned);
  const root = resolve(workspaceRoot);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return abs;
}

async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/**
 * Add a TODO item or mark an existing one done in a markdown checklist.
 * Idempotent: no-op when the target line already exists.
 */
export async function applyTodoWrite(
  workspaceRoot: string,
  input: TodoWriteInput,
): Promise<TodoWriteResult> {
  const item = input.item.trim();
  if (!item) {
    throw new Error("item must be non-empty");
  }
  const relativePath = (input.path?.trim() || DEFAULT_RELATIVE_PATH).replace(/^\/+/, "");
  const abs = confineWorkspacePath(workspaceRoot, relativePath);

  let existing: string;
  try {
    existing = await readFile(abs, "utf8");
  } catch {
    existing = SEED;
  }

  const unchecked = `- [ ] ${item}`;
  const checked = `- [x] ${item}`;
  const target = input.checked ? checked : unchecked;

  let updated: string;
  let summary: string;

  if (input.checked && existing.includes(unchecked)) {
    // Dream semantics: flip only the first matching unchecked line.
    const idx = existing.indexOf(unchecked);
    updated = existing.slice(0, idx) + checked + existing.slice(idx + unchecked.length);
    summary = "checked off";
  } else if (existing.includes(target)) {
    return {
      changed: false,
      summary: "already in desired state",
      relativePath,
      content: `No change needed in ${relativePath}`,
    };
  } else {
    updated = existing.replace(/\n*$/, "") + `\n${target}\n`;
    summary = "added";
  }

  await atomicWriteText(abs, updated);
  return {
    changed: true,
    summary: `${summary} TODO item`,
    relativePath,
    content: `Updated ${relativePath} (${summary}: ${item})`,
  };
}

/** Read TODO.md (or custom path) if present; returns null when missing. */
export async function readTodoChecklist(
  workspaceRoot: string,
  relativePath: string = DEFAULT_RELATIVE_PATH,
): Promise<string | null> {
  try {
    const abs = confineWorkspacePath(workspaceRoot, relativePath);
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

export { DEFAULT_RELATIVE_PATH as TODO_DEFAULT_PATH };
