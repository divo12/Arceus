import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    // Spec 31 Phase 4A: id stays `uuid` to keep the existing FK type on
    // every other table that references companies. The runtime's
    // friendly `company_${randomUUID()}` strings convert to a deterministic
    // uuid via uuidv5 at the repo boundary (same trick as tasks Phase 3C);
    // the original friendly string is preserved in `friendly_id` below
    // so route reads round-trip.
    id: uuid("id").primaryKey().defaultRandom(),
    friendlyId: text("friendly_id"),
    name: text("name").notNull(),
    // Spec 31 Phase 4A: nullable until we backfill — the in-memory bootstrap
    // does not generate slugs, so dual-write would fail on the NOT NULL.
    slug: text("slug"),
    status: text("status").notNull().default("active"),
    description: text("description"),
    goal: text("goal"),
    // Spec 31 Phase 4A: contracts.Company has `boardOwner` (display name),
    // not an email. Renamed nullable; an email-typed column lives separately
    // for future SES/email integration. Original was NOT NULL email.
    boardOwner: text("board_owner"),
    boardOwnerEmail: text("board_owner_email"),

    // Spec 31 Phase 4A: nullable + auto-derived default during bridge.
    // Real prefixes ("ARC-1", "ARC-2"…) are assigned by the task creation
    // path; bootstrap doesn't know one yet.
    taskPrefix: text("task_prefix"),
    taskCounter: integer("task_counter").notNull().default(0),

    // Spec 31 Phase 4A: contracts.Company carries the all-time budget
    // (`budgetCents`/`spentCents`); the existing `budget_monthly_cents`
    // columns model a periodic reset that the runtime doesn't use yet.
    // Both kept — the new columns are the source of truth for the route
    // surface; the monthly columns stay for future periodic reset support.
    budgetCents: integer("budget_cents").notNull().default(0),
    spentCents: integer("spent_cents").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    budgetResetAt: timestamp("budget_reset_at", { withTimezone: true }),

    // Spec 31 Phase 4A: contracts.Company tracks the active strategy +
    // sprint via dedicated FKs (text — same boundary handling as tasks).
    // No FK constraint declared yet because strategies/sprints aren't
    // dual-written either (Phase 4B+).
    currentStrategyId: text("current_strategy_id"),
    currentSprintId: text("current_sprint_id"),
    currentSprintNumber: integer("current_sprint_number"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Slug index becomes a non-unique partial index on non-null values —
    // most rows will have null slug during the bridge.
    slugIdx: index("companies_slug_idx").on(table.slug).where(sql`${table.slug} IS NOT NULL`),
    taskPrefixIdx: index("companies_task_prefix_idx").on(table.taskPrefix).where(sql`${table.taskPrefix} IS NOT NULL`),
    // Spec 31 Phase 4A: friendly_id is the public-facing string id
    // (`company_xxx`); used by the route layer to look up via the same
    // boundary uuidv5 deterministic encoding the rest of the repos use.
    friendlyIdIdx: uniqueIndex("companies_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    statusIdx: index("companies_status_idx").on(table.status),
    // Spec 31 Phase 4A: include 'ideation' to match contracts.companyStatusSchema.
    // Bootstrap inserts at `ideation`; flips to `active` after strategy
    // approval. Removing it here would reject every newly-bootstrapped row.
    statusCheck: check(
      "companies_status_check",
      sql`${table.status} IN ('ideation','active','paused','archived')`,
    ),
  }),
);
