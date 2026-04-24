/**
 * Spec 29 Phase B+C — route-level smoke tests.
 *
 * Covers the behaviour we can exercise without applying the Spec 31 normalised
 * schema to the local DB:
 *   - role-allowlist enforcement (skills_lead vs ceo vs other)
 *   - input validation
 *   - skill_validate_definition pure-function path
 *
 * DB-dependent tests (register/update/deprecate/health-report/audit/history)
 * live in `revisions.test.ts` once the local DB has the normalised schema.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";

const TEST_TOKEN = "arceus-test-token-spec29";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = (role: string) => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": `beat_${role}_${Date.now()}`,
  "x-company-id": "c_spec29",
  "x-agent-role": role,
  "content-type": "application/json",
});

test("validate-definition rejects non-SL/CEO roles", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/validate-definition",
    headers: headers("developer"),
    payload: { content: "---\nname: x\nrole: developer\ntrigger: t\n---\nbody body body" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.cause, "governance");
  await app.close();
});

test("validate-definition accepts skills_lead and returns frontmatter", async () => {
  resetIdempotency();
  const app = await buildApp();
  const content = "---\nname: code-reviewer\nrole: developer\ntrigger: when reviewing PRs\n---\n" +
    "Body of at least thirty chars to avoid the warning.";
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/validate-definition",
    headers: headers("skills_lead"),
    payload: { content, intent: "register", slug: "code-reviewer-xyz" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.equal(body.data.frontmatter.name, "code-reviewer");
  assert.deepEqual(body.data.errors, []);
  await app.close();
});

test("validate-definition flags missing frontmatter fields", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/validate-definition",
    headers: headers("skills_lead"),
    payload: { content: "no frontmatter here", intent: "register" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.valid, false);
  assert.ok(body.data.errors.some((e: string) => e.includes("name")));
  await app.close();
});

test("register rejects non-skills_lead", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/register",
    headers: headers("ceo"),
    payload: {
      slug: "x",
      name: "x",
      role: "developer",
      description: "x",
      triggerCondition: "x",
      content: "---\nname: x\nrole: developer\ntrigger: x\n---\nbody",
      summary: "init",
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.cause, "governance");
  await app.close();
});

test("register validates payload before touching DB", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/register",
    headers: headers("skills_lead"),
    payload: {
      slug: "BadSlug!",
      name: "x",
      role: "developer",
      description: "x",
      triggerCondition: "x",
      content: "x",
      summary: "x",
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.cause, "validation");
  await app.close();
});

test("update with malformed body returns validation error", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/update",
    headers: headers("skills_lead"),
    payload: { skillId: "not-a-uuid", content: "x", summary: "x" },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.cause, "validation");
  await app.close();
});

test("deprecate rejects non-SL roles", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/skills/deprecate",
    headers: headers("developer"),
    payload: { skillId: "00000000-0000-0000-0000-000000000000", reason: "x", summary: "x" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.cause, "governance");
  await app.close();
});
