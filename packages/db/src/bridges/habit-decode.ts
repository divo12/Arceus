/**
 * Pure legacy → canonical habit decoder — Spec 31 PR #13d.
 *
 * Single source of truth for the column mapping from
 * `hippocampus.habits` (text-PK, text FKs) to `public.habits`
 * (uuid-PK, uuid FKs). Mirrors the shape of `bridges/memory-decode.ts`
 * so the two bridge layers stay consistent.
 */
import { friendlyToUuid } from "../repos/_uuid.js";
import type { habits } from "../schema/habits.js";

export type LegacyFormationMode = "auto" | "explicit";

/**
 * Mirror of the legacy `hippocampus.habits` row — only the columns
 * the canonical schema consumes. Defaults (`is_active`,
 * `formation_mode`) are read so dual-write behaves identically to a
 * legacy insert that omitted them.
 */
export interface LegacyHabitRow {
  id: string;
  companyId: string;
  agentId: string;
  triggerCondition: string;
  action: string;
  confidence: number;
  usageCount: number;
  formedFromId: string;
  formationMode: LegacyFormationMode;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewHabit = typeof habits.$inferInsert;

/**
 * Build canonical `habits` insert values from a legacy row. UUIDs are
 * derived from friendly ids via `friendlyToUuid` so canonical FK
 * targets match what the agents/companies tables actually store.
 */
export function buildHabitInsert(legacy: LegacyHabitRow): NewHabit {
  return {
    legacyId: legacy.id,
    companyId: friendlyToUuid(legacy.companyId),
    agentId: friendlyToUuid(legacy.agentId),
    triggerCondition: legacy.triggerCondition,
    action: legacy.action,
    confidence: legacy.confidence,
    usageCount: legacy.usageCount,
    formedFromId: legacy.formedFromId,
    formationMode: legacy.formationMode,
    isActive: legacy.isActive,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
}
