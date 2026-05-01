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
import { setActiveCompanyId } from "../persistence/active-company.js";
import { seedExistingSkills } from "@arceus/company-runtime";

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Derive a creative 1–2 word company name from a free-text idea via
 * an LLM. Falls back to a deterministic title-cased extract when the
 * model is unavailable. Spec 31 Phase 7.C.d — moved here from the
 * dying `persistence/store.ts`; lives next to the only caller
 * (bootstrapCompanyTx via `orchestration/bootstrap.ts`).
 */
export async function deriveCompanyNameFromIdea(idea: string): Promise<string> {
  try {
    const { structuredCompletion } = await import("../infra/azure-openai.js");
    const { z } = await import("zod");
    const schema = z.object({ name: z.string() });
    const result = await structuredCompletion(
      "ceoDeployment",
      [
        {
          role: "system",
          content:
            "Generate a creative, fun, abstract company name (1-2 words). " +
            "It should feel like a startup name — evocative, memorable, slightly playful. " +
            "Do NOT include generic suffixes like Labs, Inc, Co, Corp, etc. " +
            "Return ONLY the name. Examples of good names: Nebula, Helix, Prism, Opal, Zigzag.",
        },
        { role: "user", content: `Business idea: ${idea.slice(0, 200)}` },
      ],
      schema,
      "company_name",
      { temperature: 1.0, maxTokens: 30 },
    );
    const name = result.name?.trim();
    if (name && name.length >= 2 && name.length <= 30) return name;
  } catch {
    // fall through to deterministic fallback
  }
  const core = idea
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return core ? titleCase(core) : "New Company";
}

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

  // The transaction committed — wire the active-company seam so sync
  // callers can resolve companyId without a DB roundtrip.
  setActiveCompanyId(companyId);

  // Seed the in-memory skill registry from the filesystem corpus. The
  // write-through callbacks (wired in evolution.ts) mirror each seeded skill
  // into Postgres, giving us a starting baseline EMA + usage count for the
  // company's first beat. Sync; no DB roundtrip beyond the per-skill upsert.
  seedExistingSkills(companyId);

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
