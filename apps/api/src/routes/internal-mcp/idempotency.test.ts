/**
 * Idempotency cache tests — spec 31 Phase 3B (DB-backed).
 *
 * Each test resets the table, then exercises the public API. The reserve-on-
 * lookup semantics mean a `miss` leaves a pending placeholder behind, so
 * tests that expect `miss` are followed by `releaseIdempotency` to keep the
 * suite hermetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashBody,
  lookupIdempotency,
  rememberIdempotency,
  releaseIdempotency,
  clearBeatIdempotency,
  __resetForTest,
} from "./idempotency.js";

const CO = "c_test";
const BEAT = "beat_1";
const KEY = "11111111-1111-4111-8111-111111111111";
const KEY_B = "22222222-2222-4222-8222-222222222222";

test("hashBody is deterministic and differs by input", () => {
  assert.equal(hashBody({ a: 1 }), hashBody({ a: 1 }));
  assert.notEqual(hashBody({ a: 1 }), hashBody({ a: 2 }));
});

test("lookupIdempotency returns miss when empty", async () => {
  await __resetForTest();
  const result = await lookupIdempotency(CO, BEAT, KEY, { any: "body" });
  assert.equal(result.kind, "miss");
});

test("remember + lookup returns hit with cached body on replay", async () => {
  await __resetForTest();
  // Reserve first (mirrors what the middleware does on the original request).
  await lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  await rememberIdempotency(CO, BEAT, KEY, { op: "create" }, {
    status: 201,
    body: { status: "success", summary: "ok" },
    locationHeader: "/api/internal/v1/tasks/tsk_1",
  });

  const hit = await lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  assert.equal(hit.kind, "hit");
  if (hit.kind !== "hit") return;
  assert.equal(hit.status, 201);
  assert.deepEqual(hit.body, { status: "success", summary: "ok" });
  assert.equal(hit.locationHeader, "/api/internal/v1/tasks/tsk_1");
});

test("same key with different body returns fail/conflict", async () => {
  await __resetForTest();
  await lookupIdempotency(CO, BEAT, KEY, { op: "create", value: 1 });
  await rememberIdempotency(CO, BEAT, KEY, { op: "create", value: 1 }, {
    status: 201,
    body: {},
  });

  const result = await lookupIdempotency(CO, BEAT, KEY, { op: "create", value: 2 });
  assert.equal(result.kind, "fail");
  if (result.kind !== "fail") return;
  assert.equal(result.reason, "conflict");
});

test("pending placeholder returns fail/in_flight on retry before finalize", async () => {
  await __resetForTest();
  // First call reserves the slot but never finalizes (simulating mid-flight).
  const first = await lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  assert.equal(first.kind, "miss");
  // Second call with same body sees the pending row.
  const second = await lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  assert.equal(second.kind, "fail");
  if (second.kind !== "fail") return;
  assert.equal(second.reason, "in_flight");
});

test("releaseIdempotency clears a pending placeholder so retries can proceed", async () => {
  await __resetForTest();
  await lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  await releaseIdempotency(CO, BEAT, KEY);
  const retry = await lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  assert.equal(retry.kind, "miss");
});

test("different keys are independent", async () => {
  await __resetForTest();
  await lookupIdempotency(CO, BEAT, KEY, { a: 1 });
  await rememberIdempotency(CO, BEAT, KEY, { a: 1 }, { status: 200, body: {} });
  const result = await lookupIdempotency(CO, BEAT, KEY_B, { a: 1 });
  assert.equal(result.kind, "miss");
});

test("clearBeatIdempotency wipes a beat's entries", async () => {
  await __resetForTest();
  await lookupIdempotency(CO, BEAT, KEY, { a: 1 });
  await rememberIdempotency(CO, BEAT, KEY, { a: 1 }, { status: 200, body: {} });
  await lookupIdempotency(CO, BEAT, KEY_B, { b: 2 });
  await rememberIdempotency(CO, BEAT, KEY_B, { b: 2 }, { status: 200, body: {} });
  await clearBeatIdempotency(CO, BEAT);

  assert.equal((await lookupIdempotency(CO, BEAT, KEY, { a: 1 })).kind, "miss");
  assert.equal((await lookupIdempotency(CO, BEAT, KEY_B, { b: 2 })).kind, "miss");
});

test("beat scope isolates entries across beats", async () => {
  await __resetForTest();
  await lookupIdempotency(CO, "beat_a", KEY, { v: 1 });
  await rememberIdempotency(CO, "beat_a", KEY, { v: 1 }, { status: 200, body: {} });
  assert.equal((await lookupIdempotency(CO, "beat_b", KEY, { v: 1 })).kind, "miss");
});
