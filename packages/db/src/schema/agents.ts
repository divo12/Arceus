import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    displayName: text("display_name").notNull(),
    soulPromptRef: text("soul_prompt_ref").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRoleUniqueIdx: uniqueIndex("agents_company_role_idx").on(table.companyId, table.role),
    companyIsInternalIdx: index("agents_company_is_internal_idx").on(table.companyId, table.isInternal),
    roleCheck: check(
      "agents_role_check",
      sql`${table.role} IN ('ceo','cto','pm','developer','tester','ui_designer','marketing','skills_lead') OR ${table.isInternal} = true`,
    ),
  }),
);
