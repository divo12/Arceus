import { desc, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { ChatMessage as ContractChatMessage } from "@arceus/contracts";
import { boardMessages } from "../schema/board_messages.js";
import type { DbClient } from "./_helpers.js";

export type BoardMessage = typeof boardMessages.$inferSelect;
export type NewBoardMessage = typeof boardMessages.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4E) ──────────────
const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toDbId = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function createBoardMessage(
  db: DbClient,
  data: NewBoardMessage,
): Promise<BoardMessage> {
  const [row] = await db.insert(boardMessages).values(data).returning();
  return row;
}

export async function findBoardMessageById(db: DbClient, id: string): Promise<BoardMessage | null> {
  const [row] = await db.select().from(boardMessages).where(eq(boardMessages.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function listBoardMessages(
  db: DbClient,
  companyId: string,
  limit = 50,
): Promise<BoardMessage[]> {
  return db
    .select()
    .from(boardMessages)
    .where(eq(boardMessages.companyId, toDbId(companyId)))
    .orderBy(desc(boardMessages.createdAt))
    .limit(limit);
}

// ── Hydration: DB row ↔ contracts.ChatMessage (Phase 4E) ─────────

/** Pure transform from DB row to contracts.ChatMessage. */
export function rowToChatMessage(row: BoardMessage): ContractChatMessage {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: row.companyId,
    sprintId: row.sprintId,
    agentId: row.agentId,
    role: (row.role ?? "system") as ContractChatMessage["role"],
    content: row.content,
    cardType: row.cardType as ContractChatMessage["cardType"],
    cardData: (row.cardData as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the insert payload from a contracts.ChatMessage. */
export function chatMessageToInsert(message: ContractChatMessage): NewBoardMessage {
  return {
    id: toDbId(message.id),
    friendlyId: message.id,
    companyId: toDbId(message.companyId),
    sprintId: message.sprintId,
    agentId: message.agentId,
    role: message.role,
    content: message.content,
    cardType: message.cardType,
    cardData: message.cardData,
    // Legacy direction/sender stay null — contracts.ChatMessage doesn't
    // carry them. Old external-channel writers continue to fill them.
    direction: null,
    sender: null,
  };
}

/**
 * Insert-or-replace for the dual-write path. Chat messages are typically
 * append-only, but `appendChatMessage` in store.ts can re-emit the same id
 * during replay so the upsert keeps the operation idempotent.
 */
export async function upsertChatMessage(db: DbClient, message: ContractChatMessage): Promise<BoardMessage> {
  const { id, ...updateFields } = chatMessageToInsert(message);
  const [row] = await db
    .insert(boardMessages)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: boardMessages.id, set: updateFields })
    .returning();
  return row;
}

export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractChatMessage | null> {
  const row = await findBoardMessageById(db, id);
  return row ? rowToChatMessage(row) : null;
}
