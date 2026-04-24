/**
 * @module memory
 * Memory system schemas — the "hippocampus" of each agent.
 *
 * Agents accumulate memories from task completions, meetings, and chats.
 * Memory units have types (static, dynamic, episodic, semantic, delegation)
 * and visibility levels. The priming state tracks an agent's current
 * emotional/confidence disposition.
 *
 * Key types:
 * - MemorySummary — per-agent rolling summary (focus, learnings, blockers)
 * - MemoryUnit — individual memory with type, source, confidence, and expiry
 * - Habit — learned behavioral pattern with trigger/action
 * - PrimingState — agent's confidence/caution/morale state
 */
import { z } from "zod";

export const memoryUnitTypeSchema = z.enum(["static", "dynamic", "episodic", "semantic", "delegation"]);
export const memoryVisibilitySchema = z.enum(["public", "team", "private"]);
export const memorySourceSchema = z.enum(["role_seed", "task_completion", "meeting", "chat", "delegation", "system"]);
export const habitStatusSchema = z.enum(["draft", "active", "inactive"]);

export const memorySummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  currentFocus: z.array(z.string()),
  recentLearnings: z.array(z.string()),
  activePatterns: z.array(z.string()),
  openBlockers: z.array(z.string()),
  importantDecisions: z.array(z.string()),
  updatedAt: z.string()
});

export const memoryUnitSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  sourceTaskId: z.string().nullable(),
  sourceArtifactId: z.string().nullable(),
  type: memoryUnitTypeSchema,
  visibility: memoryVisibilitySchema,
  source: memorySourceSchema,
  content: z.string(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable()
});

export const habitSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: z.string(),
  action: z.string(),
  status: habitStatusSchema,
  usageCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const primingStateSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  confidence: z.number().min(0).max(1),
  caution: z.number().min(0).max(1),
  morale: z.number().min(0).max(1),
  lastDisposition: z.string(),
  recentEvents: z.array(z.string()),
  updatedAt: z.string()
});

export type MemorySummary = z.infer<typeof memorySummarySchema>;
export type MemoryUnit = z.infer<typeof memoryUnitSchema>;
export type Habit = z.infer<typeof habitSchema>;
export type PrimingState = z.infer<typeof primingStateSchema>;

// ─────────────────────────────────────────────────────────────────────
// §6 Tool I/O contracts — spec 27 §6. Frozen 2026-04-24.
//
// Three LLM-facing tools, all on the `all` role allowlist:
//   memory_search       → GET  /api/internal/v1/memory/search
//   memory_add_learning → POST /api/internal/v1/memory/learnings
//   memory_handoff      → POST /api/internal/v1/memory/handoff
//
// Backed by @arceus/hippocampus. No LLM in retrieval hot path.
// Server-side retry policy: embed_failed / store_unavailable retry 2× with
// exponential backoff (250ms, 750ms) before surfacing to caller.
// ─────────────────────────────────────────────────────────────────────

import { roleTypeSchema } from "./agents.js";

// ─── memory_search ──────────────────────────────────────────────────

export const memorySearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Natural-language query; embedded and ranked over role memory."),
  scope: z
    .enum(["self", "company"])
    .default("self")
    .describe(
      "'self' = caller's memory only (default, private). " +
        "'company' = caller's memory + memories explicitly handed off to this role.",
    ),
  kind: z
    .enum(["static", "dynamic", "any"])
    .default("any")
    .describe("Filter by memory kind. 'any' returns both static and dynamic."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .default(5)
    .describe("Max results to return (1-20)."),
  since: z
    .string()
    .datetime()
    .optional()
    .describe("ISO-8601 timestamp; only return memories recorded after this time."),
});

export const memorySearchHitSchema = z.object({
  id: z.string(),
  content: z.string(),
  kind: z.enum(["static", "dynamic"]),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("MMR retrieval score at query time, NOT stored confidence."),
  recordedAt: z.string(),
  sourceTaskId: z.string().nullable(),
  sourceAgentRole: roleTypeSchema.describe(
    "Which role's memory surfaced this hit (may differ from caller under scope=company).",
  ),
});

export const memorySearchDataSchema = z.object({
  memories: z.array(memorySearchHitSchema),
  queryEmbeddingMs: z.number().int().nonnegative(),
  totalSearched: z
    .number()
    .int()
    .nonnegative()
    .describe("Total candidate memories considered before MMR selection."),
});

// ─── memory_add_learning ────────────────────────────────────────────

export const memoryAddLearningInputSchema = z.object({
  content: z
    .string()
    .min(10)
    .max(2000)
    .describe("The fact, pattern, or insight to remember, in prose."),
  kind: z
    .enum(["static", "dynamic", "procedural"])
    .default("dynamic")
    .describe("Tier: static (durable), dynamic (expiring), procedural (habit)."),
  tags: z
    .array(z.string().min(1).max(64))
    .max(5)
    .default([])
    .describe("Free-form tags for filtering (max 5)."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe("Caller's confidence in this fact (0-1)."),
  expiryDays: z
    .number()
    .int()
    .positive()
    .max(365)
    .optional()
    .describe("TTL in days; only honored when kind is 'dynamic'."),
  sourceTaskId: z
    .string()
    .optional()
    .describe("Task this learning emerged from; for traceability."),
});

export const memoryAddLearningDataSchema = z.object({
  memoryId: z.string(),
  action: z
    .enum(["ADD", "UPDATE", "NONE"])
    .describe(
      "Action-decider verdict: ADD = new entry, UPDATE = merged into existing, " +
        "NONE = duplicate rejected (semantically identical to an existing memory).",
    ),
  reason: z
    .string()
    .describe("Action-decider's rationale; useful when action is UPDATE or NONE."),
  targetId: z
    .string()
    .nullable()
    .describe("ID of existing memory (populated only when action = UPDATE)."),
});

// ─── memory_handoff ─────────────────────────────────────────────────

export const handoffKindSchema = z
  .enum(["finding", "decision", "blocker_warning", "context_transfer"])
  .describe(
    "What this handoff conveys: 'finding' = I discovered X; 'decision' = I decided X; " +
      "'blocker_warning' = I'm blocked on X; 'context_transfer' = general context target will need.",
  );

export const handoffUrgencySchema = z
  .enum(["low", "normal", "high"])
  .describe("Priority hint for target's next beat context. 'high' renders as a banner.");

export const memoryHandoffInputSchema = z.object({
  targets: z
    .array(roleTypeSchema)
    .min(1)
    .max(3)
    .describe("Target roles to route this handoff to (1-3). Self-handoff rejected server-side."),
  kind: handoffKindSchema,
  content: z
    .string()
    .min(20)
    .max(5000)
    .describe("Handoff content. Should be self-contained; target may act without re-asking."),
  relatedArtifactIds: z
    .array(z.string())
    .max(5)
    .default([])
    .describe("Artifact IDs that evidence this handoff (plans, findings, probe bundles)."),
  urgency: handoffUrgencySchema.default("normal"),
});

export const memoryHandoffDataSchema = z.object({
  handoffId: z.string(),
  handoffArtifactId: z
    .string()
    .describe("Created artifact (kind='handoff') for audit trail."),
  targetsNotified: z.array(roleTypeSchema),
  memoryIdsWritten: z
    .array(z.string())
    .describe("One memory ID per target role (static kind, tagged 'handoff')."),
});

// ─── Incoming handoff (surfaces in target's BeatContext) ────────────

export const incomingHandoffSchema = z.object({
  handoffId: z.string(),
  fromRole: roleTypeSchema,
  kind: handoffKindSchema,
  urgency: handoffUrgencySchema,
  excerpt: z.string().max(200).describe("First 200 chars of handoff content."),
  memoryId: z.string().describe("Full content retrievable via memory_search (scope=company)."),
  relatedArtifactIds: z.array(z.string()),
  receivedAt: z.string().datetime(),
});

// ─── Inferred types ─────────────────────────────────────────────────

export type MemorySearchInput = z.infer<typeof memorySearchInputSchema>;
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;
export type MemorySearchData = z.infer<typeof memorySearchDataSchema>;
export type MemoryAddLearningInput = z.infer<typeof memoryAddLearningInputSchema>;
export type MemoryAddLearningData = z.infer<typeof memoryAddLearningDataSchema>;
export type HandoffKind = z.infer<typeof handoffKindSchema>;
export type HandoffUrgency = z.infer<typeof handoffUrgencySchema>;
export type MemoryHandoffInput = z.infer<typeof memoryHandoffInputSchema>;
export type MemoryHandoffData = z.infer<typeof memoryHandoffDataSchema>;
export type IncomingHandoff = z.infer<typeof incomingHandoffSchema>;
