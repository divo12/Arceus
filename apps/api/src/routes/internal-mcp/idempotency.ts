import { createHash } from "node:crypto";

interface CachedEntry {
  bodyHash: string;
  status: number;
  body: unknown;
  locationHeader: string | null;
  createdAt: number;
}

const KEY_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const store = new Map<string, CachedEntry>();

const compositeKey = (companyId: string, beatId: string, idempotencyKey: string): string =>
  `${companyId}::${beatId}::${idempotencyKey}`;

export const hashBody = (body: unknown): string =>
  createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");

const gc = (): void => {
  if (store.size < MAX_ENTRIES) return;
  const cutoff = Date.now() - KEY_TTL_MS;
  for (const [key, entry] of store) {
    if (entry.createdAt < cutoff) store.delete(key);
  }
};

export type IdempotencyLookup =
  | { kind: "miss" }
  | { kind: "hit"; status: number; body: unknown; locationHeader: string | null }
  | { kind: "conflict" };

export const lookupIdempotency = (
  companyId: string,
  beatId: string,
  idempotencyKey: string,
  body: unknown
): IdempotencyLookup => {
  const cached = store.get(compositeKey(companyId, beatId, idempotencyKey));
  if (!cached) return { kind: "miss" };
  if (cached.bodyHash !== hashBody(body)) return { kind: "conflict" };
  return {
    kind: "hit",
    status: cached.status,
    body: cached.body,
    locationHeader: cached.locationHeader
  };
};

export const rememberIdempotency = (
  companyId: string,
  beatId: string,
  idempotencyKey: string,
  body: unknown,
  response: { status: number; body: unknown; locationHeader?: string | null }
): void => {
  gc();
  store.set(compositeKey(companyId, beatId, idempotencyKey), {
    bodyHash: hashBody(body),
    status: response.status,
    body: response.body,
    locationHeader: response.locationHeader ?? null,
    createdAt: Date.now()
  });
};

export const clearBeatIdempotency = (companyId: string, beatId: string): void => {
  const prefix = `${companyId}::${beatId}::`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
};

export const __resetForTest = (): void => {
  store.clear();
};
