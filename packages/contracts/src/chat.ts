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

export const chatMessageSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintId: z.string().nullable(),
  agentId: z.string().nullable(),
  role: chatMessageRoleSchema,
  content: z.string(),
  cardType: chatMessageCardTypeSchema.nullable(),
  cardData: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string()
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
