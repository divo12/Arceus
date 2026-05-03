/**
 * @module beat-context
 * Lightweight beat metadata contract for the session-context bridge.
 *
 * This is NOT the full AgentBeatContext (which carries company state, tasks,
 * artifacts, etc. for prompt assembly). This is the thin metadata that the
 * plugin and MCP server resolve via GET /api/internal/telemetry/session-context/:sessionId
 * to gate tool calls, derive idempotency keys, and emit audit events.
 *
 * Defined in: plans/agent-redesign/02-todo-phase-65-onwards.md — Package A.
 */
import { z } from "zod";

import { roleTypeSchema } from "./agents.js";
import { incomingHandoffSchema } from "./memory.js";

export const trustBandSchema = z.enum(["probation", "standard", "senior"]);

export const beatContextSchema = z.object({
  beatId: z.string(),
  sessionId: z.string(),
  companyId: z.string(),
  /**
   * Active sprint id at the time the beat was built, or null if the company
   * has no active sprint. Sourced from `snapshot.company.currentSprintId`.
   * Used by spec 32 emit sites (e.g. `beat.started`) so traces can be
   * filtered/grouped by sprint in Langfuse without a separate join.
   */
  sprintId: z.string().nullable(),
  role: roleTypeSchema,
  trustBand: trustBandSchema,
  allowedTools: z.array(z.string()),
  taskId: z.string().optional(),
  startedAt: z.string().datetime(),
  /**
   * Handoffs from other roles waiting for this agent; populated by
   * `buildBeatContext` from the role's incoming queue. Rendered in the
   * system prompt under `## Incoming handoffs`; `urgency: "high"` items
   * additionally surface as a banner at the top of the prompt.
   */
  incomingHandoffs: z.array(incomingHandoffSchema).default([]),
});

export type TrustBand = z.infer<typeof trustBandSchema>;
export type BeatContext = z.infer<typeof beatContextSchema>;
