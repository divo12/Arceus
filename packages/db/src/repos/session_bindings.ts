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
