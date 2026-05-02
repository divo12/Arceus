import { sql } from "drizzle-orm";
import { type AnyPgColumn, pgTable, uuid, text, boolean, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * `public.agents` — full agent identity.
 *
 * Spec 31 Phase 7.A extended this table to hold the fields the
 * in-memory `snapshot.agents` previously carried (`title`,
 * `manager_agent_id`, `report_agent_ids`, `capabilities`, `profile`,
 * `soul`, `status`, `last_heartbeat_at`). Mirrors paperclip's
 * `agents` shape — paperclip keeps these on the main table; volatile
 * adapter session state lives in a separate `agent_runtime_state`
 * table that Arceus doesn't need yet.
 *
 * `display_name` continues to serve as the agent's `name` in the
 * domain contract — no separate `name` column was added.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Spec 31 Phase 5: friendly id round-trip carrier ("agent_${role}_${uuid}").
    friendlyId: text("friendly_id"),
    role: text("role").notNull(),
    displayName: text("display_name").notNull(),
    /** Spec 31 Phase 7.A — role title from the strategy ("Chief Engineer"). */
    title: text("title").notNull().default(""),
    /** Spec 31 Phase 7.A — short profile blurb shown in prompts + UI. */
    profile: text("profile").notNull().default(""),
    /** Spec 31 Phase 7.A — capabilities the agent advertises. */
    capabilities: text("capabilities").array().notNull().default(sql`ARRAY[]::text[]`),
    // Spec 31 Phase 5: runtime stores inline soul prompts via roleSoul, not a ref.
    // Kept nullable for forward-compat with future ref-based agents.
    soulPromptRef: text("soul_prompt_ref"),
    /**
     * Spec 31 Phase 7.A — full role-soul object (loaded from the
     * `soul_prompt_ref` at hire time and cached here so prompt
     * assembly doesn't re-read disk). Empty object means "use the
     * default role soul from `@arceus/company-runtime`".
     */
    soul: jsonb("soul").$type<Record<string, unknown>>().notNull().default({}),
    /** Reporting tree pointer; null for the root (CEO). */
    managerAgentId: uuid("manager_agent_id").references((): AnyPgColumn => agents.id, { onDelete: "set null" }),
    /** Cached children — denormalised for fast org-chart reads. */
    reportAgentIds: uuid("report_agent_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    /** Spec 31 Phase 7.A — runtime status ('active','idle','paused',…). */
    status: text("status").notNull().default("idle"),
    /** Spec 31 Phase 7.A — set by every beat the agent participates in. */
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_company_role_idx").on(table.companyId, table.role),
    index("agents_company_is_internal_idx").on(table.companyId, table.isInternal),
    index("agents_company_status_idx").on(table.companyId, table.status),
    index("agents_manager_agent_idx").on(table.managerAgentId),
    uniqueIndex("agents_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    check(
      "agents_role_check",
      sql`${table.role} IN ('ceo','cto','pm','developer','senior_developer','tester','ui_designer','marketing','skills_lead') OR ${table.isInternal} = true`,
    )
  ],
);
