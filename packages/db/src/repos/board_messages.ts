import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { ChatMessage as ContractChatMessage } from "@arceus/contracts";
import { boardMessages } from "../schema/board_messages.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type BoardMessage = typeof boardMessages.$inferSelect;
export type NewBoardMessage = typeof boardMessages.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4E) ──────────────
export const toDbId = friendlyToUuid;

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
    cardData: (row.cardData) ?? null,
    createdAt: row.createdAt.toISOString(),
    mode: (row.mode ?? null) as ContractChatMessage["mode"],
    parentMessageId: row.parentMessageId ?? null,
    cardDecision: row.cardDecision ?? null,
    cardDecidedAt: row.cardDecidedAt?.toISOString() ?? null,
    cardDecidedBy: row.cardDecidedBy ?? null,
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
    mode: message.mode ?? null,
    parentMessageId: message.parentMessageId ? toDbId(message.parentMessageId) : null,
    cardDecision: message.cardDecision ?? null,
    cardDecidedAt: message.cardDecidedAt ? new Date(message.cardDecidedAt) : null,
    cardDecidedBy: message.cardDecidedBy ?? null,
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

// ── Spec 35 — CEO Chat 2.0 helpers ────────────────────────────────

/**
 * Atomically record a user/agent decision on a card. Returns the
 * updated row, or `null` if the card was already decided (idempotent
 * — second click is a no-op rather than an error).
 */
export async function markCardDecided(
  db: DbClient,
  cardMessageId: string,
  decision: Record<string, unknown>,
  decidedBy: string,
): Promise<BoardMessage | null> {
  const id = toDbId(cardMessageId);
  const [row] = await db
    .update(boardMessages)
    .set({
      cardDecision: decision,
      cardDecidedAt: new Date(),
      cardDecidedBy: decidedBy,
    })
    .where(
      and(
        eq(boardMessages.id, id),
        isNotNull(boardMessages.cardType),
        isNull(boardMessages.cardDecidedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Cards awaiting user action — used by the chat surface to render
 * pending interactives at the top of a session and by the CEO context
 * builder to show "still waiting on you".
 */
export async function listPendingCards(
  db: DbClient,
  companyId: string,
): Promise<BoardMessage[]> {
  return db
    .select()
    .from(boardMessages)
    .where(
      and(
        eq(boardMessages.companyId, toDbId(companyId)),
        isNotNull(boardMessages.cardType),
        isNull(boardMessages.cardDecidedAt),
      ),
    )
    .orderBy(asc(boardMessages.createdAt));
}
