import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, bigint, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    localPath: text("local_path"),
    status: text("status").notNull().default("active"),
    latestBundleKey: text("latest_bundle_key"),
    latestBundleSha256: text("latest_bundle_sha256"),
    latestBundleBytes: bigint("latest_bundle_bytes", { mode: "number" }),
    currentSprintNumber: integer("current_sprint_number").notNull().default(0),
    currentGitRef: text("current_git_ref"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("workspaces_company_idx").on(table.companyId),
    statusCheck: check(
      "workspaces_status_check",
      sql`${table.status} IN ('active','archived','restoring')`,
    ),
  }),
);
