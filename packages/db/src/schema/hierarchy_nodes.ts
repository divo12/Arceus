import { sql } from "drizzle-orm";
import { type AnyPgColumn, pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * `public.hierarchy_nodes` — the org chart per company. Each node
 * represents one role in the company's reporting tree.
 * `parent_node_id` is a self-FK forming the tree; `agent_id` is the
 * agent currently assigned to that role (null when the seat is
 * open). Spec 31 Phase 7.A — replaces `snapshot.hierarchy`.
 */
export const hierarchyNodes = pgTable(
  "hierarchy_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Spec 31 Phase 5: friendly id round-trip ("node_<uuid>"). */
    friendlyId: text("friendly_id"),
    role: text("role").notNull(),
    title: text("title").notNull(),
    /** Depth from CEO (0 = CEO). Populated after the tree is built. */
    level: integer("level").notNull().default(0),
    parentNodeId: uuid("parent_node_id").references((): AnyPgColumn => hierarchyNodes.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /**
     * Cached children — denormalised for fast tree-walk reads. Kept
     * in sync by the workflow that builds/updates the hierarchy.
     */
    directReportNodeIds: uuid("direct_report_node_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    openForHiring: boolean("open_for_hiring").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("hierarchy_nodes_company_parent_idx").on(table.companyId, table.parentNodeId),
    index("hierarchy_nodes_company_role_idx").on(table.companyId, table.role),
    index("hierarchy_nodes_agent_idx").on(table.agentId)
  ],
);
