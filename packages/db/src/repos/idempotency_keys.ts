import { eq, lt, sql } from "drizzle-orm";
import { idempotencyKeys } from "../schema/idempotency_keys.js";
import type { DbClient } from "./_helpers.js";

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

/** 24 hour default TTL for stored responses. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Attempt to reserve an idempotency key. Returns the stored response if the key was already
 * used with a matching request hash; otherwise returns null (caller proceeds with real work).
 *
 * Always INSERT ... ON CONFLICT DO NOTHING so concurrent calls collapse to one winner.
 */
export async function reserveOrGetStored(
  db: DbClient,
  key: string,
  requestHash: string,
): Promise<IdempotencyKey | null> {
  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      key,
      requestHash,
      response: { pending: true },
      statusCode: 0,
      expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 1 && (inserted[0].response as { pending?: boolean }).pending !== undefined) {
    // We won the race; caller should proceed and then call finalizeStored.
    return null;
  }

  // Someone else already holds the key — return the stored response, which may still be pending.
  const [existing] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1);
  return existing ?? null;
}

/** Record the final response body + status code for a previously-reserved key. */
export async function finalizeStored(
  db: DbClient,
  key: string,
  response: Record<string, unknown>,
  statusCode: number,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ response, statusCode })
    .where(eq(idempotencyKeys.key, key));
}

/** TTL sweep — called from a cron-style worker to prune expired keys. */
export async function sweepExpired(db: DbClient): Promise<number> {
  const result = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, sql`now()`))
    .returning({ key: idempotencyKeys.key });
  return result.length;
}
