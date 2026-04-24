import { desc, eq } from "drizzle-orm";
import { boardMessages } from "../schema/board_messages.js";
import type { DbClient } from "./_helpers.js";

export type BoardMessage = typeof boardMessages.$inferSelect;
export type NewBoardMessage = typeof boardMessages.$inferInsert;

export async function createBoardMessage(
  db: DbClient,
  data: NewBoardMessage,
): Promise<BoardMessage> {
  const [row] = await db.insert(boardMessages).values(data).returning();
  return row;
}

export async function listBoardMessages(
  db: DbClient,
  companyId: string,
  limit = 50,
): Promise<BoardMessage[]> {
  return db
    .select()
    .from(boardMessages)
    .where(eq(boardMessages.companyId, companyId))
    .orderBy(desc(boardMessages.createdAt))
    .limit(limit);
}
