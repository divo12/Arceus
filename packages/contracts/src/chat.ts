/**
 * @module chat
 * Chat message schemas — the board ↔ agent communication channel.
 *
 * Messages flow between the board (human), CEO agent, and system.
 * Each message can optionally carry a typed card (strategy_proposal,
 * sprint_proposal, status_update, etc.) for structured UI rendering.
 *
 * Key types:
 * - ChatMessage — a message with optional card type and structured card data
 *
 * Audit C12 (F-031): cardData was previously
 * `z.record(z.string(), z.unknown()).nullable()` — every producer was
 * inventing its own shape and downstream UIs had to defensively check.
 * Now each cardType has a typed payload via the chatCardSchema
 * discriminated union, so a writer that emits a malformed
 * `approval_request` card without `approvalId` fails the schema at
 * the boundary instead of rendering as a broken UI element.
 */
import { z } from "zod";

export const chatMessageRoleSchema = z.enum(["board", "ceo", "agent", "system"]);
export const chatMessageCardTypeSchema = z.enum([
  "welcome_brief",
  "mission_brief",
  "strategy_proposal",
  "clarifying_question",
  "status_update",
  "sprint_proposal",
  "review_summary",
  "approval_request",
  "daily_sync_summary",
  "info"
]);

// Discriminated union of card payloads. Each variant lists the
// known fields its producer emits; passthrough is allowed so adding
// a UI-only field doesn't require a contract bump.
export const chatCardSchema = z.discriminatedUnion("cardType", [
  z.object({ cardType: z.literal("welcome_brief") }).passthrough(),
  z.object({ cardType: z.literal("mission_brief") }).passthrough(),
  z.object({
    cardType: z.literal("strategy_proposal"),
    strategyId: z.string().optional(),
    summary: z.string().optional(),
  }).passthrough(),
  z.object({
    cardType: z.literal("clarifying_question"),
    question: z.string().optional(),
  }).passthrough(),
  z.object({
    cardType: z.literal("status_update"),
    previewUrl: z.string().nullable().optional(),
    sprintNumber: z.number().int().optional(),
    phase: z.string().optional(),
  }).passthrough(),
  z.object({
    cardType: z.literal("sprint_proposal"),
    sprintNumber: z.number().int().optional(),
    sprintId: z.string().optional(),
  }).passthrough(),
  z.object({
    cardType: z.literal("review_summary"),
    sprintId: z.string().optional(),
    verdict: z.string().optional(),
  }).passthrough(),
  z.object({
    cardType: z.literal("approval_request"),
    approvalId: z.string(),
    meetingId: z.string().nullable().optional(),
    severity: z.enum(["low", "medium", "high"]).optional(),
  }).passthrough(),
  z.object({
    cardType: z.literal("daily_sync_summary"),
    meetingId: z.string(),
    date: z.string().optional(),
  }).passthrough(),
  z.object({ cardType: z.literal("info") }).passthrough(),
]);

export type ChatCard = z.infer<typeof chatCardSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintId: z.string().nullable(),
  agentId: z.string().nullable(),
  role: chatMessageRoleSchema,
  content: z.string(),
  cardType: chatMessageCardTypeSchema.nullable(),
  // cardData mirrors `chatCardSchema` minus the cardType discriminator
  // (so producers don't repeat themselves). Stored as the same Record
  // shape on the wire / DB to stay backwards-compatible with existing
  // rows; runtime validation happens via `parseChatCard` below when the
  // consumer needs the typed payload.
  cardData: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string()
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Validate `cardData` against the schema for `cardType`. Returns the
 * parsed payload on success, `null` on shape mismatch (callers should
 * fall back to a generic renderer rather than crash). Use at the
 * UI boundary or anywhere a producer's output flows back into a
 * decision path.
 */
export function parseChatCard(
  cardType: z.infer<typeof chatMessageCardTypeSchema>,
  cardData: Record<string, unknown> | null,
): ChatCard | null {
  if (cardData === null) return null;
  const parsed = chatCardSchema.safeParse({ cardType, ...cardData });
  return parsed.success ? parsed.data : null;
}
