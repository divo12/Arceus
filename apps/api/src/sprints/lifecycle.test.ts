import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "@arceus/contracts";
import { isImplementationTask, listOpenImplementationTasks } from "./lifecycle.js";

function task(over: Partial<Task> & Pick<Task, "id" | "sprintId" | "status">): Task {
  return {
    id: over.id,
    sprintId: over.sprintId,
    status: over.status,
    kind: over.kind ?? "implementation",
  } as Task;
}

test("isImplementationTask excludes follow_up and bug_fix", () => {
  assert.equal(isImplementationTask(task({ id: "t1", sprintId: "s1", status: "planned" })), true);
  assert.equal(isImplementationTask(task({ id: "t2", sprintId: "s1", status: "planned", kind: "follow_up" })), false);
  assert.equal(isImplementationTask(task({ id: "t3", sprintId: "s1", status: "planned", kind: "bug_fix" })), false);
});

test("listOpenImplementationTasks returns only non-terminal implementation tasks", () => {
  const snapshot = {
    tasks: [
      task({ id: "done", sprintId: "s1", status: "completed" }),
      task({ id: "open", sprintId: "s1", status: "in_progress", title: "Still building" }),
      task({ id: "bug", sprintId: "s1", status: "in_progress", kind: "bug_fix" }),
      task({ id: "other", sprintId: "s2", status: "planned" }),
    ],
  };

  const open = listOpenImplementationTasks(snapshot, "s1");
  assert.equal(open.length, 1);
  assert.equal(open[0]?.id, "open");
});
