/**
 * Dream-style todo_write — unit tests for the markdown checklist helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTodoWrite, confineWorkspacePath, readTodoChecklist } from "./todo-write.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "arceus-todo-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("adds unchecked items to a new TODO.md", async () => {
  await withTempDir(async (dir) => {
    const r = await applyTodoWrite(dir, { item: "wire auth route" });
    assert.equal(r.changed, true);
    assert.match(r.summary, /added/);
    const body = await readFile(join(dir, "TODO.md"), "utf8");
    assert.match(body, /^# TODO\n/);
    assert.match(body, /- \[ \] wire auth route/);
  });
});

test("checks off an existing unchecked item", async () => {
  await withTempDir(async (dir) => {
    await applyTodoWrite(dir, { item: "wire auth route" });
    const r = await applyTodoWrite(dir, { item: "wire auth route", checked: true });
    assert.equal(r.changed, true);
    assert.match(r.summary, /checked off/);
    const body = await readFile(join(dir, "TODO.md"), "utf8");
    assert.match(body, /- \[x\] wire auth route/);
    assert.doesNotMatch(body, /- \[ \] wire auth route/);
  });
});

test("is idempotent when already in desired state", async () => {
  await withTempDir(async (dir) => {
    await applyTodoWrite(dir, { item: "a" });
    const r = await applyTodoWrite(dir, { item: "a" });
    assert.equal(r.changed, false);
    assert.equal(r.summary, "already in desired state");
  });
});

test("rejects path traversal", () => {
  assert.throws(() => confineWorkspacePath("/tmp/ws", "../escape.md"));
});

test("readTodoChecklist returns null when missing", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readTodoChecklist(dir), null);
  });
});

test("supports custom relative path", async () => {
  await withTempDir(async (dir) => {
    await applyTodoWrite(dir, { item: "task-local step", path: ".arceus/TODO-task.md" });
    const body = await readTodoChecklist(dir, ".arceus/TODO-task.md");
    assert.ok(body);
    assert.match(body, /- \[ \] task-local step/);
  });
});
