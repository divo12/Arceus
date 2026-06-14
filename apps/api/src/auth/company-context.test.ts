/**
 * Tests for the native-multi-tenant request-company primitives.
 *
 * Reliability contract (2026-06-14, Phase 2): a company-scoped route must
 * resolve its tenant from the request's own JWT — never from a process-global
 * "current company" pointer. companyIdOf asserts the id is present (the
 * preHandler guarantees it); requireUserAndCompany is the preHandler that
 * rejects (401 no user / 400 no company) so the global fallback can be deleted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyIdOf, requireUserAndCompany } from "./company-context.js";

test("companyIdOf returns the id when present", () => {
  assert.equal(companyIdOf({ userId: "u1", companyId: "company_x" }), "company_x");
});

test("companyIdOf throws when companyId is null (defensive — preHandler should have caught it)", () => {
  assert.throws(() => companyIdOf({ userId: "u1", companyId: null }), /company/i);
});

// Minimal fake reply that records the last code()/send() like Fastify's chainable API.
function fakeReply() {
  const state: { code: number | null; payload: unknown; sent: boolean } = { code: null, payload: null, sent: false };
  const reply = {
    sent: false,
    code(c: number) { state.code = c; return reply; },
    header() { return reply; },
    async send(p: unknown) { state.payload = p; state.sent = true; reply.sent = true; return reply; },
    _state: state,
  };
  return reply;
}

test("requireUserAndCompany rejects 401 when there is no user", async () => {
  const req = { userId: null, companyId: null, url: "/x", headers: {} } as never;
  const reply = fakeReply();
  await requireUserAndCompany(req, reply as never);
  assert.equal(reply._state.code, 401);
  assert.equal(reply._state.sent, true);
});

test("requireUserAndCompany rejects 400 when the user has no company in session", async () => {
  const req = { userId: "u1", companyId: null, url: "/x", headers: {} } as never;
  const reply = fakeReply();
  await requireUserAndCompany(req, reply as never);
  assert.equal(reply._state.code, 400);
  assert.equal(reply._state.sent, true);
});

test("requireUserAndCompany passes through (no send) when user + company are present", async () => {
  const req = { userId: "u1", companyId: "company_x", url: "/x", headers: {} } as never;
  const reply = fakeReply();
  await requireUserAndCompany(req, reply as never);
  assert.equal(reply._state.sent, false, "must not reject a fully-authenticated, company-scoped request");
});
