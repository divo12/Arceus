/**
 * Unit tests for the task_complete evidence + build gate.
 * Run: bun test src/tasks/completion-gate.test.ts
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Task } from "@arceus/contracts";
import { CODE_TASK_KINDS, VIEWABLE_TASK_KINDS } from "./completion-gate.js";

describe("completion gate kind sets", () => {
  it("treats implementation / local_preview / bug_fix as code tasks", () => {
    assert.ok(CODE_TASK_KINDS.has("implementation"));
    assert.ok(CODE_TASK_KINDS.has("local_preview"));
    assert.ok(CODE_TASK_KINDS.has("bug_fix"));
    assert.equal(CODE_TASK_KINDS.has("qa_verification"), false);
    assert.equal(CODE_TASK_KINDS.has("technical_plan"), false);
  });

  it("treats implementation / local_preview as viewable", () => {
    assert.ok(VIEWABLE_TASK_KINDS.has("implementation"));
    assert.ok(VIEWABLE_TASK_KINDS.has("local_preview"));
    assert.equal(VIEWABLE_TASK_KINDS.has("bug_fix"), false);
  });
});

describe("evaluateCompletionGate — evidence required", () => {
  it("rejects when no evidence ids and task has no artifacts", async () => {
    // Dynamic import so we can stub after module load if needed; here we
    // only assert the pure early-return path that doesn't hit DB when
    // both requested and attached are empty — but resolveEvidenceIds still
    // short-circuits on empty combined. Mock via a minimal task.
    const { evaluateCompletionGate } = await import("./completion-gate.js");
    const task = {
      id: "task_x",
      kind: "technical_plan",
      artifactIds: [],
      localPreviewUrl: null,
    } as unknown as Task;

    const result = await evaluateCompletionGate({
      task,
      companyId: "company_x",
      evidenceArtifactIds: [],
      enforceBuild: false,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.cause, "missing_evidence");
    }
  });

  it("accepts non-code tasks when evidence ids are already on the task", async () => {
    const { evaluateCompletionGate } = await import("./completion-gate.js");
    const task = {
      id: "task_y",
      kind: "technical_plan",
      artifactIds: ["artifact_already_on_task"],
      localPreviewUrl: null,
    } as unknown as Task;

    // findArtifactById will miss this id in a real DB — the gate still
    // accepts ids already listed on the task (legacy / friendly-id path).
    const result = await evaluateCompletionGate({
      task,
      companyId: "company_x",
      enforceBuild: false,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.evidenceArtifactIds, ["artifact_already_on_task"]);
    }
  });
});
