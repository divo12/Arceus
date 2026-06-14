/**
 * Regression tests for the session-context tenant-resolution bug
 * (2026-06-14): a STALE same-role context (lingering from a crashed/
 * restarted/deleted-company beat) must NEVER outrank the live beat's
 * context, or it poisons req.mcp.companyId → buildSnapshotView 500 on
 * sprint_finalize.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BeatContext } from "@arceus/contracts";
import {
  registerSessionContext,
  getSessionContext,
  unregisterSessionContext,
  clearAllSessionContexts,
  findActiveSessionContextByRole,
  findSoleActiveSessionContext,
  sessionContextSize,
} from "./session-context.js";

function ctx(over: Partial<BeatContext> & { sessionId: string; companyId: string; role: BeatContext["role"] }): BeatContext {
  return {
    beatId: `beat_${over.sessionId}`,
    sprintId: null,
    trustBand: "standard",
    allowedTools: [],
    startedAt: "2026-06-14T00:00:00.000Z",
    incomingHandoffs: [],
    ...over,
  } as BeatContext;
}

test("findActiveSessionContextByRole returns the MOST-RECENT match, not the first (stale loses)", () => {
  clearAllSessionContexts();
  // Stale context from a deleted company, registered FIRST.
  registerSessionContext(ctx({ sessionId: "ses_stale", companyId: "company_deleted_hangouthq", role: "ceo" }));
  // Live beat for the current company, registered AFTER.
  registerSessionContext(ctx({ sessionId: "ses_live", companyId: "company_live_focuslist", role: "ceo" }));

  const resolved = findActiveSessionContextByRole("ceo");
  assert.equal(resolved?.companyId, "company_live_focuslist", "live beat must win over stale same-role context");
  assert.equal(resolved?.sessionId, "ses_live");
  clearAllSessionContexts();
});

test("findActiveSessionContextByRole returns undefined for an unknown role", () => {
  clearAllSessionContexts();
  registerSessionContext(ctx({ sessionId: "ses_a", companyId: "company_a", role: "developer" }));
  assert.equal(findActiveSessionContextByRole("ceo"), undefined);
  clearAllSessionContexts();
});

test("getSessionContext resolves exactly by sessionId regardless of registration order", () => {
  clearAllSessionContexts();
  registerSessionContext(ctx({ sessionId: "ses_1", companyId: "company_1", role: "ceo" }));
  registerSessionContext(ctx({ sessionId: "ses_2", companyId: "company_2", role: "ceo" }));
  assert.equal(getSessionContext("ses_1")?.companyId, "company_1");
  assert.equal(getSessionContext("ses_2")?.companyId, "company_2");
  clearAllSessionContexts();
});

test("findSoleActiveSessionContext is undefined when ambiguous (>1) — forces exact resolution", () => {
  clearAllSessionContexts();
  registerSessionContext(ctx({ sessionId: "ses_1", companyId: "company_1", role: "ceo" }));
  assert.equal(findSoleActiveSessionContext()?.companyId, "company_1");
  registerSessionContext(ctx({ sessionId: "ses_2", companyId: "company_2", role: "developer" }));
  assert.equal(findSoleActiveSessionContext(), undefined, "two contexts → ambiguous → undefined");
  clearAllSessionContexts();
});

test("unregister removes a context so a finished beat can't be resolved later", () => {
  clearAllSessionContexts();
  registerSessionContext(ctx({ sessionId: "ses_x", companyId: "company_x", role: "tester" }));
  assert.equal(sessionContextSize(), 1);
  unregisterSessionContext("ses_x");
  assert.equal(sessionContextSize(), 0);
  assert.equal(findActiveSessionContextByRole("tester"), undefined);
  clearAllSessionContexts();
});
