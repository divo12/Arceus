/**
 * Role memory render after the per-task heartbeat took over continuity.
 *
 * The per-task heartbeat (Done/Doing/Next/Blocked) is now the single continuity
 * store, so the role-memory summary's continuity fields — currentFocus ("Focus")
 * and openBlockers ("Blockers") — are no longer rendered (they duplicated the
 * heartbeat). The role-level KNOWLEDGE field recentLearnings ("Learnings") stays.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRoleMemory } from "./beat-context-builder.js";

type Ctx = Parameters<typeof renderRoleMemory>[0];

function ctxWithMemory(mem: Record<string, unknown>): Ctx {
  return {
    roleAgent: { id: "a1", role: "developer", displayName: "Dev" },
    memorySummaries: [{ agentId: "a1", ...mem }],
  } as unknown as Ctx;
}

test("renderRoleMemory keeps Learnings but drops the continuity Focus/Blockers", () => {
  const out = renderRoleMemory(ctxWithMemory({
    currentFocus: ["shipping the auth flow"],
    recentLearnings: ["pgvector needs an index"],
    openBlockers: ["waiting on design"],
  }));
  assert.match(out, /Learnings:/);
  assert.match(out, /pgvector needs an index/);
  assert.doesNotMatch(out, /Focus:/);
  assert.doesNotMatch(out, /shipping the auth flow/);
  assert.doesNotMatch(out, /Blockers:/);
  assert.doesNotMatch(out, /waiting on design/);
});
