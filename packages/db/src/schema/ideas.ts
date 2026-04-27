import { pgTable, uuid, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * `public.ideas` — one row per company. Captures the founder's core
 * idea + the board-refined direction. Spec 31 Phase 7.A — replaces
 * `snapshot.idea` from the in-memory store.
 *
 * `unique(company_id)` enforces "one idea per company"; the row is
 * created at company bootstrap and updated when the board refines
 * the direction.
 */
export const ideas = pgTable(
  "ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Spec 31 Phase 5: friendly id round-trip ("idea_<uuid>"). */
    friendlyId: text("friendly_id"),
    coreIdea: text("core_idea").notNull(),
    currentDirection: text("current_direction").notNull().default(""),
    refinedWithBoard: boolean("refined_with_board").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("ideas_company_unique_idx").on(table.companyId),
  }),
);
