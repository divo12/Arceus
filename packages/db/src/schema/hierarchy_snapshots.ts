import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { HierarchyStatus } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const hierarchySnapshots = pgTable(
  "hierarchy_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    status: text("status").$type<HierarchyStatus>().notNull().default("proposed"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id),
    proposedByUserId: text("proposed_by_user_id"),
    approvedByUserId: text("approved_by_user_id"),
    description: text("description"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => hierarchySnapshots.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("hierarchy_snapshots_company_status_idx").on(table.companyId, table.status),
  }),
);
