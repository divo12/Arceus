/**
 * Lifecycle-driven heartbeat: the checklist must auto-maintain itself on every
 * task status transition, so it reflects reality without the agent having to
 * call task_set_heartbeat. Claim → doing; block → blocked (the key case);
 * complete → a done entry with doing/blocked cleared. Pure → testable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHeartbeat, heartbeatForTransition } from "./task-heartbeat.js";

const NOW = "2026-06-16T12:00:00.000Z";
const OPTS = { title: "Build the auth API", objective: "Implement login + signup", feedback: null };

test("claim (in_progress) sets doing from the objective when empty and clears any stale blocker", () => {
  const hb = heartbeatForTransition({ ...emptyHeartbeat(), blocked: "old blocker" }, "in_progress", OPTS, NOW);
  assert.equal(hb.doing, "Implement login + signup");
  assert.equal(hb.blocked, null, "resuming clears the prior blocker");
});

test("claim keeps an existing doing rather than overwriting it", () => {
  const hb = heartbeatForTransition({ ...emptyHeartbeat(), doing: "still wiring the route" }, "in_progress", OPTS, NOW);
  assert.equal(hb.doing, "still wiring the route");
});

test("claim falls back to the title when there is no objective", () => {
  const hb = heartbeatForTransition(emptyHeartbeat(), "in_progress", { title: "Build the auth API", objective: "", feedback: null }, NOW);
  assert.equal(hb.doing, "Build the auth API");
});

test("block sets blocked from the feedback reason and preserves doing", () => {
  const hb = heartbeatForTransition({ ...emptyHeartbeat(), doing: "wiring the route" }, "blocked", { ...OPTS, feedback: "waiting on the OAuth client secret" }, NOW);
  assert.equal(hb.blocked, "waiting on the OAuth client secret");
  assert.equal(hb.doing, "wiring the route", "the in-flight work is still recorded");
});

test("block with no reason uses a sane fallback", () => {
  const hb = heartbeatForTransition(emptyHeartbeat(), "blocked", { ...OPTS, feedback: null }, NOW);
  assert.match(hb.blocked ?? "", /blocked/i);
});

test("complete appends a done entry and clears doing + blocked", () => {
  const start = heartbeatForTransition(emptyHeartbeat(), "blocked", { ...OPTS, feedback: "x" }, NOW);
  const done = heartbeatForTransition({ ...start, doing: "final touches" }, "completed", OPTS, NOW);
  assert.ok(done.done.some((d) => d.includes("Build the auth API")), "a done line records the completed task");
  assert.equal(done.doing, null);
  assert.equal(done.blocked, null);
});

test("failed appends a ✗ done entry with the reason and clears doing", () => {
  const hb = heartbeatForTransition({ ...emptyHeartbeat(), doing: "trying" }, "failed", { ...OPTS, feedback: "tests never passed" }, NOW);
  assert.ok(hb.done.some((d) => d.includes("tests never passed")));
  assert.equal(hb.doing, null);
});

test("non-lifecycle statuses (created/planned) leave the heartbeat unchanged", () => {
  const hb = { ...emptyHeartbeat(), doing: "x", next: ["y"] };
  assert.deepEqual(heartbeatForTransition(hb, "planned", OPTS, NOW), hb);
  assert.deepEqual(heartbeatForTransition(hb, "created", OPTS, NOW), hb);
});
