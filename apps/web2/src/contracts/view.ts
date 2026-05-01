/**
 * View envelopes, narrative wrappers, action results, and SSE union.
 * Every string the UI shows is either an enum-driven label or a
 * `narrativeText` (AI-authored, with lineage).
 */
import { z } from "zod";

export const narrativeTextSchema = z.object({
  text: z.string(),
  authorAgentId: z.string().nullable().default(null),
  generatedAt: z.string().default(() => new Date().toISOString()),
  sourceBeatId: z.string().nullable().default(null),
  /** "ai" — model-generated; "template" — deterministic fallback; "label" — fixed UI string. */
  kind: z.enum(["ai", "template", "label"]).default("template"),
  confidence: z.number().min(0).max(1).optional(),
});
export type NarrativeText = z.infer<typeof narrativeTextSchema>;

export const tabIdSchema = z.enum([
  "today", "sprint", "team", "memory", "skills",
  "meetings", "inbox", "preview", "logs", "settings",
]);
export type TabId = z.infer<typeof tabIdSchema>;

export const viewSourceSchema = z.enum(["live", "cache", "stale", "fallback"]);

export const viewEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    view: z.string(),
    generatedAt: z.string(),
    source: viewSourceSchema,
    trace: z
      .object({
        runId: z.string().nullable(),
        sources: z.array(z.string()),
      })
      .optional(),
    data,
  });

export const viewErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    "unauthorized", "not_found", "stale",
    "upstream_failed", "ai_unavailable", "budget_exceeded",
  ]),
  message: narrativeTextSchema,
  retryAfterMs: z.number().nullable().default(null),
});
export type ViewError = z.infer<typeof viewErrorSchema>;

export const actionResultSchema = <T extends z.ZodTypeAny>(resource: T) =>
  z.object({
    ok: z.literal(true),
    resource,
    derived: z
      .object({
        sublineDelta: narrativeTextSchema.nullable(),
        badgeDeltas: z.record(z.string(), z.number()),
      })
      .optional(),
    audit: z
      .object({
        eventId: z.string(),
        category: z.string(),
      })
      .optional(),
  });

export const viewStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("badge"), tab: tabIdSchema, value: z.string() }),
  z.object({ kind: z.literal("invalidate"), view: tabIdSchema }),
  z.object({ kind: z.literal("agent.pip"), agentId: z.string(), pip: z.enum(["green", "amber", "none"]) }),
  z.object({ kind: z.literal("toast"), text: narrativeTextSchema }),
  z.object({ kind: z.literal("heartbeat"), running: z.boolean(), beatCount: z.number() }),
]);
export type ViewStreamEvent = z.infer<typeof viewStreamEventSchema>;

/** Helper: build a label-kind narrative from a fixed string. */
export function label(text: string): NarrativeText {
  return {
    text,
    authorAgentId: null,
    generatedAt: new Date().toISOString(),
    sourceBeatId: null,
    kind: "label",
  };
}

/** Helper: build a templated narrative (deterministic, derived from data). */
export function template(text: string): NarrativeText {
  return {
    text,
    authorAgentId: null,
    generatedAt: new Date().toISOString(),
    sourceBeatId: null,
    kind: "template",
  };
}
