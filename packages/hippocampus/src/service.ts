import type { ActionDecider, DynamicMemoryStore, ExtractedFact, FactExtractor, GCResult, HabitMatcher, HippocampusGateway, MemoryAction, PreparedAgentContext, PrimingGenerator, PrimingStore, ProceduralMemoryStore, ProcessTaskCompletionInput, RetrievalOptions, StaticMemoryStore } from "./types";
import { InMemoryDynamicStore } from "./tiers/dynamic";
import { InMemoryPrimingStore, createDefaultPrimingState, renderPrimingDisposition, updatePrimingStateFromOutcome } from "./tiers/priming";
import { InMemoryProceduralStore } from "./tiers/procedural";
import { InMemoryStaticStore } from "./tiers/static";
import { embed } from "./backends/embedding.js";
import { rankAndSelect, DEFAULT_RETRIEVAL_OPTIONS } from "./engines/retrieval.js";
import type { RawCandidate } from "./engines/retrieval.js";
import type { Habit, MemoryUnit } from "@arceus/contracts";

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

export type HippocampusDependencies = {
  staticStore?: StaticMemoryStore;
  dynamicStore?: DynamicMemoryStore;
  proceduralStore?: ProceduralMemoryStore;
  primingStore?: PrimingStore;
  /** LLM-powered fact extractor. If not provided, falls back to raw output storage. */
  extractFacts?: FactExtractor;
  /** LLM-powered action decider (ADD/UPDATE/DELETE/NONE). If not provided, defaults to ADD. */
  decideAction?: ActionDecider;
  /** LLM-powered habit matcher. If not provided, falls back to naive token matching. */
  matchHabits?: HabitMatcher;
  /** LLM-powered priming disposition generator. If not provided, falls back to hardcoded thresholds. */
  generatePriming?: PrimingGenerator;
};

export class HippocampusService implements HippocampusGateway {
  private readonly staticStore: StaticMemoryStore;
  private readonly dynamicStore: DynamicMemoryStore;
  private readonly proceduralStore: ProceduralMemoryStore;
  private readonly primingStore: PrimingStore;
  private readonly extractFacts: FactExtractor | null;
  private readonly decideAction: ActionDecider | null;
  private readonly matchHabits: HabitMatcher | null;
  private readonly generatePriming: PrimingGenerator | null;

  constructor(dependencies: HippocampusDependencies = {}) {
    this.staticStore = dependencies.staticStore ?? new InMemoryStaticStore();
    this.dynamicStore = dependencies.dynamicStore ?? new InMemoryDynamicStore();
    this.proceduralStore = dependencies.proceduralStore ?? new InMemoryProceduralStore();
    this.primingStore = dependencies.primingStore ?? new InMemoryPrimingStore();
    this.extractFacts = dependencies.extractFacts ?? null;
    this.decideAction = dependencies.decideAction ?? null;
    this.matchHabits = dependencies.matchHabits ?? null;
    this.generatePriming = dependencies.generatePriming ?? null;
  }

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

    // LLM habit matching: filter all habits through LLM for relevance
    let habits: Habit[];
    if (this.matchHabits && allHabits.length > 0) {
      try {
        const matchedIds = await this.matchHabits(taskDescription, allHabits);
        const idSet = new Set(matchedIds);
        habits = allHabits.filter((h) => idSet.has(h.id));
        console.log(`[Hippocampus] LLM habit match: ${habits.length}/${allHabits.length} habits relevant`);
      } catch (err) {
        // Fallback to naive token matching if LLM fails
        console.warn(`[Hippocampus] LLM habit match failed, falling back to token match: ${err instanceof Error ? err.message : err}`);
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
          decayedScore: (r as any).decayedScore,
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

    // Generate priming disposition — LLM if available, hardcoded fallback otherwise
    let priming: string;
    if (primingState && this.generatePriming) {
      try {
        priming = await this.generatePriming(primingState);
        console.log(`[Hippocampus] LLM priming: "${priming}"`);
      } catch (err) {
        console.warn(`[Hippocampus] LLM priming failed, using fallback: ${err instanceof Error ? err.message : err}`);
        priming = renderPrimingDisposition(primingState);
      }
    } else {
      priming = primingState ? renderPrimingDisposition(primingState) : "Neutral. Start with a direct first pass.";
    }

    return { memories, habits, priming };
  }

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
      console.warn(`[Hippocampus] LLM extraction failed, falling back to raw: ${err instanceof Error ? err.message : err}`);
      await this.processRawDump(input);
      return;
    }

    if (facts.length === 0) {
      await this.processRawDump(input);
      return;
    }

    const now = new Date().toISOString();
    for (const fact of facts) {
      if (fact.type === "procedural") {
        await this.routeProceduralFact(fact, input, now);
      } else {
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
        console.warn(`[Hippocampus] Habit action decision failed, defaulting to ADD: ${err instanceof Error ? err.message : err}`);
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

  /** Route a static/dynamic fact through the action decision pipeline */
  private async routeMemoryFact(fact: ExtractedFact, input: ProcessTaskCompletionInput, now: string): Promise<void> {
    const store = fact.type === "static" ? this.staticStore : this.dynamicStore;

    // Step 1: Decide action — search similar memories and ask LLM
    let decision: MemoryAction = { action: "ADD", target_id: null, reason: "default" };

    if (this.decideAction) {
      try {
        // Embed the fact and search for similar existing memories
        let similar: Array<{ id: string; content: string; type: string; confidence: number }> = [];
        try {
          const factEmbedding = await embed(fact.content);
          if (store.searchByEmbedding) {
            const results = await store.searchByEmbedding(input.agentId, factEmbedding, 5);
            similar = results.map((r) => ({ id: r.id, content: r.content, type: r.type, confidence: r.confidence }));
          }
        } catch {
          // Embedding/search failed — fall back to list-based comparison
          const all = await store.list(input.agentId);
          similar = all.slice(0, 5).map((m) => ({ id: m.id, content: m.content, type: m.type, confidence: m.confidence }));
        }

        decision = await this.decideAction(fact.content, similar);
      } catch (err) {
        // Action decision failed — default to ADD (spec: worst case is slight duplication, GC cleans up)
        console.warn(`[Hippocampus] Action decision failed, defaulting to ADD: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 2: Execute the decided action
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
        break;
      }
      case "UPDATE": {
        if (decision.target_id) {
          await store.update(decision.target_id, fact.content, fact.confidence);
          console.log(`[Hippocampus] UPDATE ${decision.target_id}: "${fact.content.slice(0, 60)}..." (${decision.reason})`);
        }
        break;
      }
      case "DELETE": {
        if (decision.target_id) {
          await store.softDelete(decision.target_id, `Contradicted by: ${fact.content.slice(0, 100)}`);
          console.log(`[Hippocampus] DELETE ${decision.target_id}: (${decision.reason})`);
        }
        break;
      }
      case "NONE": {
        console.log(`[Hippocampus] NONE: "${fact.content.slice(0, 60)}..." (${decision.reason})`);
        break;
      }
    }
  }

  async storeMemories(units: MemoryUnit[]): Promise<number> {
    let stored = 0;
    for (const unit of units) {
      const store = unit.type === "static" ? this.staticStore : this.dynamicStore;

      // Run action decider to avoid duplicates if available
      if (this.decideAction) {
        try {
          let similar: Array<{ id: string; content: string; type: string; confidence: number }> = [];
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
          console.warn(`[Hippocampus] Action decision failed for storeMemories, defaulting to ADD: ${err instanceof Error ? err.message : err}`);
        }
      }

      await store.add(unit);
      stored++;
    }
    return stored;
  }

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

export function createHippocampusService(dependencies?: HippocampusDependencies) {
  return new HippocampusService(dependencies);
}