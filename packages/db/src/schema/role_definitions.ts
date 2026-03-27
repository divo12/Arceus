import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentRole, DelegationStyle, EmployeeRole } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const roleDefinitions = pgTable(
  "role_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    skillsSeed: jsonb("skills_seed").$type<string[]>().notNull().default([]),
    canDelegateTo: jsonb("can_delegate_to").$type<EmployeeRole[]>().notNull().default([]),
    delegationStyle: text("delegation_style").$type<DelegationStyle>().notNull().default("collaborative"),
    spawnRules: jsonb("spawn_rules").$type<{
      allowedAgentTypes: AgentRole[];
      maxConcurrentSpawns: number;
      spawnDepth: 1;
    }>().notNull().default({
      allowedAgentTypes: [],
      maxConcurrentSpawns: 0,
      spawnDepth: 1,
    }),
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUniqueIdx: uniqueIndex("role_definitions_company_slug_idx").on(table.companyId, table.slug),
    companyLabelIdx: index("role_definitions_company_label_idx").on(table.companyId, table.label),
  }),
);
