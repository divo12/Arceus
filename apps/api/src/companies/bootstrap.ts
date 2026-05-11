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
import { getActiveCompanyId, setActiveCompanyId } from "../persistence/active-company.js";
import { seedExistingSkills } from "@arceus/company-runtime";
import { materializeStaticSkillsForCompany } from "../opencode/materialize-static-skills.js";

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
  /** Optional: the authenticated user who owns this company (1:1). */
  userId?: string;
}

interface BootstrapResult {
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
    const row = await companiesRepo.upsertCompany(tx, company);
    if (input.userId) {
      await companiesRepo.updateCompany(tx, row.id, { userId: input.userId });
    }
    await ideasRepo.upsertIdea(tx, idea);
    await strategyBriefsRepo.upsertStrategy(tx, strategy);
  });

  // The transaction committed — wire the active-company seam so the
  // small set of legacy sync callers (deep persistence/orchestration
  // paths that don't have `req.companyId` in scope) can resolve a
  // sensible default without a DB roundtrip.
  //
  // Multi-tenant safety: only seed the singleton on the FIRST
  // bootstrap in this process. Subsequent users registering their
  // own companies must not overwrite the singleton — that previously
  // (via the cancelStaleBeats cascade) killed the first user's
  // in-flight beats mid-flight, and (via the singleton flip) made
  // every legacy reader resolve to the wrong tenant. Per-user routes
  // already use req.companyId from the JWT, so this default only
  // affects the residual unmigrated readers, and "first company in
  // process" is the right default for those.
  if (!getActiveCompanyId()) {
    setActiveCompanyId(companyId);
  }

  // Seed the in-memory skill registry from the filesystem corpus. The
  // write-through callbacks (wired in evolution.ts) mirror each seeded skill
  // into Postgres, giving us a starting baseline EMA + usage count for the
  // company's first beat. Sync; no DB roundtrip beyond the per-skill upsert.
  seedExistingSkills(companyId);

  // V1 simplification: drop the seed corpus straight onto disk at the
  // shared workspace skills path so OpenCode's `skill` tool can resolve
  // `skill({name: <slug>})` for the new active company. Replaces the
  // per-beat `materializeBeatSkills` call inside runBeat. Best-effort —
  // a materialize failure must not roll back company creation.
  try {
    await materializeStaticSkillsForCompany(companyId);
  } catch (err) {
    console.warn(`[bootstrap] static skill materialization failed for ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { company, idea, strategy };
}
