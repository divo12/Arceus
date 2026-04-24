// Spec 28 Phase I — beat watchdog reset route + meeting-type-aware contribution prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany } from "../../persistence/store.js";
import { getBeatActivity, resetWatchdogForTests } from "../../heartbeats/watchdog.js";

const TEST_TOKEN = "arceus-test-token-phase-i";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = () => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": "beat_phase_i",
  "x-company-id": "c_phase_i",
  "x-agent-role": "developer",
  "content-type": "application/json",
});

test("Phase I — watchdog-reset bumps lastActivityAt for a beat", async () => {
  resetIdempotency();
  resetWatchdogForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);

  const app = await buildApp();
  const before = getBeatActivity("beat_xyz_123");
  assert.equal(before, null);

  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/beats/beat_xyz_123/watchdog-reset",
    headers: headers(),
    payload: {},
  });
  assert.equal(res.statusCode, 200);

  const body = res.json() as { data: { beatId: string; lastActivityAt: string } };
  assert.equal(body.data.beatId, "beat_xyz_123");
  assert.ok(body.data.lastActivityAt);
  assert.ok(getBeatActivity("beat_xyz_123") !== null);

  await app.close();
});

test("Phase I — watchdog-reset is idempotent (always 200, always bumps)", async () => {
  resetIdempotency();
  resetWatchdogForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  const app = await buildApp();

  const r1 = await app.inject({
    method: "POST",
    url: "/api/internal/v1/beats/beat_repeat/watchdog-reset",
    headers: headers(),
    payload: {},
  });
  const t1 = getBeatActivity("beat_repeat");

  await new Promise((resolve) => setTimeout(resolve, 5));

  const r2 = await app.inject({
    method: "POST",
    url: "/api/internal/v1/beats/beat_repeat/watchdog-reset",
    headers: headers(),
    payload: {},
  });
  const t2 = getBeatActivity("beat_repeat");

  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.ok(t1 !== null && t2 !== null);
  assert.ok(t2! >= t1!);

  await app.close();
});
