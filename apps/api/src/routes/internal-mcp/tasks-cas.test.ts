/**
 * Phase 3C — DB-backed CAS claim end-to-end via the route.
 *
 * Seeds a real company + heartbeat run + task in Postgres, then fires N
 * parallel `POST /tasks/:id/claim` requests. The CAS partial-unique index
 * on `tasks.checkout_run_id` guarantees exactly one winner, regardless
 * of how many concurrent requests arrive.
 *
 * Needs DATABASE_URL pointing at a migrated Postgres (spec 31 Phase 3A).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { v5 as uuidv5 } from "uuid";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany } from "../../persistence/store.js";
import { getDb } from "@arceus/db";
import { companies } from "@arceus/db/src/schema/companies.js";
import { agents } from "@arceus/db/src/schema/agents.js";
import { heartbeatRuns } from "@arceus/db/src/schema/heartbeat_runs.js";
import { tasks } from "@arceus/db/src/schema/tasks.js";
import { eq } from "drizzle-orm";

const TEST_TOKEN = "arceus-test-token-cas";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

// Same namespace as the repo helper — keeps friendly→uuid stable across runs.
const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
const toDbId = (s: string) => uuidv5(s, ARCEUS_UUID_NS);

const COMPANY = "c_cas_test";
const BEAT = "beat_cas_test";
const TASK = "tsk_cas_target";

async function seedDbFixtures() {
  const db = getDb();
  // Wipe anything from a prior run in this scope only — and any leftover rows
  // pointing at our target task id from sibling test files (they cascade-delete
  // through company_id, but the CAS task is keyed by friendly id which other
  // suites don't touch, so an explicit delete keeps us hermetic).
  await db.delete(tasks).where(eq(tasks.id, toDbId(TASK)));
  await db.delete(companies).where(eq(companies.id, toDbId(COMPANY)));

  await db.insert(companies).values({
    id: toDbId(COMPANY),
    name: "CAS Co",
    slug: `cas-${Date.now()}`,
    boardOwnerEmail: "board@cas.com",
    taskPrefix: "CAS",
  });

  const [agent] = await db
    .insert(agents)
    .values({
      companyId: toDbId(COMPANY),
      role: "developer",
      displayName: "Dev",
      soulPromptRef: "test",
    })
    .returning({ id: agents.id });

  await db.insert(heartbeatRuns).values({
    id: toDbId(BEAT),
    companyId: toDbId(COMPANY),
    agentId: agent.id,
    beatNumber: 1,
    trigger: "manual",
  });
}

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": BEAT,
  "x-company-id": COMPANY,
  "x-agent-role": "developer",
  "content-type": "application/json",
  ...extra,
});

test("POST /tasks/:id/claim — 20 parallel claims yield exactly one winner (CAS)", async () => {
  await resetIdempotency();
  await seedDbFixtures();
  bootstrapCompany({ companyName: "CAS Co", industry: "tech", goals: "g", founderVision: "v" } as never);

  const app = await buildApp();

  // Create the task via the route. Phase 3C dual-write puts it in both store + DB.
  const create = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: headers({ "idempotency-key": `cas-create-${Date.now()}` }),
    payload: { id: TASK, title: "Race target", assignedRole: "developer" },
  });
  assert.equal(create.statusCode, 201, `create failed: ${create.body}`);

  // 20 parallel claims with distinct idempotency keys (otherwise the DB-backed
  // idempotency cache would collapse them to one before CAS even runs).
  const attempts = Array.from({ length: 20 }, (_, i) =>
    app.inject({
      method: "POST",
      url: `/api/internal/v1/tasks/${TASK}/claim`,
      headers: headers({ "idempotency-key": `cas-claim-${i}-${Date.now()}` }),
      payload: { reason: `attempt ${i}` },
    }),
  );
  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.statusCode === 200);
  const conflicts = results.filter((r) => r.statusCode === 409);

  assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
  assert.equal(conflicts.length, 19, `expected 19 conflicts, got ${conflicts.length}`);

  // Every loser should report task_not_claimable (the typed CAS dispatch),
  // not a generic 409.
  for (const res of conflicts) {
    const body = res.json();
    assert.equal(body.error.cause, "task_not_claimable");
  }

  // DB row reflects exactly one winning checkout_run_id.
  const db = getDb();
  const [row] = await db.select().from(tasks).where(eq(tasks.id, toDbId(TASK)));
  assert.equal(row.status, "in_progress");
  assert.equal(row.checkoutRunId, toDbId(BEAT));

  await app.close();
});
