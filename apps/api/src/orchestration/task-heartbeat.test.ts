/**
 * Per-task heartbeat checklist (pure core).
 *
 * Replaces the append-only planSteps trail: a living Done/Doing/Next/Blocked the
 * agent rewrites at beat end and reads on claim, so a multi-beat or blocked task
 * resumes instead of restarting amnesiac. `done` accumulates (a growing log);
 * `doing`/`next`/`blocked` are the current snapshot and get replaced. Pure → no
 * DB/LLM, so the merge + render rules are pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyHeartbeat,
  applyHeartbeatUpdate,
  renderHeartbeat,
} from "./task-heartbeat.js";

const NOW = "2026-06-16T12:00:00.000Z";

test("emptyHeartbeat is blank", () => {
  assert.deepEqual(emptyHeartbeat(), { done: [], doing: null, next: [], blocked: null, updatedAt: null });
});

test("applyHeartbeatUpdate accumulates done and replaces doing/next/blocked", () => {
  const a = applyHeartbeatUpdate(emptyHeartbeat(), { done: ["wrote schema"], doing: "wiring the route", next: ["tests"], blocked: null }, NOW);
  assert.deepEqual(a.done, ["wrote schema"]);
  assert.equal(a.doing, "wiring the route");
  assert.deepEqual(a.next, ["tests"]);
  assert.equal(a.blocked, null);
  assert.equal(a.updatedAt, NOW);

  const b = applyHeartbeatUpdate(a, { done: ["wired the route"], doing: "writing tests", next: ["deploy"] }, NOW);
  assert.deepEqual(b.done, ["wrote schema", "wired the route"], "done accumulates across beats");
  assert.equal(b.doing, "writing tests", "doing is replaced");
  assert.deepEqual(b.next, ["deploy"], "next is replaced");
});

test("omitted fields are preserved (partial update)", () => {
  const a = applyHeartbeatUpdate(emptyHeartbeat(), { doing: "x", next: ["y"] }, NOW);
  const b = applyHeartbeatUpdate(a, { blocked: "waiting on API key" }, NOW);
  assert.equal(b.doing, "x");
  assert.deepEqual(b.next, ["y"]);
  assert.equal(b.blocked, "waiting on API key");
});

test("trims, drops blank entries, and normalizes empty doing/blocked to null", () => {
  const a = applyHeartbeatUpdate(emptyHeartbeat(), { done: ["  ok  ", "", "   "], doing: "   ", next: ["a", "  "], blocked: "" }, NOW);
  assert.deepEqual(a.done, ["ok"]);
  assert.equal(a.doing, null);
  assert.deepEqual(a.next, ["a"]);
  assert.equal(a.blocked, null);
});

test("dedupes accumulated done and caps its length to the last 10", () => {
  let hb = emptyHeartbeat();
  hb = applyHeartbeatUpdate(hb, { done: ["step"] }, NOW);
  hb = applyHeartbeatUpdate(hb, { done: ["step"] }, NOW); // duplicate
  assert.deepEqual(hb.done, ["step"], "duplicate done entries collapse");

  let big = emptyHeartbeat();
  for (let i = 0; i < 14; i++) big = applyHeartbeatUpdate(big, { done: [`s${i}`] }, NOW);
  assert.equal(big.done.length, 10);
  assert.equal(big.done[0], "s4", "oldest done entries fall off");
  assert.equal(big.done.at(-1), "s13");
});

test("renderHeartbeat returns empty string for a blank checklist", () => {
  assert.equal(renderHeartbeat(emptyHeartbeat()), "");
});

test("renderHeartbeat shows only the non-empty sections as markdown", () => {
  const hb = applyHeartbeatUpdate(emptyHeartbeat(), { done: ["schema"], doing: "the route", next: ["tests", "deploy"], blocked: "API key" }, NOW);
  const md = renderHeartbeat(hb);
  assert.match(md, /Done/);
  assert.match(md, /schema/);
  assert.match(md, /Doing/);
  assert.match(md, /the route/);
  assert.match(md, /Next/);
  assert.match(md, /tests/);
  assert.match(md, /Blocked/);
  assert.match(md, /API key/);

  // A checklist with only `doing` set must not emit Done/Next/Blocked headers.
  const onlyDoing = renderHeartbeat(applyHeartbeatUpdate(emptyHeartbeat(), { doing: "x" }, NOW));
  assert.match(onlyDoing, /Doing/);
  assert.doesNotMatch(onlyDoing, /Blocked/);
  assert.doesNotMatch(onlyDoing, /Done/);
});
