import { eq } from "drizzle-orm";
import { primingStates } from "../schema/priming_states.js";
import type { DbClient } from "./_helpers.js";

export type PrimingState = typeof primingStates.$inferSelect;

export async function getPriming(db: DbClient, agentId: string): Promise<PrimingState | null> {
  const [row] = await db
    .select()
    .from(primingStates)
    .where(eq(primingStates.agentId, agentId))
    .limit(1);
  return row ?? null;
}

export async function upsertPriming(
  db: DbClient,
  data: {
    agentId: string;
    companyId: string;
    state: Record<string, unknown>;
    recentOutcomes: { beatId: string; score: number }[];
  },
): Promise<PrimingState> {
  const [row] = await db
    .insert(primingStates)
    .values(data)
    .onConflictDoUpdate({
      target: primingStates.agentId,
      set: {
        state: data.state,
        recentOutcomes: data.recentOutcomes,
      },
    })
    .returning();
  return row;
}
