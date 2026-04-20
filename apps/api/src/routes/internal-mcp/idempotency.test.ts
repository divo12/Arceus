import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashBody,
  lookupIdempotency,
  rememberIdempotency,
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

test("lookupIdempotency returns miss when empty", () => {
  __resetForTest();
  const result = lookupIdempotency(CO, BEAT, KEY, { any: "body" });
  assert.equal(result.kind, "miss");
});

test("remember + lookup returns hit with cached body on replay", () => {
  __resetForTest();
  rememberIdempotency(CO, BEAT, KEY, { op: "create" }, {
    status: 201,
    body: { status: "success", summary: "ok" },
    locationHeader: "/api/internal/v1/tasks/tsk_1",
  });

  const hit = lookupIdempotency(CO, BEAT, KEY, { op: "create" });
  assert.equal(hit.kind, "hit");
  if (hit.kind !== "hit") return;
  assert.equal(hit.status, 201);
  assert.deepEqual(hit.body, { status: "success", summary: "ok" });
  assert.equal(hit.locationHeader, "/api/internal/v1/tasks/tsk_1");
});

test("same key with different body returns conflict", () => {
  __resetForTest();
  rememberIdempotency(CO, BEAT, KEY, { op: "create", value: 1 }, {
    status: 201,
    body: {},
  });

  const result = lookupIdempotency(CO, BEAT, KEY, { op: "create", value: 2 });
  assert.equal(result.kind, "conflict");
});

test("different keys are independent", () => {
  __resetForTest();
  rememberIdempotency(CO, BEAT, KEY, { a: 1 }, { status: 200, body: {} });
  const result = lookupIdempotency(CO, BEAT, KEY_B, { a: 1 });
  assert.equal(result.kind, "miss");
});

test("clearBeatIdempotency wipes a beat's entries", () => {
  __resetForTest();
  rememberIdempotency(CO, BEAT, KEY, { a: 1 }, { status: 200, body: {} });
  rememberIdempotency(CO, BEAT, KEY_B, { b: 2 }, { status: 200, body: {} });
  clearBeatIdempotency(CO, BEAT);

  assert.equal(lookupIdempotency(CO, BEAT, KEY, { a: 1 }).kind, "miss");
  assert.equal(lookupIdempotency(CO, BEAT, KEY_B, { b: 2 }).kind, "miss");
});

test("beat scope isolates entries across beats", () => {
  __resetForTest();
  rememberIdempotency(CO, "beat_a", KEY, { v: 1 }, { status: 200, body: {} });
  assert.equal(lookupIdempotency(CO, "beat_b", KEY, { v: 1 }).kind, "miss");
});
