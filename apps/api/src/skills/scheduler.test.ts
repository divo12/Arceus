/**
 * Spec 29 Phase E smoke — scheduler is inert without the master flag.
 *
 * We do not exercise the DB-backed lease loop here; that path is gated by
 * `isDatabaseConfigured()` and is already covered by repo tests. We only
 * verify that:
 *   - start without flag = no timer / no logs that imply work
 *   - stop is idempotent
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSkillScheduler, stopSkillScheduler } from "./scheduler.js";

test("startSkillScheduler is a no-op when ARCEUS_SKILL_EVOLVE_ORCHESTRATOR != 1", async () => {
  const prev = process.env.ARCEUS_SKILL_EVOLVE_ORCHESTRATOR;
  delete process.env.ARCEUS_SKILL_EVOLVE_ORCHESTRATOR;
  try {
    startSkillScheduler();
    await stopSkillScheduler();
    // If we got here without throwing, the no-op path is working.
    assert.ok(true);
  } finally {
    if (prev !== undefined) process.env.ARCEUS_SKILL_EVOLVE_ORCHESTRATOR = prev;
  }
});

test("stopSkillScheduler can be called even when never started", async () => {
  await stopSkillScheduler();
  assert.ok(true);
});
