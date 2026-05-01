/**
 * pgvector backend — ProceduralMemoryStore (habits).
 * Spec 34 v3 PR 7.
 *
 * Stores habits (trigger → action patterns) with naive token matching.
 * GC deactivates unused habits (usageCount=0) older than 30 days.
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import { getDb } from "@arceus/db";
import { habits } from "@arceus/db/src/schema/habits.js";
import type { Habit } from "@arceus/contracts";
import type { ProceduralMemoryStore } from "../../types.js";
import { canonicalHabitRowToHabit, extractUuid } from "./canonical-codec.js";

export class PgVectorProceduralStore implements ProceduralMemoryStore {
  async list(agentId: string): Promise<Habit[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(habits)
      .where(
        and(
          eq(habits.agentId, extractUuid(agentId)),
          eq(habits.isActive, true),
        ),
      );

    return rows.map(canonicalHabitRowToHabit);
  }

  async findMatching(agentId: string, taskDescription: string): Promise<Habit[]> {
    // Phase 2: naive token match. Phase 6 upgrades to LLM trigger eval.
    const candidates = await this.list(agentId);
    const tokens = new Set(taskDescription.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

    return candidates.filter((habit) => {
      const triggerTokens = `${habit.trigger} ${habit.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return triggerTokens.some((token) => tokens.has(token));
    });
  }

  async add(habit: Habit): Promise<void> {
    const db = getDb();
    await db.insert(habits).values({
      companyId: extractUuid(habit.companyId),
      agentId: extractUuid(habit.agentId),
      triggerCondition: habit.trigger,
      action: habit.action,
      confidence: habit.successRate,
      usageCount: habit.usageCount,
      formedFromId: "",
      formationMode: "auto",
      isActive: habit.status === "active",
    });
  }

  async update(id: string, trigger: string, action: string, confidence: number): Promise<void> {
    const db = getDb();
    await db
      .update(habits)
      .set({
        triggerCondition: trigger,
        action,
        confidence,
        updatedAt: new Date(),
      })
      .where(eq(habits.id, id));
  }

  async softDelete(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(habits)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(habits.id, id));
  }

  async incrementUsage(agentId: string, habitIds: string[]): Promise<void> {
    if (habitIds.length === 0) return;

    const db = getDb();
    await db
      .update(habits)
      .set({ usageCount: sql`${habits.usageCount} + 1` })
      .where(
        and(
          eq(habits.agentId, extractUuid(agentId)),
          inArray(habits.id, habitIds),
        ),
      );
  }

  async gc(companyId: string): Promise<number> {
    const db = getDb();
    const deactivated = await db
      .update(habits)
      .set({ isActive: false })
      .where(
        and(
          eq(habits.companyId, extractUuid(companyId)),
          eq(habits.isActive, true),
          eq(habits.usageCount, 0),
          sql`${habits.createdAt} < now() - interval '30 days'`,
        ),
      )
      .returning({ id: habits.id });

    return deactivated.length;
  }
}
