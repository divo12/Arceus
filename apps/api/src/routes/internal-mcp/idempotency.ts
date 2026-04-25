/**
 * Idempotency replay cache — spec 31 Phase 3B.
 *
 * Keys derived by `deriveIdempotencyKey(beatId, op, body)` (spec 25 §3.4) are
 * stable across retries: same logical request → same key. This module decides
 * whether a request is a fresh call, a replay of a finalized response, an
 * in-flight duplicate, or a hash conflict.
 *
 * Storage is the `idempotency_keys` table (spec 31). The composite caller
 * scope `(companyId, beatId, idempotencyKey)` is folded into the row's `key`
 * primary key so concurrent calls collapse atomically via INSERT ON CONFLICT.
 *
 * Phase 3B replaces the previous in-memory `Map` so retries survive server
 * restarts and survive across processes when we scale horizontally.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@arceus/db";
import { idempotencyKeys } from "@arceus/db/src/schema/idempotency_keys.js";
import {
  reserveOrGetStored,
  finalizeStored,
  releaseStored,
} from "@arceus/db/src/repos/idempotency_keys.js";
import type { ErrorCause, RetrySafety } from "./envelope.js";

const db = () => getDb();

const compositeKey = (companyId: string, beatId: string, idempotencyKey: string): string =>
  `${companyId}::${beatId}::${idempotencyKey}`;

export const hashBody = (body: unknown): string =>
  createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");

interface StoredResponseShape {
  body?: unknown;
  locationHeader?: string | null;
  pending?: boolean;
}

/**
 * Single source of truth for "what should the API return when an idempotency
 * lookup ends in failure". Adding a new failure variant means adding a key
 * here — TypeScript will then force every consumer (middleware, tests) to
 * handle it. No literal strings duplicated at call sites.
 */
export interface IdempotencyFailureSpec {
  cause: ErrorCause;
  summary: string;
  retry: RetrySafety;
  stopWhen: string;
  /** Headers to set on the failure response (e.g. retry-after). */
  extraHeaders?: Readonly<Record<string, string>>;
}

// `extraHeaders` is declared on every entry (even as undefined) so the
// narrowed `as const` type still has the property — otherwise consumers
// can't read `spec.extraHeaders` without re-asserting the wider interface.
export const IDEMPOTENCY_FAILURES = {
  conflict: {
    cause: "conflict",
    summary: "Idempotency-Key replayed with a different body.",
    retry: "never",
    stopWhen: "generate_new_key",
    extraHeaders: undefined,
  },
  in_flight: {
    cause: "in_flight",
    summary: "Idempotency-Key request still in-flight; retry shortly.",
    retry: "safe",
    stopWhen: "previous_request_finalized",
    extraHeaders: { "retry-after": "1" },
  },
} as const satisfies Record<string, IdempotencyFailureSpec>;

export type IdempotencyFailureKind = keyof typeof IDEMPOTENCY_FAILURES;

export type IdempotencyLookup =
  | { kind: "miss" }
  | { kind: "hit"; status: number; body: unknown; locationHeader: string | null }
  | { kind: "fail"; reason: IdempotencyFailureKind };

/**
 * Atomically reserve a key (if absent) or return the previously-stored response.
 * On `miss`, a `{pending: true}` placeholder is now in the table — the caller
 * must call `rememberIdempotency` (success) or `releaseIdempotency` (error) to
 * finalize/release the slot.
 */
export async function lookupIdempotency(
  companyId: string,
  beatId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<IdempotencyLookup> {
  const key = compositeKey(companyId, beatId, idempotencyKey);
  const requestHash = hashBody(body);
  const stored = await reserveOrGetStored(db(), key, requestHash);

  if (stored === null) {
    return { kind: "miss" };
  }

  if (stored.requestHash !== requestHash) {
    return { kind: "fail", reason: "conflict" };
  }

  const response = stored.response as StoredResponseShape;
  if (response.pending === true) {
    return { kind: "fail", reason: "in_flight" };
  }

  return {
    kind: "hit",
    status: stored.statusCode,
    body: response.body ?? null,
    locationHeader: response.locationHeader ?? null,
  };
}

/**
 * Persist the final response for a previously-reserved key.
 *
 * The `body` parameter is unused — the request hash was captured at reserve
 * time — but kept on the signature so callers don't need to re-hash.
 */
export async function rememberIdempotency(
  companyId: string,
  beatId: string,
  idempotencyKey: string,
  _body: unknown,
  response: { status: number; body: unknown; locationHeader?: string | null },
): Promise<void> {
  const key = compositeKey(companyId, beatId, idempotencyKey);
  await finalizeStored(
    db(),
    key,
    { body: response.body, locationHeader: response.locationHeader ?? null },
    response.status,
  );
}

/**
 * Drop a placeholder reserved by a route handler that errored before
 * `rememberIdempotency` ran. Lets the next retry of the same content-addressed
 * key try fresh instead of waiting for the 5-minute pending TTL.
 */
export async function releaseIdempotency(
  companyId: string,
  beatId: string,
  idempotencyKey: string,
): Promise<void> {
  const key = compositeKey(companyId, beatId, idempotencyKey);
  await releaseStored(db(), key);
}

/** Wipe every key under a beat — called on beat completion to free placeholders. */
export async function clearBeatIdempotency(companyId: string, beatId: string): Promise<void> {
  const prefix = `${companyId}::${beatId}::`;
  await db()
    .delete(idempotencyKeys)
    .where(sql`${idempotencyKeys.key} LIKE ${prefix + "%"}`);
}

/** Test-only: drop every row. */
export async function __resetForTest(): Promise<void> {
  await db().delete(idempotencyKeys);
}
