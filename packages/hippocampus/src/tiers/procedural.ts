import type { Habit } from "@arceus/contracts";
import type { ProceduralMemoryStore } from "../types";

function tokenize(input: string) {
  return input.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export class InMemoryProceduralStore implements ProceduralMemoryStore {
  private readonly byAgent = new Map<string, Habit[]>();

  async list(agentId: string): Promise<Habit[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }

  async findMatching(agentId: string, taskDescription: string): Promise<Habit[]> {
    const habits = this.byAgent.get(agentId) ?? [];
    const tokens = new Set(tokenize(taskDescription));

    return habits.filter((habit) => {
      if (habit.status !== "active") return false;
      const triggerTokens = tokenize(`${habit.trigger} ${habit.description}`);
      return triggerTokens.some((token) => tokens.has(token));
    });
  }

  async incrementUsage(agentId: string, habitIds: string[]): Promise<void> {
    if (habitIds.length === 0) return;

    const habits = this.byAgent.get(agentId) ?? [];
    this.byAgent.set(
      agentId,
      habits.map((habit) =>
        habitIds.includes(habit.id)
          ? { ...habit, usageCount: habit.usageCount + 1, updatedAt: new Date().toISOString() }
          : habit
      )
    );
  }

  async gc(companyId: string): Promise<number> {
    let deactivated = 0;

    for (const [agentId, habits] of this.byAgent.entries()) {
      const nextHabits = habits.map((habit) => {
        if (habit.companyId !== companyId || habit.status !== "active" || habit.usageCount > 0) {
          return habit;
        }

        deactivated += 1;
        return {
          ...habit,
          status: "inactive" as const,
          updatedAt: new Date().toISOString()
        };
      });

      this.byAgent.set(agentId, nextHabits);
    }

    return deactivated;
  }
}