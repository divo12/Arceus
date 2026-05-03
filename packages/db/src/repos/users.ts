import { eq } from "drizzle-orm";
import { users } from "../schema/users.js";
import type { DbClient } from "./_helpers.js";

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export async function createUser(db: DbClient, data: NewUser): Promise<User> {
  const [row] = await db.insert(users).values(data).returning();
  return row;
}

export async function findUserById(db: DbClient, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function findUserByEmail(db: DbClient, email: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}
