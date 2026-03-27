import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  integer,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentKind, DelegationStyle } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { roleDefinitions } from "./role_definitions.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    roleDefinitionId: uuid("role_definition_id").references(() => roleDefinitions.id),
    delegationStyle: text("delegation_style").$type<DelegationStyle>().notNull().default("collaborative"),
    kind: text("kind").$type<AgentKind>().notNull().default("employee"),
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    spawnedByAgentId: uuid("spawned_by_agent_id").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyKindIdx: index("agents_company_kind_idx").on(table.companyId, table.kind),
    companySpawnedByIdx: index("agents_company_spawned_by_idx").on(table.companyId, table.spawnedByAgentId),
    companyRoleDefinitionIdx: index("agents_company_role_definition_idx").on(table.companyId, table.roleDefinitionId),
  }),
);
