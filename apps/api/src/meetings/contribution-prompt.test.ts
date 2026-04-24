// Spec 28 Phase I.2 — meeting-type-aware contribution prompt builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContributionPrompt } from "./contribution-prompt.js";

const TASKS = "- [in_progress] Wire up auth";
const RESPONSE_SHAPE = "JSON: { whatIDid, whatImDoing, blockers, learnings, questionsForTeam }";

test("daily_sync prompt — concise status framing", () => {
  const out = buildContributionPrompt({ type: "daily_sync", title: "Mon Sync" }, TASKS);
  assert.match(out, /DAILY SYNC: "Mon Sync"/);
  assert.match(out, /concise status update/i);
  assert.ok(out.includes(RESPONSE_SHAPE));
  assert.ok(out.includes(TASKS));
});

test("escalation prompt — references escalation + demands directness", () => {
  const out = buildContributionPrompt(
    { type: "escalation", title: "Build broken in main" },
    TASKS,
  );
  assert.match(out, /ESCALATION meeting: "Build broken in main"/);
  assert.match(out, /Reference the escalation context/);
  assert.match(out, /direct about what you need/i);
  assert.ok(out.includes(RESPONSE_SHAPE));
});

test("eval_triggered prompt — demands citing the failing eval", () => {
  const out = buildContributionPrompt(
    { type: "eval_triggered", title: "Eval 'no_dead_routes' failed" },
    TASKS,
  );
  assert.match(out, /EVAL-FAILURE-TRIGGERED meeting: "Eval 'no_dead_routes' failed"/);
  assert.match(out, /Quote or paraphrase the failing eval/);
  assert.match(out, /failure root cause/i);
  assert.ok(out.includes(RESPONSE_SHAPE));
});

test("unknown type falls back to generic prompt", () => {
  const out = buildContributionPrompt(
    { type: "future_meeting_type" as never, title: "Mystery" },
    TASKS,
  );
  assert.match(out, /future meeting type meeting: "Mystery"/);
  assert.ok(out.includes(RESPONSE_SHAPE));
});

test("differentiation — eval and escalation prompts diverge from daily_sync", () => {
  const ds = buildContributionPrompt({ type: "daily_sync", title: "X" }, TASKS);
  const es = buildContributionPrompt({ type: "escalation", title: "X" }, TASKS);
  const ev = buildContributionPrompt({ type: "eval_triggered", title: "X" }, TASKS);
  assert.notEqual(ds, es);
  assert.notEqual(ds, ev);
  assert.notEqual(es, ev);
});
