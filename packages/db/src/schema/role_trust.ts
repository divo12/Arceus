import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, numeric, timestamp, primaryKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const roleTrust = pgTable(
  "role_trust",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    band: text("band").notNull().default("standard"),
    rollingPassRate: numeric("rolling_pass_rate", { precision: 4, scale: 3 }).notNull().default("0.500"),
    beatsInBand: integer("beats_in_band").notNull().default(0),
    lastVerdictAt: timestamp("last_verdict_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.role] }),
    bandCheck: check(
      "role_trust_band_check",
      sql`${table.band} IN ('probation','standard','senior')`,
    ),
  }),
);
