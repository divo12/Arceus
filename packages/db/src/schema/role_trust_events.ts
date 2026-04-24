import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const roleTrustEvents = pgTable(
  "role_trust_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    fromBand: text("from_band").notNull(),
    toBand: text("to_band").notNull(),
    reason: text("reason").notNull(),
    verdictWindow: jsonb("verdict_window").$type<Array<{ beatId: string; score: number; outcome: string }>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRoleCreatedIdx: index("role_trust_events_company_role_created_idx").on(
      table.companyId,
      table.role,
      table.createdAt,
    ),
    fromBandCheck: check(
      "role_trust_events_from_band_check",
      sql`${table.fromBand} IN ('probation','standard','senior')`,
    ),
    toBandCheck: check(
      "role_trust_events_to_band_check",
      sql`${table.toBand} IN ('probation','standard','senior')`,
    ),
  }),
);
