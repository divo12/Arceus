/**
 * Company bootstrap — Spec 31 Phase 7.C.c-bis.
 *
 * Atomic, transactional creation of a new company. The previous
 * implementation in `persistence/store.ts` mutated the in-memory
 * snapshot first and then fanned three fire-and-forget canonical
 * writes (companies, ideas, strategy_briefs). If any one of those
 * failed, the system was left half-bootstrapped — company row but no
 * idea / strategy — recoverable only by another mutation.
 *
 * This module wraps the multi-row writes in a single
 * `db.transaction()` so the bootstrap either fully commits or fully
 * rolls back. Repos stay single-table; the compound workflow lives
 * here, in the domain folder it belongs to.
 *
 * The in-memory snapshot is still updated for backward compatibility
 * with code that hasn't migrated to canonical reads yet (see
 * `persistence/store.ts`). 7.C.d removes the in-memory layer
 * entirely; this module's `db.transaction` becomes the only thing
 * that runs.
 */
import type { Company, FundamentalIdea, StrategyBrief } from "@arceus/contracts";
import { createBootstrapEvent, createEmptyCompanySnapshot } from "@arceus/company-runtime";
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as ideasRepo from "@arceus/db/src/repos/ideas.js";
import * as strategyBriefsRepo from "@arceus/db/src/repos/strategy_briefs.js";

export interface BootstrapInput {
  companyName: string;
  boardOwner: string;
  idea: string;
  budgetCents: number;
}

export interface BootstrapResult {
  company: Company;
  idea: FundamentalIdea;
  strategy: StrategyBrief;
}

/**
 * Bootstrap a new company. All three rows (company + idea + strategy)
 * commit atomically. Throws on transaction failure — caller surfaces
 * the error to the board so they can retry instead of being left with
 * partial state.
 */
export async function bootstrapCompanyTx(input: BootstrapInput): Promise<BootstrapResult> {
  const companyId = `company_${crypto.randomUUID()}`;
  const strategyId = `strategy_${crypto.randomUUID()}`;
  const ideaId = `idea_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const empty = createEmptyCompanySnapshot();

  const company: Company = {
    ...empty.company,
    id: companyId,
    name: input.companyName,
    boardOwner: input.boardOwner,
    goal: input.idea,
    budgetCents: input.budgetCents,
    currentStrategyId: strategyId,
    createdAt: now,
  };

  const idea: FundamentalIdea = {
    id: ideaId,
    companyId,
    coreIdea: input.idea,
    currentDirection: "",
    refinedWithBoard: false,
  };

  const strategy: StrategyBrief = {
    ...empty.strategy,
    id: strategyId,
    companyId,
    createdAt: now,
  };

  // Atomic: company → idea → strategy. Idea and strategy FK-reference
  // company.id, so company must land first; the transaction guarantees
  // a successful commit means all three rows exist.
  const db = getDb();
  await db.transaction(async (tx) => {
    await companiesRepo.upsertCompany(tx, company);
    await ideasRepo.upsertIdea(tx, idea);
    await strategyBriefsRepo.upsertStrategy(tx, strategy);
  });

  return { company, idea, strategy };
}

/** Build the bootstrap event for the activity log. Pure, no side effects. */
export function buildBootstrapEvent(input: BootstrapInput, companyId: string) {
  return createBootstrapEvent("Board bootstrapped a new company.", {
    companyId,
    companyName: input.companyName,
    budgetCents: input.budgetCents,
  });
}
