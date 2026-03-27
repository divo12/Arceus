import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { HierarchyEdgeType } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { hierarchySnapshots } from "./hierarchy_snapshots.js";

export const hierarchyEdges = pgTable(
  "hierarchy_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id").notNull().references(() => hierarchySnapshots.id),
    sourceAgentId: uuid("source_agent_id").notNull().references(() => agents.id),
    targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id),
    edgeType: text("edge_type").$type<HierarchyEdgeType>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    snapshotSourceTargetTypeUniqueIdx: uniqueIndex("hierarchy_edges_snapshot_source_target_type_idx").on(
      table.snapshotId,
      table.sourceAgentId,
      table.targetAgentId,
      table.edgeType,
    ),
    snapshotEdgeTypeIdx: index("hierarchy_edges_snapshot_edge_type_idx").on(table.snapshotId, table.edgeType),
  }),
);
