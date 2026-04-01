/**
 * Memory Lifecycle — hooks into the heartbeat to inject/extract
 * memories via the Hippocampus bridge before and after adapter runs.
 */

import type { Db } from "@paperclipai/db";
import type { HippocampusBridge } from "./hippocampus-contract.js";
import { getHippocampusBridge } from "./hippocampus-bridge.js";
import { logger } from "../middleware/logger.js";
import {
  INITIAL_PRIMING_STATE,
  type DelegationStyle,
  type MemoryPrimingState,
} from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";
import { memoryStoreService } from "./memory-store.js";
import { workingMemoryService } from "./working-memory.js";

type HippocampusLifecycleBridge = Pick<
  HippocampusBridge,
  "health" | "getEmbedding" | "extract" | "processTrajectory" | "getDelegationContext"
>;

function recallLimitForStyle(style: DelegationStyle | undefined): number {
  if (style === "directive") return 10;
  if (style === "autonomous") return 3;
  return 5;
}

function habitLimitForStyle(style: DelegationStyle | undefined): number {
  if (style === "directive") return 5;
  if (style === "autonomous") return 3;
  return 5;
}

function normalizeDelegationContext(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value && typeof value === "object") {
    const asRecord = value as Record<string, unknown>;
    const candidate = asRecord.context ?? asRecord.markdown ?? asRecord.content;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

async function isBridgeAvailable(
  bridge: Pick<HippocampusBridge, "health">,
  logContext: Record<string, unknown>,
): Promise<boolean> {
  try {
    await bridge.health();
    return true;
  } catch (err) {
    logger.warn(
      { err, ...logContext },
      "hippocampus: bridge unavailable (continuing without memory)",
    );
    return false;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizePrimingState(value: unknown): MemoryPrimingState {
  const current = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    confidence:
      typeof current.confidence === "number" ? clamp01(current.confidence) : INITIAL_PRIMING_STATE.confidence,
    caution:
      typeof current.caution === "number" ? clamp01(current.caution) : INITIAL_PRIMING_STATE.caution,
    morale:
      typeof current.morale === "number" ? clamp01(current.morale) : INITIAL_PRIMING_STATE.morale,
    recentEvents: Array.isArray(current.recentEvents)
      ? current.recentEvents.filter((item): item is string => typeof item === "string")
      : [...INITIAL_PRIMING_STATE.recentEvents],
  };
}

function buildPrimingMarkdown(state: MemoryPrimingState): string {
  const lines = [
    `- Confidence: ${(state.confidence * 100).toFixed(0)}%`,
    `- Caution: ${(state.caution * 100).toFixed(0)}%`,
    `- Morale: ${(state.morale * 100).toFixed(0)}%`,
  ];

  if (state.recentEvents.length > 0) {
    lines.push("- Recent signals:");
    for (const event of state.recentEvents.slice(0, 5)) {
      lines.push(`  - ${event}`);
    }
  }

  return lines.join("\n");
}

function normalizeRecentEvents(
  current: string[],
  additions: string[],
): string[] {
  const next: string[] = [];
  for (const value of [...additions, ...current]) {
    const trimmed = value.trim();
    if (!trimmed || next.includes(trimmed)) continue;
    next.push(trimmed);
    if (next.length >= 10) break;
  }
  return next;
}

function computeNextPrimingState(input: {
  current: MemoryPrimingState;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  recentEvents: string[];
}): MemoryPrimingState {
  const { current, outcome, recentEvents } = input;
  if (outcome === "succeeded") {
    return {
      confidence: clamp01(current.confidence + 0.06),
      caution: clamp01(current.caution - 0.02),
      morale: clamp01(current.morale + 0.08),
      recentEvents: normalizeRecentEvents(current.recentEvents, recentEvents),
    };
  }
  if (outcome === "failed") {
    return {
      confidence: clamp01(current.confidence - 0.08),
      caution: clamp01(current.caution + 0.1),
      morale: clamp01(current.morale - 0.08),
      recentEvents: normalizeRecentEvents(current.recentEvents, recentEvents),
    };
  }
  if (outcome === "timed_out") {
    return {
      confidence: clamp01(current.confidence - 0.04),
      caution: clamp01(current.caution + 0.05),
      morale: clamp01(current.morale - 0.04),
      recentEvents: normalizeRecentEvents(current.recentEvents, recentEvents),
    };
  }
  return {
    confidence: current.confidence,
    caution: clamp01(current.caution + 0.01),
    morale: clamp01(current.morale - 0.01),
    recentEvents: normalizeRecentEvents(current.recentEvents, recentEvents),
  };
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }
  throw lastError;
}

function logLifecycleCallFailure(
  operation: string,
  logContext: Record<string, unknown>,
  err: unknown,
): void {
  logger.warn({ err, ...logContext }, `hippocampus: ${operation} failed`);
}

/**
 * Pre-run: fetch priming prompt + recall relevant memories for the current
 * task context. Returns a markdown block suitable for injection into the
 * adapter prompt (e.g. via context.paperclipMemoryContext).
 */
export async function buildMemoryContextForRun(input: {
  db: Db;
  companyId: string;
  agentId: string;
  issueTitle: string | null;
  issueId: string | null;
  wakeReason: string | null;
  delegationStyle?: DelegationStyle;
  delegatorAgentId?: string | null;
}): Promise<string> {
  const { db, agentId, issueTitle, issueId, wakeReason, delegationStyle, delegatorAgentId } = input;
  const memoryStore = memoryStoreService(db);
  const workingMemory = workingMemoryService();

  try {
    const hippocampusBridge = getHippocampusBridge() as HippocampusLifecycleBridge;
    const recallLimit = recallLimitForStyle(delegationStyle);
    const habitLimit = habitLimitForStyle(delegationStyle);
    const query = [issueTitle, wakeReason, issueId].filter(Boolean).join(" — ");
    const [primingState, habits, recalled, rawDelegationContext] = await Promise.all([
      memoryStore.getPrimingState(agentId).catch((err) => {
        logLifecycleCallFailure("getPrimingState", { agentId }, err);
        return null;
      }),
      memoryStore.getActiveHabits(agentId).catch((err) => {
        logLifecycleCallFailure("getActiveHabits", { agentId }, err);
        return [];
      }),
      (async () => {
        if (!query) {
          return memoryStore.recallByDate({ agentId, topK: recallLimit });
        }
        try {
          if (!hippocampusBridge.getEmbedding) {
            const cachedEmbedding = await workingMemory.getCachedEmbedding(agentId);
            return cachedEmbedding
              ? await memoryStore.recall({ agentId, embedding: cachedEmbedding, topK: recallLimit })
              : await memoryStore.recallByDate({ agentId, topK: recallLimit });
          }
          const embedding = await hippocampusBridge.getEmbedding(query);
          await workingMemory.cacheEmbedding(agentId, embedding.embedding).catch((err) => {
            logLifecycleCallFailure("cacheEmbedding", { agentId }, err);
          });
          return await memoryStore.recall({
            agentId,
            embedding: embedding.embedding,
            topK: recallLimit,
          });
        } catch (err) {
          logLifecycleCallFailure("recall", { agentId, query }, err);
          const cachedEmbedding = await workingMemory.getCachedEmbedding(agentId).catch((cacheErr) => {
            logLifecycleCallFailure("getCachedEmbedding", { agentId }, cacheErr);
            return null;
          });
          return cachedEmbedding
            ? await memoryStore.recall({ agentId, embedding: cachedEmbedding, topK: recallLimit })
            : await memoryStore.recallByDate({ agentId, topK: recallLimit });
        }
      })(),
      delegatorAgentId && delegationStyle
        ? hippocampusBridge.getDelegationContext(delegatorAgentId, agentId, delegationStyle).catch((err) => {
          logLifecycleCallFailure("getDelegationContext", { agentId, delegatorAgentId }, err);
          return null;
        })
        : Promise.resolve(null),
    ]);

    const sections: string[] = [];
    const normalizedPrimingState = normalizePrimingState(primingState);

    sections.push(`## Agent Memory — Priming\n${buildPrimingMarkdown(normalizedPrimingState)}`);

    if (recalled.length > 0) {
      const lines = recalled
        .slice(0, recallLimit)
        .map((memory) => `- [${memory.memoryType ?? "memory"}] ${memory.content}`)
        .join("\n");
      sections.push(`## Agent Memory — Relevant Recall\n${lines}`);
    }

    if (habits.length > 0) {
      const lines = habits
        .slice(0, habitLimit)
        .map((habit) => `- When: ${habit.triggerCondition} → Do: ${habit.action} (confidence ${(habit.confidence * 100).toFixed(0)}%)`)
        .join("\n");
      sections.push(`## Agent Memory — Habits\n${lines}`);
    }

    const delegatorContext = normalizeDelegationContext(rawDelegationContext);
    if (delegatorContext) {
      sections.push(`## Delegator Context\n${delegatorContext}`);
    }

    if (sections.length === 1) {
      sections.push("## Agent Memory — Continuity\n- Memory substrate is active. Use the current task context together with your existing role identity.");
    }
    return sections.join("\n\n");
  } catch (err) {
    logger.warn({ err, agentId }, "hippocampus: failed to build full memory context, returning priming fallback");
    return `## Agent Memory — Priming\n${buildPrimingMarkdown({ ...INITIAL_PRIMING_STATE })}`;
  }
}

/**
 * Post-run: extract facts & process trajectory from the run output.
 * Best-effort — failures are logged and swallowed.
 */
export async function extractMemoriesFromRun(input: {
  db: Db;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueTitle: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  stdoutExcerpt: string;
  stderrExcerpt: string;
}): Promise<void> {
  const {
    db,
    companyId,
    agentId,
    runId,
    issueId,
    issueTitle,
    outcome,
    stdoutExcerpt,
    stderrExcerpt,
  } = input;
  const memoryStore = memoryStoreService(db);
  const startedAt = Date.now();

  try {
    const hippocampusBridge = getHippocampusBridge() as HippocampusLifecycleBridge;
    const messages: Array<{ role: string; content: string }> = [];
    if (stdoutExcerpt.trim()) {
      messages.push({ role: "assistant", content: stdoutExcerpt.trim() });
    }
    if (stderrExcerpt.trim()) {
      messages.push({ role: "system", content: `[stderr] ${stderrExcerpt.trim()}` });
    }

    if (messages.length === 0 || messages.every((m) => m.content.length < 20)) {
      return;
    }

    const container = issueId ? `issue:${issueId}` : `run:${runId}`;
    const extractResult = await withRetry(
      () => hippocampusBridge.extract(agentId, messages, container),
      3,
    );

    const trajectoryResult =
      issueId && (outcome === "succeeded" || outcome === "failed")
        ? await withRetry(
          () => hippocampusBridge.processTrajectory(
            agentId,
            issueId,
            outcome,
            outcome === "succeeded" ? 0.8 : 0.2,
            [
              {
                action: issueTitle ?? "heartbeat run",
                result: outcome,
                reasoning: `Extracted ${extractResult.added} new facts, updated ${extractResult.updated}, deleted ${extractResult.deleted}.`,
              },
            ],
            container,
          ),
          3,
        )
        : null;

    const distilled = trajectoryResult?.distilled;
    if (distilled && typeof distilled === "object") {
      const record = distilled as Record<string, unknown>;
      const strategy = typeof record.strategy === "string" ? record.strategy.trim() : "";
      const learnings = Array.isArray(record.learnings)
        ? record.learnings.filter((item): item is string => typeof item === "string")
        : [];
      if (strategy) {
        await memoryStore.writeMemory({
          companyId,
          agentId,
          content: strategy,
          embedding: Array.isArray(record.embedding)
            ? record.embedding.filter((item): item is number => typeof item === "number")
            : null,
          memoryType: "dynamic",
          container: typeof record.container === "string" && record.container.trim()
            ? record.container
            : container,
          confidence: typeof record.quality === "number" ? record.quality : 0.7,
          visibility: "private",
          sourceType: "distillation",
          sourceId: typeof record.trajectory_id === "string" ? record.trajectory_id : runId,
          metadata: learnings.length > 0 ? { learnings } : {},
        });
      }
    }

    const pattern = trajectoryResult?.pattern;
    if (pattern && typeof pattern === "object") {
      const record = pattern as Record<string, unknown>;
      const description = typeof record.description === "string" ? record.description.trim() : "";
      const strategy = typeof record.strategy === "string" ? record.strategy.trim() : "";
      if (description && strategy) {
        await memoryStore.upsertPattern({
          id: typeof record.id === "string" ? record.id : undefined,
          companyId,
          agentId,
          description,
          strategy,
          embedding: Array.isArray(record.embedding)
            ? record.embedding.filter((item): item is number => typeof item === "number")
            : null,
          usageCount: typeof record.usage_count === "number" ? record.usage_count : 0,
          successRate: typeof record.success_rate === "number" ? record.success_rate : 0,
          status: typeof record.status === "string" ? record.status : null,
          domain: typeof record.domain === "string" ? record.domain : null,
          createdAt: typeof record.created_at === "string" ? record.created_at : null,
          updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
        });
      }
    }

    const habit = trajectoryResult?.habit;
    if (habit && typeof habit === "object") {
      const record = habit as Record<string, unknown>;
      const triggerCondition = typeof record.trigger_condition === "string" ? record.trigger_condition.trim() : "";
      const action = typeof record.action === "string" ? record.action.trim() : "";
      if (triggerCondition && action) {
        await memoryStore.upsertHabit({
          id: typeof record.id === "string" ? record.id : undefined,
          companyId,
          agentId,
          triggerCondition,
          action,
          confidence: typeof record.confidence === "number" ? record.confidence : 0.5,
          usageCount: typeof record.usage_count === "number" ? record.usage_count : 0,
          sourcePatternId: typeof record.formed_from_id === "string" ? record.formed_from_id : null,
          isActive: typeof record.is_active === "boolean" ? record.is_active : true,
          createdAt: typeof record.created_at === "string" ? record.created_at : null,
        });
      }
    }

    const priorPriming = normalizePrimingState(await memoryStore.getPrimingState(agentId));
    const distilledLearnings =
      trajectoryResult?.distilled && typeof trajectoryResult.distilled === "object"
        ? ((trajectoryResult.distilled as Record<string, unknown>).learnings as unknown[] | undefined)
          ?.filter((item): item is string => typeof item === "string")
          ?? []
        : [];
    const nextPrimingState = computeNextPrimingState({
      current: priorPriming,
      outcome,
      recentEvents: [
        issueId ? `Task ${issueId}: ${outcome}` : `Run ${runId}: ${outcome}`,
        ...distilledLearnings,
      ],
    });
    await memoryStore.updatePrimingState(agentId, companyId, nextPrimingState);

    await memoryStore.logOperation({
      companyId,
      agentId,
      operationType: "post_run_extraction",
      scope: { runId, issueId, outcome },
      resultCount: extractResult.added + extractResult.updated,
      latencyMs: Date.now() - startedAt,
      success: true,
    });

    logger.info(
      {
        agentId,
        runId,
        extracted: { added: extractResult.added, updated: extractResult.updated, deleted: extractResult.deleted },
      },
      "hippocampus: post-run memory extraction completed",
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await memoryStore.logOperation({
      companyId,
      agentId,
      operationType: "post_run_extraction",
      scope: { runId, issueId, outcome },
      latencyMs: Date.now() - startedAt,
      success: false,
      error: errorMessage,
    }).catch((logError) => {
      logger.error({ err: logError, agentId, runId }, "failed to log memory extraction failure");
    });
    publishLiveEvent({
      companyId,
      type: "memory:extraction_failed",
      payload: {
        agentId,
        runId,
        issueId,
        outcome,
        error: errorMessage,
      },
    });
    throw err;
  }
}

export async function recordDelegationEvent(input: {
  fromAgentId: string;
  toAgentId: string;
  taskDescription: string;
  style: DelegationStyle;
  issueId: string | null;
}): Promise<void> {
  try {
    const hippocampusBridge = getHippocampusBridge() as HippocampusLifecycleBridge;

    const healthy = await isBridgeAvailable(hippocampusBridge, {
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      issueId: input.issueId,
    });
    if (!healthy) return;

    const issueSuffix = input.issueId ? ` (issue: ${input.issueId})` : "";
    const delegatorMessage = {
      role: "system",
      content:
        `Delegated task to ${input.toAgentId}: "${input.taskDescription}" `
        + `(style: ${input.style})${issueSuffix}`,
    };
    const delegateeMessage = {
      role: "system",
      content:
        `Received delegated task from ${input.fromAgentId}: "${input.taskDescription}" `
        + `(style: ${input.style})${issueSuffix}`,
    };

    await Promise.all([
      hippocampusBridge.extract(input.fromAgentId, [delegatorMessage]).catch((err) => {
        logLifecycleCallFailure("recordDelegationEvent.delegator", input, err);
        return null;
      }),
      hippocampusBridge.extract(input.toAgentId, [delegateeMessage]).catch((err) => {
        logLifecycleCallFailure("recordDelegationEvent.delegatee", input, err);
        return null;
      }),
    ]);
  } catch (err) {
    logger.warn(
      { err, ...input },
      "hippocampus: failed to record delegation event (non-fatal)",
    );
  }
}
