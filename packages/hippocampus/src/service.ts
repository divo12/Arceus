import type { ActionDecider, BatchActionDecider, BatchedActionInput, DynamicMemoryStore, ExtractedFact, FactExtractor, GCResult, HabitMatcher, HippocampusGateway, MemoryAction, PreparedAgentContext, PrimingStore, ProceduralMemoryStore, ProcessTaskCompletionInput, RetrievalOptions, ScoredMemory, StaticMemoryStore } from "./types";
import { InMemoryDynamicStore } from "./tiers/dynamic";
import { InMemoryPrimingStore, createDefaultPrimingState, renderPrimingDisposition, updatePrimingStateFromOutcome } from "./tiers/priming";
import { InMemoryProceduralStore } from "./tiers/procedural";
import { InMemoryStaticStore } from "./tiers/static";
import { embed } from "./backends/embedding.js";
import { rankAndSelect, DEFAULT_RETRIEVAL_OPTIONS } from "./engines/retrieval.js";
import type { RawCandidate } from "./engines/retrieval.js";
import type { Habit, MemoryUnit } from "@arceus/contracts";
import { observability } from "@arceus/contracts";

/**
 * Build a MemoryUnit from a completed task's output.
 * Maps task outcome to memory type (success → static, failure/partial → dynamic with 7-day TTL)
 * and assigns a confidence score proportional to outcome quality.
 */
function buildCompletionMemoryUnit(input: ProcessTaskCompletionInput): MemoryUnit {
  const now = new Date().toISOString();

  return {
    id: `memory_${crypto.randomUUID()}`,
    companyId: input.companyId,
    agentId: input.agentId,
    sourceTaskId: input.taskId,
    sourceArtifactId: null,
    type: input.outcome === "success" ? "static" : "dynamic",
    visibility: "team",
    source: "task_completion",
    content: input.output,
    summary: input.output.slice(0, 200),
    confidence: input.outcome === "success" ? 0.8 : input.outcome === "partial" ? 0.6 : 0.4,
    tags: ["task-completion"],
    createdAt: now,
    expiresAt: input.outcome === "success" ? null : new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
  };
}

export interface HippocampusDependencies {
  staticStore?: StaticMemoryStore;
  dynamicStore?: DynamicMemoryStore;
  proceduralStore?: ProceduralMemoryStore;
  primingStore?: PrimingStore;
  /** LLM-powered fact extractor. If not provided, falls back to raw output storage. */
  extractFacts?: FactExtractor;
  /** LLM-powered action decider (ADD/UPDATE/DELETE/NONE). If not provided, defaults to ADD. */
  decideAction?: ActionDecider;
  /**
   * Batched LLM-powered action decider — preferred over `decideAction` when
   * provided. Collapses the N+1 per-fact call pattern into ONE call per task,
   * ~30× cheaper for memory-heavy tasks. Falls back to `decideAction` (or
   * default ADD) if absent. See routeMemoryFactsBatch().
   */
  decideActionsBatch?: BatchActionDecider;
  /** LLM-powered habit matcher. If not provided, falls back to naive token matching. */
  matchHabits?: HabitMatcher;
}

/**
 * Hard cap on facts processed per task completion. The extractor sometimes
 * emits 20-30 facts for a meaty task (lots of fluff, restatements). Keeping
 * the top-K-by-confidence is enough — the long tail is mostly trivia or
 * paraphrases that the dedup step would skip anyway. Reduces per-task
 * LLM cost from O(N) to O(min(N, K)) where K is small.
 */
const MAX_FACTS_PER_TASK = 5;

/**
 * Minimum habit-list size before LLM-based habit matching is worth a
 * round-trip. Below this, prepareAgentContext includes all habits as-is —
 * with single-digit habit counts (current PROD: 4) the LLM call adds
 * latency to EVERY beat-context build and competes for model TPM while
 * filtering a list the agent can trivially skim itself.
 */
const LLM_HABIT_MATCH_THRESHOLD = 15;

/**
 * Core memory service orchestrating all four tiers (static, dynamic, procedural, priming).
 *
 * Implements the HippocampusGateway interface with two main flows:
 * - **prepareAgentContext**: Retrieves relevant memories, habits, and priming disposition
 *   before an agent starts a task (embedding → vector search → MMR ranking).
 * - **processTaskCompletion**: Extracts facts from agent output, deduplicates via action
 *   decision pipeline, and stores into the appropriate tier.
 *
 * LLM engines (extractor, action-decider, habit-matcher, priming-generator) are injected
 * via constructor to keep this package decoupled from the API/Azure OpenAI layer.
 * Falls back to non-LLM heuristics when engines are not provided.
 */
export class HippocampusService implements HippocampusGateway {
  private readonly staticStore: StaticMemoryStore;
  private readonly dynamicStore: DynamicMemoryStore;
  private readonly proceduralStore: ProceduralMemoryStore;
  private readonly primingStore: PrimingStore;
  private readonly extractFacts: FactExtractor | null;
  private readonly decideAction: ActionDecider | null;
  private readonly decideActionsBatch: BatchActionDecider | null;
  private readonly matchHabits: HabitMatcher | null;

  constructor(dependencies: HippocampusDependencies = {}) {
    this.staticStore = dependencies.staticStore ?? new InMemoryStaticStore();
    this.dynamicStore = dependencies.dynamicStore ?? new InMemoryDynamicStore();
    this.proceduralStore = dependencies.proceduralStore ?? new InMemoryProceduralStore();
    this.primingStore = dependencies.primingStore ?? new InMemoryPrimingStore();
    this.extractFacts = dependencies.extractFacts ?? null;
    this.decideAction = dependencies.decideAction ?? null;
    this.decideActionsBatch = dependencies.decideActionsBatch ?? null;
    this.matchHabits = dependencies.matchHabits ?? null;
  }

  /**
   * Assemble memories, habits, and priming disposition for an agent about to start a task.
   *
   * Pipeline: embed query → parallel fetch (vector search + habits + priming state)
   * → LLM habit filtering → MMR-based memory ranking → LLM priming generation.
   * Each LLM step has a non-LLM fallback.
   */
  async prepareAgentContext(
    agentId: string,
    taskDescription: string,
    retrievalOptions?: Partial<RetrievalOptions>,
  ): Promise<PreparedAgentContext> {
    const opts = { ...DEFAULT_RETRIEVAL_OPTIONS, ...retrievalOptions };
    const candidateLimit = opts.topK * opts.overFetch;

    // Embed + fetch candidates + habits + priming in parallel
    const hasVectorSearch = this.staticStore.searchByEmbedding && this.dynamicStore.searchByEmbedding;

    const [queryEmbedding, allHabits, primingState] = await Promise.all([
      hasVectorSearch ? embed(taskDescription) : Promise.resolve(null),
      // If LLM matcher available, fetch all habits; otherwise use store's naive matching
      this.matchHabits
        ? this.proceduralStore.list(agentId)
        : this.proceduralStore.findMatching(agentId, taskDescription),
      this.primingStore.get(agentId),
    ]);

    // LLM habit matching: filter all habits through LLM for relevance.
    // Threshold-gated: with a small habit set, an LLM round-trip per
    // prepareAgentContext costs more (latency + TPM) than it saves —
    // just include all habits and let the agent's own attention filter.
    // The LLM matcher earns its call only once the habit list is big
    // enough to meaningfully crowd the prompt.
    let habits: Habit[];
    if (this.matchHabits && allHabits.length > LLM_HABIT_MATCH_THRESHOLD) {
      try {
        const matchedIds = await this.matchHabits(taskDescription, allHabits);
        const idSet = new Set(matchedIds);
        habits = allHabits.filter((h) => idSet.has(h.id));
        console.log(`[Hippocampus] LLM habit match: ${habits.length}/${allHabits.length} habits relevant`);
      } catch (err) {
        // Fallback to naive token matching if LLM fails
        console.warn(`[Hippocampus] LLM habit match failed, falling back to token match: ${err instanceof Error ? err.message : String(err)}`);
        habits = await this.proceduralStore.findMatching(agentId, taskDescription);
      }
    } else {
      habits = allHabits;
    }

    // Fetch candidates — vector search if available, list() fallback
    let candidates: RawCandidate[];

    if (queryEmbedding && this.staticStore.searchByEmbedding && this.dynamicStore.searchByEmbedding) {
      const [staticResults, dynamicResults] = await Promise.all([
        this.staticStore.searchByEmbedding(agentId, queryEmbedding, candidateLimit),
        this.dynamicStore.searchByEmbedding(agentId, queryEmbedding, candidateLimit),
      ]);

      candidates = [
        ...staticResults.map((r) => ({ ...r, tier: "static" as const })),
        ...dynamicResults.map((r) => ({
          ...r,
          tier: "dynamic" as const,
          decayedScore: r.decayedScore,
        })),
      ];
    } else {
      // In-memory fallback — no similarity scores, no MMR
      const [staticMemories, dynamicMemories] = await Promise.all([
        this.staticStore.list(agentId),
        this.dynamicStore.list(agentId),
      ]);

      candidates = [
        ...staticMemories.map((m) => ({ ...m, similarity: 1.0, tier: "static" as const })),
        ...dynamicMemories.map((m) => ({ ...m, similarity: 1.0, tier: "dynamic" as const })),
      ];
    }

    // Run MMR retrieval
    const agentContainer = `company:${primingState?.companyId ?? "unknown"}:agent:${agentId}`;
    const scored = rankAndSelect(candidates, agentContainer, opts);

    // Replace stored confidence with MMR retrieval score so consumers see task-relevance
    const memories = scored.map((m) => ({ ...m, confidence: m.finalScore }));

    // Priming disposition — deterministic render from numeric state scores.
    // The former LLM-backed priming (memoryAgentGeneratePriming) was deleted
    // per spec 27 §6: numeric inputs, LLM couldn't improve on hardcoded thresholds.
    const priming: string = primingState
      ? renderPrimingDisposition(primingState)
      : "Neutral. Start with a direct first pass.";

    return { memories, habits, priming };
  }

  /**
   * Process a completed task: extract facts → deduplicate → store → update priming.
   *
   * Uses LLM extraction if available, otherwise falls back to storing the raw output
   * as a single memory unit. Always updates the agent's priming state and increments
   * usage counters on matched habits.
   */
  async processTaskCompletion(input: ProcessTaskCompletionInput): Promise<void> {
    // Extract facts via LLM if available, otherwise fall back to raw dump
    if (this.extractFacts) {
      await this.processWithExtraction(input);
    } else {
      await this.processRawDump(input);
    }

    // Update priming state (pure math, no LLM)
    const currentPriming = (await this.primingStore.get(input.agentId)) ?? createDefaultPrimingState(input.agentId, input.companyId);
    const nextPriming = updatePrimingStateFromOutcome(currentPriming, input.outcome, `${input.taskId}:${input.outcome}`);
    await this.primingStore.set(nextPriming);

    // Increment usage on matched habits
    const matchedHabits = await this.proceduralStore.findMatching(input.agentId, input.output);
    await this.proceduralStore.incrementUsage(input.agentId, matchedHabits.map((habit) => habit.id));
  }

  /** Fallback: store the raw output as a single memory unit */
  private async processRawDump(input: ProcessTaskCompletionInput): Promise<void> {
    const memoryUnit = buildCompletionMemoryUnit(input);
    if (memoryUnit.type === "static") {
      await this.staticStore.add(memoryUnit);
    } else {
      await this.dynamicStore.add(memoryUnit);
    }
  }

  /** LLM extraction: extract structured facts, decide action per fact, execute */
  private async processWithExtraction(input: ProcessTaskCompletionInput): Promise<void> {
    let facts: ExtractedFact[];
    try {
      facts = await this.extractFacts!(input.output, input.taskTitle ?? input.taskId, input.role ?? "unknown");
    } catch (err) {
      console.warn(`[Hippocampus] LLM extraction failed, falling back to raw: ${err instanceof Error ? err.message : String(err)}`);
      await this.processRawDump(input);
      return;
    }

    if (facts.length === 0) {
      await this.processRawDump(input);
      return;
    }

    // Cap to top-K by confidence so a long tail of low-signal facts can't
    // explode LLM cost. The extractor regularly emits 20-30 facts for
    // meaty tasks; the 6th-Nth are almost always restatements.
    const cappedFacts = facts.length > MAX_FACTS_PER_TASK
      ? [...facts].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_FACTS_PER_TASK)
      : facts;
    if (cappedFacts.length < facts.length) {
      console.log(`[Hippocampus] Capped ${facts.length} → ${cappedFacts.length} facts (top-${MAX_FACTS_PER_TASK} by confidence)`);
    }

    const now = new Date().toISOString();

    // Procedural facts use a different store + decision shape; keep them
    // on the per-fact path. There are usually 0-1 per task.
    const proceduralFacts = cappedFacts.filter((f) => f.type === "procedural");
    const memoryFacts = cappedFacts.filter((f) => f.type !== "procedural");

    for (const fact of proceduralFacts) {
      await this.routeProceduralFact(fact, input, now);
    }

    if (memoryFacts.length === 0) return;

    if (this.decideActionsBatch) {
      await this.routeMemoryFactsBatch(memoryFacts, input, now);
    } else {
      for (const fact of memoryFacts) {
        await this.routeMemoryFact(fact, input, now);
      }
    }
  }

  /** Route a procedural fact through action decision pipeline (ADD/UPDATE/DELETE/NONE) */
  private async routeProceduralFact(fact: ExtractedFact, input: ProcessTaskCompletionInput, now: string): Promise<void> {
    const newTrigger = fact.trigger ?? fact.content;
    const newAction = fact.action ?? fact.content;
    const factDescription = `When: ${newTrigger} → Do: ${newAction}`;

    // If we have an action decider, check existing habits first
    if (this.decideAction) {
      try {
        const existingHabits = await this.proceduralStore.list(input.agentId);
        const existingForDecision = existingHabits.map((h) => ({
          id: h.id,
          content: `When: ${h.trigger} → Do: ${h.action}`,
          type: "procedural",
          confidence: h.successRate,
        }));

        const decision = await this.decideAction(factDescription, existingForDecision);
        console.log(`[Hippocampus] Habit action decision: ${decision.action} (reason: ${decision.reason})`);

        switch (decision.action) {
          case "NONE":
            return; // Duplicate — skip
          case "UPDATE":
            if (decision.target_id) {
              await this.proceduralStore.update(decision.target_id, newTrigger, newAction, fact.confidence);
              console.log(`[Hippocampus] Updated habit ${decision.target_id}`);
            }
            return;
          case "DELETE":
            if (decision.target_id) {
              await this.proceduralStore.softDelete(decision.target_id);
              console.log(`[Hippocampus] Deactivated habit ${decision.target_id}`);
            }
            return;
          case "ADD":
            // Fall through to create new habit below
            break;
        }
      } catch (err) {
        console.warn(`[Hippocampus] Habit action decision failed, defaulting to ADD: ${err instanceof Error ? err.message : String(err)}`);
        // Fall through to ADD
      }
    }

    const habit: Habit = {
      id: `habit_${crypto.randomUUID()}`,
      companyId: input.companyId,
      agentId: input.agentId,
      name: fact.content.slice(0, 60),
      description: fact.content,
      trigger: newTrigger,
      action: newAction,
      status: "active",
      usageCount: 0,
      successRate: fact.confidence,
      createdAt: now,
      updatedAt: now,
    };
    await this.proceduralStore.add(habit);
    console.log(`[Hippocampus] Added new habit ${habit.id}`);
  }

  /**
   * Embed a fact and find its most-similar existing memories via vector
   * search. Falls back to list-based candidates if vector search isn't
   * wired or throws. Returns [] when the store has no memories yet —
   * callers can use that to short-circuit the LLM dedup call.
   */
  private async findSimilarMemoriesForFact(
    fact: ExtractedFact,
    input: ProcessTaskCompletionInput,
  ): Promise<{ id: string; content: string; type: string; confidence: number }[]> {
    const store = fact.type === "static" ? this.staticStore : this.dynamicStore;
    try {
      const factEmbedding = await embed(fact.content);
      if (store.searchByEmbedding) {
        const results = await store.searchByEmbedding(input.agentId, factEmbedding, 5);
        return results.map((r) => ({ id: r.id, content: r.content, type: r.type, confidence: r.confidence }));
      }
    } catch {
      // fall through to list-based fallback below
    }
    const all = await store.list(input.agentId);
    return all.slice(0, 5).map((m) => ({ id: m.id, content: m.content, type: m.type, confidence: m.confidence }));
  }

  /** Route a static/dynamic fact through the action decision pipeline */
  private async routeMemoryFact(fact: ExtractedFact, input: ProcessTaskCompletionInput, now: string): Promise<void> {
    // Step 1: Decide action — search similar memories and ask LLM
    let decision: MemoryAction = { action: "ADD", target_id: null, reason: "default" };

    if (this.decideAction) {
      try {
        const similar = await this.findSimilarMemoriesForFact(fact, input);
        // Skip the LLM dedup call when there's nothing to dedupe against —
        // the answer is always ADD. Saves one LLM round-trip per fact when
        // the store is fresh.
        if (similar.length === 0) {
          decision = { action: "ADD", target_id: null, reason: "no existing memories to dedupe against" };
        } else {
          decision = await this.decideAction(fact.content, similar);
        }
      } catch (err) {
        // Action decision failed — default to ADD (spec: worst case is slight duplication, GC cleans up)
        console.warn(`[Hippocampus] Action decision failed, defaulting to ADD: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 2: Execute the decided action via the shared helper used by
    // both the per-fact and batched paths.
    await this.executeMemoryDecision(fact, decision, input, now);
  }

  /**
   * Batched memory-fact pipeline: gather similar-memory context for every
   * fact in parallel, then ask the LLM ONCE for all decisions, then execute.
   *
   * This is the path that turns N+1 LLM calls (extract + N decisions) into
   * 2 calls (extract + 1 batched decision). Facts whose similar-memories
   * set is empty short-circuit to ADD locally and don't enter the batch.
   */
  private async routeMemoryFactsBatch(
    facts: ExtractedFact[],
    input: ProcessTaskCompletionInput,
    now: string,
  ): Promise<void> {
    // Gather similar-memory context for every fact in parallel.
    const similarSets = await Promise.all(
      facts.map((fact) => this.findSimilarMemoriesForFact(fact, input)),
    );

    // Partition: facts with no similar memories skip the LLM (always ADD);
    // the rest go into the batch.
    const decisions: MemoryAction[] = new Array(facts.length);
    const batchItems: BatchedActionInput[] = [];
    const batchIndices: number[] = [];

    for (let i = 0; i < facts.length; i++) {
      if (similarSets[i].length === 0) {
        decisions[i] = { action: "ADD", target_id: null, reason: "no existing memories to dedupe against" };
      } else {
        batchItems.push({ newFact: facts[i].content, existingMemories: similarSets[i] });
        batchIndices.push(i);
      }
    }

    if (batchItems.length > 0) {
      try {
        const batchDecisions = await this.decideActionsBatch!(batchItems);
        if (batchDecisions.length !== batchItems.length) {
          throw new Error(`Batch decider returned ${batchDecisions.length} decisions for ${batchItems.length} items`);
        }
        for (let i = 0; i < batchDecisions.length; i++) {
          decisions[batchIndices[i]] = batchDecisions[i];
        }
      } catch (err) {
        // Batch decider failed — default unresolved facts to ADD so we
        // don't silently lose memories. Worst case: slight duplication
        // that the GC sweep cleans up later.
        console.warn(`[Hippocampus] Batch action decision failed, defaulting batched facts to ADD: ${err instanceof Error ? err.message : String(err)}`);
        for (const idx of batchIndices) {
          decisions[idx] = { action: "ADD", target_id: null, reason: "batch decider failed" };
        }
      }
    }

    // Execute decisions sequentially against the store. Cheap relative to
    // the LLM calls we already saved.
    for (let i = 0; i < facts.length; i++) {
      await this.executeMemoryDecision(facts[i], decisions[i], input, now);
    }
  }

  /** Apply one already-decided action against the appropriate store. */
  private async executeMemoryDecision(
    fact: ExtractedFact,
    decision: MemoryAction,
    input: ProcessTaskCompletionInput,
    now: string,
  ): Promise<void> {
    const store = fact.type === "static" ? this.staticStore : this.dynamicStore;
    switch (decision.action) {
      case "ADD": {
        const unit: MemoryUnit = {
          id: `memory_${crypto.randomUUID()}`,
          companyId: input.companyId,
          agentId: input.agentId,
          sourceTaskId: input.taskId,
          sourceArtifactId: null,
          type: fact.type as "static" | "dynamic",
          visibility: "team",
          source: "system",
          content: fact.content,
          summary: fact.content.slice(0, 200),
          confidence: fact.confidence,
          tags: ["extracted"],
          createdAt: now,
          expiresAt: fact.is_temporal && fact.expiry_days
            ? new Date(Date.now() + fact.expiry_days * 24 * 60 * 60 * 1000).toISOString()
            : null,
        };
        await store.add(unit);
        console.log(`[Hippocampus] ADD: "${fact.content.slice(0, 60)}..." (${decision.reason})`);
        return;
      }
      case "UPDATE": {
        if (decision.target_id) {
          await store.update(decision.target_id, fact.content, fact.confidence);
          console.log(`[Hippocampus] UPDATE ${decision.target_id}: "${fact.content.slice(0, 60)}..." (${decision.reason})`);
        }
        return;
      }
      case "DELETE": {
        if (decision.target_id) {
          await store.softDelete(decision.target_id, `Contradicted by: ${fact.content.slice(0, 100)}`);
          console.log(`[Hippocampus] DELETE ${decision.target_id}: (${decision.reason})`);
        }
        return;
      }
      case "NONE": {
        console.log(`[Hippocampus] NONE: "${fact.content.slice(0, 60)}..." (${decision.reason})`);
        return;
      }
    }
  }

  /**
   * Semantic search over a single agent's memory store (spec 27 §6).
   *
   * `scope` controls whether delegation-typed memories (received handoffs)
   * are included: 'self' excludes them; 'company' includes them.
   *
   * `kind` filters on the memory tier: 'static' hits only staticStore,
   * 'dynamic' hits only dynamicStore, 'any' searches both.
   *
   * Zero LLM in the hot path: embed → searchByEmbedding → MMR rank → filter.
   * If the underlying stores don't expose vector search (in-memory fallback),
   * returns list()-sourced candidates with similarity=1.0 and no MMR.
   */
  async search(
    agentId: string,
    query: string,
    opts: {
      scope?: "self" | "company";
      kind?: "static" | "dynamic" | "any";
      limit?: number;
      since?: string;
    } = {},
  ): Promise<{ memories: ScoredMemory[]; totalSearched: number; queryEmbeddingMs: number }> {
    const scope = opts.scope ?? "self";
    const kind = opts.kind ?? "any";
    const limit = opts.limit ?? 5;
    const sinceTs = opts.since ? Date.parse(opts.since) : null;

    const hasVectorSearch =
      Boolean(this.staticStore.searchByEmbedding) &&
      Boolean(this.dynamicStore.searchByEmbedding);

    const embedStart = Date.now();
    const queryEmbedding = hasVectorSearch ? await embed(query) : null;
    const queryEmbeddingMs = Date.now() - embedStart;

    const overFetch = DEFAULT_RETRIEVAL_OPTIONS.overFetch;
    const candidateLimit = limit * overFetch;

    const [staticCandidates, dynamicCandidates] = await Promise.all([
      kind === "dynamic"
        ? Promise.resolve<RawCandidate[]>([])
        : this.fetchStaticCandidates(agentId, queryEmbedding, candidateLimit),
      kind === "static"
        ? Promise.resolve<RawCandidate[]>([])
        : this.fetchDynamicCandidates(agentId, queryEmbedding, candidateLimit),
    ]);

    const rawCandidates: RawCandidate[] = [...staticCandidates, ...dynamicCandidates];
    const totalSearched = rawCandidates.length;

    // Scope filter: 'self' excludes delegation-typed memories (received handoffs).
    const scopeFiltered = rawCandidates.filter((candidate) => {
      if (scope === "self" && candidate.type === "delegation") return false;
      if (sinceTs !== null && Date.parse(candidate.createdAt) < sinceTs) return false;
      return true;
    });

    const scored = rankAndSelect(scopeFiltered, `agent:${agentId}`, {
      ...DEFAULT_RETRIEVAL_OPTIONS,
      topK: limit,
    });

    return {
      memories: scored,
      totalSearched,
      queryEmbeddingMs,
    };
  }

  /**
   * Add a single memory unit, running the action decider for dedup.
   * Returns the final unit (if stored or updated) along with the decider's
   * verdict. Used by `memory_add_learning` (spec 27 §6) to surface
   * ADD/UPDATE/NONE action back to the caller.
   */
  async addMemory(
    unit: MemoryUnit,
    opts: { skipDedup?: boolean } = {},
  ): Promise<{
    memoryId: string;
    action: "ADD" | "UPDATE" | "NONE";
    reason: string;
    targetId: string | null;
  }> {
    const store = unit.type === "static" ? this.staticStore : this.dynamicStore;

    if (opts.skipDedup) {
      await store.add(unit);
      return { memoryId: unit.id, action: "ADD", reason: "skip-dedup", targetId: null };
    }

    if (this.decideAction) {
      try {
        let similar: { id: string; content: string; type: string; confidence: number }[] = [];
        try {
          const factEmbedding = await embed(unit.content);
          if (store.searchByEmbedding) {
            const results = await store.searchByEmbedding(unit.agentId, factEmbedding, 5);
            similar = results.map((r) => ({ id: r.id, content: r.content, type: r.type, confidence: r.confidence }));
          }
        } catch {
          const all = await store.list(unit.agentId);
          similar = all.slice(0, 5).map((m) => ({ id: m.id, content: m.content, type: m.type, confidence: m.confidence }));
        }

        const decision = await this.decideAction(unit.content, similar);

        if (decision.action === "NONE") {
          return { memoryId: decision.target_id ?? unit.id, action: "NONE", reason: decision.reason, targetId: decision.target_id };
        }
        if (decision.action === "UPDATE" && decision.target_id) {
          await store.update(decision.target_id, unit.content, unit.confidence);
          return { memoryId: decision.target_id, action: "UPDATE", reason: decision.reason, targetId: decision.target_id };
        }
        if (decision.action === "DELETE" && decision.target_id) {
          await store.softDelete(decision.target_id, `Contradicted by: ${unit.content.slice(0, 100)}`);
          await store.add(unit);
          return { memoryId: unit.id, action: "ADD", reason: `Replaced ${decision.target_id}: ${decision.reason}`, targetId: decision.target_id };
        }
        // ADD falls through
      } catch (err) {
        console.warn(`[Hippocampus] Action decision failed in addMemory, defaulting to ADD: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await store.add(unit);
    // Spec 32 — narrate memory writes for observability.
    observability.logEvent({
      event: "memory.written",
      companyId: unit.companyId,
      scope: `${unit.agentId}/${unit.type}`,
      sizeBytes: Buffer.byteLength(unit.content ?? "", "utf8"),
      ts: Date.now(),
    });
    return { memoryId: unit.id, action: "ADD", reason: "default", targetId: null };
  }

  /** Best-effort fetch of static candidates (vector search or list fallback). */
  private async fetchStaticCandidates(
    agentId: string,
    queryEmbedding: number[] | null,
    candidateLimit: number,
  ): Promise<RawCandidate[]> {
    if (queryEmbedding && this.staticStore.searchByEmbedding) {
      const results = await this.staticStore.searchByEmbedding(agentId, queryEmbedding, candidateLimit);
      return results.map((r) => ({ ...r, tier: "static" as const }));
    }
    const memories = await this.staticStore.list(agentId);
    return memories.map((m) => ({ ...m, similarity: 1.0, tier: "static" as const }));
  }

  /** Best-effort fetch of dynamic candidates (vector search or list fallback). */
  private async fetchDynamicCandidates(
    agentId: string,
    queryEmbedding: number[] | null,
    candidateLimit: number,
  ): Promise<RawCandidate[]> {
    if (queryEmbedding && this.dynamicStore.searchByEmbedding) {
      const results = await this.dynamicStore.searchByEmbedding(agentId, queryEmbedding, candidateLimit);
      return results.map((r) => ({
        ...r,
        tier: "dynamic" as const,
        decayedScore: (r).decayedScore,
      }));
    }
    const memories = await this.dynamicStore.list(agentId);
    return memories.map((m) => ({ ...m, similarity: 1.0, tier: "dynamic" as const }));
  }

  /**
   * Store pre-built memory units directly, bypassing LLM extraction.
   * Runs the action decider on each unit to avoid duplicates.
   * Returns the count of units actually stored (ADD or UPDATE).
   */
  async storeMemories(units: MemoryUnit[]): Promise<number> {
    let stored = 0;
    for (const unit of units) {
      const store = unit.type === "static" ? this.staticStore : this.dynamicStore;

      // Run action decider to avoid duplicates if available
      if (this.decideAction) {
        try {
          let similar: { id: string; content: string; type: string; confidence: number }[] = [];
          try {
            const factEmbedding = await embed(unit.content);
            if (store.searchByEmbedding) {
              const results = await store.searchByEmbedding(unit.agentId, factEmbedding, 5);
              similar = results.map((r) => ({ id: r.id, content: r.content, type: r.type, confidence: r.confidence }));
            }
          } catch {
            const all = await store.list(unit.agentId);
            similar = all.slice(0, 5).map((m) => ({ id: m.id, content: m.content, type: m.type, confidence: m.confidence }));
          }

          const decision = await this.decideAction(unit.content, similar);
          if (decision.action === "NONE") continue;
          if (decision.action === "UPDATE" && decision.target_id) {
            await store.update(decision.target_id, unit.content, unit.confidence);
            stored++;
            continue;
          }
          if (decision.action === "DELETE" && decision.target_id) {
            await store.softDelete(decision.target_id, `Contradicted by: ${unit.content.slice(0, 100)}`);
            continue;
          }
        } catch (err) {
          console.warn(`[Hippocampus] Action decision failed for storeMemories, defaulting to ADD: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await store.add(unit);
      stored++;
    }
    return stored;
  }

  /**
   * Run garbage collection: expire temporal dynamic facts, prune low-relevance
   * memories, and deactivate unused habits older than 30 days.
   */
  async runGC(companyId: string): Promise<GCResult> {
    const [deletedDynamicUnits, deactivatedHabits] = await Promise.all([
      this.dynamicStore.gc(companyId),
      this.proceduralStore.gc(companyId)
    ]);

    return {
      deletedDynamicUnits,
      deactivatedHabits,
      compactedEvents: 0
    };
  }
}

/** Factory: create a HippocampusService with optional dependency injection. */
export function createHippocampusService(dependencies?: HippocampusDependencies) {
  return new HippocampusService(dependencies);
}