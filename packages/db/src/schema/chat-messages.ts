import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    cardType: text("card_type"),
    cardData: jsonb("card_data"),
    cardState: jsonb("card_state"),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("chat_messages_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
