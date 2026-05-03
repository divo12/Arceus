import { eq } from "drizzle-orm";
import { sessionBindings } from "../schema/session_bindings.js";
import type { DbClient } from "./_helpers.js";

export type SessionBinding = typeof sessionBindings.$inferSelect;
export type NewSessionBinding = typeof sessionBindings.$inferInsert;

export async function createBinding(
  db: DbClient,
  data: NewSessionBinding,
): Promise<SessionBinding> {
  const [row] = await db.insert(sessionBindings).values(data).returning();
  return row;
}

/** Insert-or-replace by session_id — idempotent path for runBeat dual-write. */
export async function upsertBindingBySession(
  db: DbClient,
  data: NewSessionBinding,
): Promise<SessionBinding> {
  const { sessionId, ...rest } = data;
  const [row] = await db
    .insert(sessionBindings)
    .values({ sessionId, ...rest })
    .onConflictDoUpdate({
      target: sessionBindings.sessionId,
      set: {
        companyId: rest.companyId,
        beatId: rest.beatId,
        role: rest.role,
        trustBand: rest.trustBand,
        allowedTools: rest.allowedTools,
        endedAt: null,
      },
    })
    .returning();
  return row;
}

export async function findBindingBySession(
  db: DbClient,
  sessionId: string,
): Promise<SessionBinding | null> {
  const [row] = await db
    .select()
    .from(sessionBindings)
    .where(eq(sessionBindings.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function endBinding(db: DbClient, sessionId: string): Promise<SessionBinding | null> {
  const [row] = await db
    .update(sessionBindings)
    .set({ endedAt: new Date() })
    .where(eq(sessionBindings.sessionId, sessionId))
    .returning();
  return row ?? null;
}

/**
 * Spec 31 Phase 7.A — list every binding for a company. Used by the
 * snapshot-replacement path that previously read `snapshot.sessions`.
 * Includes ended bindings; callers filter on `endedAt IS NULL` if
 * they only want active sessions.
 */
export async function listByCompany(db: DbClient, companyId: string): Promise<SessionBinding[]> {
  return db.select().from(sessionBindings).where(eq(sessionBindings.companyId, companyId));
}
