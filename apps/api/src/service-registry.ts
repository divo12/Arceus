/**
 * Service Registry — Spec 11 Phase 3
 *
 * Declarative inventory of every tool available in the system,
 * scoped per-company and per-role. OpenCode tools are discovered
 * dynamically from the SDK at bootstrap time. Persisted to Postgres
 * when DB is available.
 *
 * Today this is read-only metadata. Spec 13 (Governance Gateway)
 * will query this at runtime to intercept/approve tool calls.
 * Spec 14 (Self-Evolution) will use registerTool() to add
 * skill-evolved tools.
 */

import { randomUUID } from "node:crypto";
import type { ServiceRegistryEntry, BlastRadius, ToolParameter, RoleSoul } from "@arceus/contracts";
import { ROLE_SOULS } from "@arceus/company-runtime";
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { serviceRegistryTable } from "@arceus/db";
import { eq } from "drizzle-orm";
import { audit } from "./audit-ledger";
import { getOpencode } from "./opencode";
import { runtimeConfig, ensureDeployment } from "./config/index";

// ── In-memory registry ─────────────────────────────────────

/** companyId → toolName → entry */
const registry = new Map<string, Map<string, ServiceRegistryEntry>>();

function getCompanyRegistry(companyId: string): Map<string, ServiceRegistryEntry> {
  let co = registry.get(companyId);
  if (!co) {
    co = new Map();
    registry.set(companyId, co);
  }
  return co;
}

// ── OpenCode tool discovery ────────────────────────────────
// Tools are fetched from the running OpenCode SDK at seed time.
// Role assignments and blast-radius are classified by tool name
// patterns since the SDK doesn't know about Arceus roles.

type ToolSeed = {
  toolName: string;
  description: string;
  blastRadius: BlastRadius;
  requiresApproval: boolean;
  source: "opencode" | "arceus" | "skill";
  parameters: ToolParameter[];
  /** Roles that are allowed to invoke this tool */
  allowedRoles: RoleSoul["role"][];
};

/** Classify blast radius based on what the tool can do. */
function classifyBlastRadius(toolName: string): BlastRadius {
  const mutating = ["bash", "write", "edit", "apply_patch", "patch"];
  const destructive = ["delete", "rm", "drop"];
  const lower = toolName.toLowerCase();
  if (destructive.some((d) => lower.includes(d))) return "red";
  if (mutating.some((m) => lower === m || lower.includes(m))) return "yellow";
  return "green";
}

/** Determine which Arceus roles may use a tool based on its nature. */
function classifyAllowedRoles(toolName: string): RoleSoul["role"][] {
  const lower = toolName.toLowerCase();
  // Read-only tools: broad access
  if (["read", "glob", "grep", "find", "search", "list", "ls"].some((t) => lower === t || lower.startsWith(t))) {
    return ["cto", "developer", "tester", "ui_designer", "skills_lead", "pm"];
  }
  // Shell execution: technical roles only
  if (lower === "bash" || lower === "shell" || lower === "exec") {
    return ["cto", "developer", "tester", "skills_lead"];
  }
  // Heavy mutation (patch): senior technical
  if (lower === "apply_patch" || lower === "patch") {
    return ["cto", "developer", "skills_lead"];
  }
  // Write/edit tools: anyone who writes code or content
  if (["write", "edit", "create", "update", "modify"].some((t) => lower === t || lower.startsWith(t))) {
    return ["cto", "developer", "tester", "ui_designer", "marketing", "skills_lead"];
  }
  // Default: technical roles
  return ["cto", "developer", "tester", "skills_lead"];
}

/**
 * Discover OpenCode tools from the running SDK.
 * Falls back to an empty list if the server is unreachable.
 */
async function fetchOpencodeTools(): Promise<ToolSeed[]> {
  try {
    const opencode = await getOpencode();

    // Try the rich tool list endpoint first (includes descriptions + parameters)
    const workerDeployment = ensureDeployment("workerDeployment");
    const result = await opencode.client.tool.list({
      query: { provider: "azure", model: workerDeployment },
    });

    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
      console.log(`[SERVICE-REGISTRY] Discovered ${result.data.length} tools from OpenCode SDK`);
      return result.data.map((tool) => ({
        toolName: tool.id,
        description: tool.description ?? `OpenCode tool: ${tool.id}`,
        blastRadius: classifyBlastRadius(tool.id),
        requiresApproval: false,
        source: "opencode" as const,
        parameters: Array.isArray(tool.parameters) ? (tool.parameters as ToolParameter[]) : [],
        allowedRoles: classifyAllowedRoles(tool.id),
      }));
    }

    // Fallback to simple IDs endpoint
    const idsResult = await opencode.client.tool.ids();
    if (idsResult.data && Array.isArray(idsResult.data) && idsResult.data.length > 0) {
      console.log(`[SERVICE-REGISTRY] Discovered ${idsResult.data.length} tool IDs from OpenCode SDK`);
      return idsResult.data.map((id) => ({
        toolName: id,
        description: `OpenCode tool: ${id}`,
        blastRadius: classifyBlastRadius(id),
        requiresApproval: false,
        source: "opencode" as const,
        parameters: [],
        allowedRoles: classifyAllowedRoles(id),
      }));
    }

    console.warn("[SERVICE-REGISTRY] OpenCode SDK returned no tools");
    return [];
  } catch (err) {
    console.warn(
      "[SERVICE-REGISTRY] Failed to discover tools from OpenCode SDK, seeding without OpenCode tools:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ── Arceus platform tools ──────────────────────────────────
// Higher-level tools the orchestrator exposes (not in OpenCode).

const ARCEUS_TOOLS: ToolSeed[] = [
  {
    toolName: "deploy_preview",
    description: "Build and serve a live preview of the workspace product",
    blastRadius: "yellow",
    requiresApproval: false,
    source: "arceus",
    parameters: [],
    allowedRoles: ["cto", "developer", "tester"],
  },
  {
    toolName: "git_commit",
    description: "Stage and commit workspace changes to local git",
    blastRadius: "yellow",
    requiresApproval: false,
    source: "arceus",
    parameters: [
      { name: "message", type: "string", required: true, description: "Commit message" },
    ],
    allowedRoles: ["cto", "developer"],
  },
  {
    toolName: "git_push",
    description: "Push local commits to remote repository",
    blastRadius: "red",
    requiresApproval: true,
    source: "arceus",
    parameters: [],
    allowedRoles: ["cto"],
  },
  {
    toolName: "task_update",
    description: "Update task status or assignment through the control plane",
    blastRadius: "green",
    requiresApproval: false,
    source: "arceus",
    parameters: [
      { name: "taskId", type: "string", required: true, description: "Task ID" },
      { name: "status", type: "string", required: false, description: "New status" },
      { name: "assignedTo", type: "string", required: false, description: "Agent ID" },
    ],
    allowedRoles: ["ceo", "cto", "pm"],
  },
  {
    toolName: "meeting_create",
    description: "Schedule and record a meeting",
    blastRadius: "green",
    requiresApproval: false,
    source: "arceus",
    parameters: [
      { name: "type", type: "string", required: true, description: "Meeting type" },
      { name: "participants", type: "object", required: true, description: "Array of participant roles" },
    ],
    allowedRoles: ["ceo", "cto", "pm"],
  },
  {
    toolName: "approval_request",
    description: "Create an approval request for board or manager sign-off",
    blastRadius: "green",
    requiresApproval: false,
    source: "arceus",
    parameters: [
      { name: "type", type: "string", required: true, description: "Approval type" },
      { name: "data", type: "object", required: true, description: "Approval payload" },
    ],
    allowedRoles: ["ceo", "cto", "pm"],
  },
  {
    toolName: "memory_store",
    description: "Store a memory unit for an agent",
    blastRadius: "green",
    requiresApproval: false,
    source: "arceus",
    parameters: [
      { name: "content", type: "string", required: true, description: "Memory content" },
      { name: "type", type: "string", required: true, description: "Memory unit type" },
    ],
    allowedRoles: ["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"],
  },
];

// ── Seed logic ─────────────────────────────────────────────

function buildSeedEntry(companyId: string, seed: ToolSeed): ServiceRegistryEntry {
  return {
    id: `svc_${randomUUID()}`,
    companyId,
    toolName: seed.toolName,
    description: seed.description,
    allowedRoles: seed.allowedRoles,
    blastRadius: seed.blastRadius,
    requiresApproval: seed.requiresApproval,
    version: 1,
    parameters: seed.parameters,
    source: seed.source,
    addedAt: new Date().toISOString(),
    addedBy: "system",
  };
}

/**
 * Seed a company's service registry with the known tool inventory.
 * Fetches OpenCode tools from the SDK, merges with Arceus platform tools.
 * Idempotent — skips tools already registered for this company.
 */
export async function seedRegistry(companyId: string): Promise<{ seeded: number; skipped: number }> {
  console.log(`[SERVICE-REGISTRY] seedRegistry called for company=${companyId}`);
  const co = getCompanyRegistry(companyId);
  let seeded = 0;
  let skipped = 0;

  const opencodeTools = await fetchOpencodeTools();
  console.log(`[SERVICE-REGISTRY] opencodeTools=${opencodeTools.length}, ARCEUS_TOOLS=${ARCEUS_TOOLS.length}`);
  const allTools = [...opencodeTools, ...ARCEUS_TOOLS];

  for (const seed of allTools) {
    if (co.has(seed.toolName)) {
      skipped++;
      continue;
    }
    const entry = buildSeedEntry(companyId, seed);
    co.set(seed.toolName, entry);
    seeded++;
  }

  if (seeded > 0) {
    audit({
      companyId,
      category: "system",
      severity: "info",
      eventType: "service_registry_seeded",
      summary: `Service registry seeded: ${seeded} tools registered, ${skipped} already present`,
      detail: { seeded, skipped, totalTools: co.size },
    });
  }

  return { seeded, skipped };
}

// ── Query interface ────────────────────────────────────────

/** Get all tools available for a role in the given company. */
export function getToolsForRole(companyId: string, role: string): ServiceRegistryEntry[] {
  const co = registry.get(companyId);
  if (!co) return [];
  return Array.from(co.values()).filter((e) => e.allowedRoles.includes(role));
}

/** Check if a specific tool is available to a specific role. */
export function isToolAvailable(companyId: string, role: string, toolName: string): boolean {
  const co = registry.get(companyId);
  if (!co) return false;
  const entry = co.get(toolName);
  return !!entry && entry.allowedRoles.includes(role);
}

/** Get blast-radius classification for a tool. */
export function getBlastRadius(companyId: string, toolName: string): BlastRadius | null {
  const co = registry.get(companyId);
  if (!co) return null;
  return co.get(toolName)?.blastRadius ?? null;
}

/** Get a single tool entry by name. */
export function getToolEntry(companyId: string, toolName: string): ServiceRegistryEntry | null {
  const co = registry.get(companyId);
  if (!co) return null;
  return co.get(toolName) ?? null;
}

/** Get full registry snapshot for a company. */
export function getRegistrySnapshot(companyId: string): ServiceRegistryEntry[] {
  const co = registry.get(companyId);
  if (!co) return [];
  return Array.from(co.values());
}

/** Summary stats for the dashboard / CP status. */
export function getRegistryStats(companyId: string) {
  const co = registry.get(companyId);
  if (!co) return { total: 0, bySource: {}, byBlastRadius: {}, byRole: {} };

  const entries = Array.from(co.values());
  const bySource: Record<string, number> = {};
  const byBlastRadius: Record<string, number> = {};
  const byRole: Record<string, number> = {};

  for (const e of entries) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    byBlastRadius[e.blastRadius] = (byBlastRadius[e.blastRadius] ?? 0) + 1;
    for (const role of e.allowedRoles) {
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
  }

  return { total: entries.length, bySource, byBlastRadius, byRole };
}

// ── Mutation (for Spec 14 skill evolution) ─────────────────

/** Register a new tool or update an existing one. */
export async function registerTool(entry: ServiceRegistryEntry): Promise<void> {
  const co = getCompanyRegistry(entry.companyId);
  const existing = co.get(entry.toolName);

  if (existing) {
    // Bump version on update
    entry.version = existing.version + 1;
  }

  co.set(entry.toolName, entry);

  audit({
    companyId: entry.companyId,
    category: "system",
    severity: "info",
    eventType: existing ? "service_registry_tool_updated" : "service_registry_tool_registered",
    summary: `Tool "${entry.toolName}" ${existing ? `updated to v${entry.version}` : "registered"} (${entry.source}, ${entry.blastRadius})`,
    detail: { toolName: entry.toolName, source: entry.source, blastRadius: entry.blastRadius, version: entry.version, allowedRoles: entry.allowedRoles },
  });

  // Persist to DB if available
  await persistEntry(entry);
}

// ── DB persistence ─────────────────────────────────────────

async function persistEntry(entry: ServiceRegistryEntry) {
  if (!isDatabaseConfigured()) return;
  try {
    const db = getDb();
    await db
      .insert(serviceRegistryTable)
      .values({
        id: entry.id,
        companyId: entry.companyId,
        toolName: entry.toolName,
        description: entry.description,
        allowedRoles: entry.allowedRoles,
        blastRadius: entry.blastRadius,
        requiresApproval: entry.requiresApproval ? 1 : 0,
        parameters: entry.parameters,
        source: entry.source,
        version: entry.version,
        addedBy: entry.addedBy,
        addedAt: new Date(entry.addedAt),
      })
      .onConflictDoUpdate({
        target: [serviceRegistryTable.companyId, serviceRegistryTable.toolName],
        set: {
          description: entry.description,
          allowedRoles: entry.allowedRoles,
          blastRadius: entry.blastRadius,
          requiresApproval: entry.requiresApproval ? 1 : 0,
          parameters: entry.parameters,
          source: entry.source,
          version: entry.version,
        },
      });
  } catch (err) {
    console.warn(`[SERVICE-REGISTRY] DB persist failed for ${entry.toolName}:`, err instanceof Error ? err.message : err);
  }
}

/** Persist the full in-memory registry for a company to DB. */
export async function persistRegistry(companyId: string) {
  const co = registry.get(companyId);
  if (!co || !isDatabaseConfigured()) return;

  for (const entry of co.values()) {
    await persistEntry(entry);
  }
}

/** Load a company's registry from DB into memory (cold start). */
export async function hydrateRegistryFromDb(companyId: string): Promise<number> {
  if (!isDatabaseConfigured()) return 0;
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(serviceRegistryTable)
      .where(eq(serviceRegistryTable.companyId, companyId));

    const co = getCompanyRegistry(companyId);
    let loaded = 0;

    for (const row of rows) {
      co.set(row.toolName, {
        id: row.id,
        companyId: row.companyId,
        toolName: row.toolName,
        description: row.description,
        allowedRoles: row.allowedRoles ?? [],
        blastRadius: (row.blastRadius as BlastRadius) ?? "green",
        requiresApproval: !!row.requiresApproval,
        version: row.version ?? 1,
        parameters: (row.parameters as ToolParameter[]) ?? [],
        source: (row.source as "opencode" | "arceus" | "skill") ?? "opencode",
        addedAt: row.addedAt?.toISOString() ?? new Date().toISOString(),
        addedBy: row.addedBy ?? "system",
      });
      loaded++;
    }

    return loaded;
  } catch (err) {
    console.warn(`[SERVICE-REGISTRY] DB hydrate failed for ${companyId}:`, err instanceof Error ? err.message : err);
    return 0;
  }
}

/** Clear a company's registry (used on company reset). */
export function clearRegistry(companyId: string) {
  registry.delete(companyId);
}
