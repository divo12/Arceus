import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, bigint, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { sprints } from "./sprints.js";

export const sprintSnapshots = pgTable(
  "sprint_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintId: uuid("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    sprintNumber: integer("sprint_number").notNull(),
    gitTag: text("git_tag").notNull(),
    bundleKey: text("bundle_key"),
    bundleSha256: text("bundle_sha256"),
    bundleBytes: bigint("bundle_bytes", { mode: "number" }),
    /**
     * Spec 31 Phase 7.B.7 — frozen-at-tag CompanySnapshot blob. Restored
     * verbatim by `workspaceManager.rollbackToSprint` so a rollback
     * recovers the *state as of sprint completion*, not the current
     * state of FK-linked rows. Untyped on purpose to avoid a circular
     * @arceus/contracts dependency in @arceus/db.
     */
    snapshotData: jsonb("snapshot_data").$type<Record<string, unknown>>().notNull().default({}),
    fileManifest: jsonb("file_manifest").$type<{ path: string; sha256: string; bytes: number }[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sprint_snapshots_git_tag_idx").on(table.gitTag),
    index("sprint_snapshots_company_sprint_number_idx").on(
      table.companyId,
      table.sprintNumber,
    ),
    index("sprint_snapshots_sprint_idx").on(table.sprintId),
    check(
      "sprint_snapshots_status_check",
      sql`${table.status} IN ('active','rolled_back')`,
    )
  ],
);
