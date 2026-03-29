import { z } from "zod";
import { CARD_ACTION_TYPES } from "../constants.js";

export const sendChatMessageSchema = z.object({
  content: z.string().trim().min(1).max(10000),
});
export type SendChatMessage = z.infer<typeof sendChatMessageSchema>;

export const chatCardActionSchema = z.object({
  action: z.enum(CARD_ACTION_TYPES),
  editedData: z.record(z.unknown()).optional(),
});
export type ChatCardAction = z.infer<typeof chatCardActionSchema>;
