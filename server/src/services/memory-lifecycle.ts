/**
 * Memory Lifecycle — hooks into the heartbeat to inject/extract
 * memories via the Hippocampus bridge before and after adapter runs.
 */

import type { HippocampusBridge } from "./hippocampus-contract.js";
import { getHippocampusBridge } from "./hippocampus-bridge.js";
import { logger } from "../middleware/logger.js";
import type { DelegationStyle } from "@paperclipai/shared";

type HippocampusLifecycleBridge = Pick<
  HippocampusBridge,
  "mode" | "health" | "getPriming" | "getHabits" | "recall" | "extract" | "processTrajectory" | "getDelegationContext"
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

function logLifecycleCallFailure(
  operation: string,
  logContext: Record<string, unknown>,
  err: unknown,
): void {
  logger.warn({ err, ...logContext }, `hippocampus: ${operation} failed`);
}

/**
 * Pre-run: fetch priming prompt + recall relevant memories for the current
 * task context.  Returns a markdown block suitable for injection into the
 * adapter prompt (e.g. via context.paperclipMemoryContext).
 *
 * On failure (runtime down, timeout, etc.) returns null so the heartbeat
 * can continue without memory.
 */
export async function buildMemoryContextForRun(input: {
  agentId: string;
  issueTitle: string | null;
  issueId: string | null;
  wakeReason: string | null;
  delegationStyle?: DelegationStyle;
  delegatorAgentId?: string | null;
}): Promise<string | null> {
  const { agentId, issueTitle, issueId, wakeReason, delegationStyle, delegatorAgentId } = input;

  try {
    const hippocampusBridge = getHippocampusBridge() as HippocampusLifecycleBridge;
    if (hippocampusBridge.mode === "off") return null;

    const healthy = await isBridgeAvailable(hippocampusBridge, { agentId });
    if (!healthy) return null;

    const recallLimit = recallLimitForStyle(delegationStyle);
    const habitLimit = habitLimitForStyle(delegationStyle);
    const query = [issueTitle, wakeReason, issueId].filter(Boolean).join(" — ");
    const [priming, habits, recalled, rawDelegationContext] = await Promise.all([
      hippocampusBridge.getPriming(agentId).catch((err) => {
        logLifecycleCallFailure("getPriming", { agentId }, err);
        return { prompt: "" };
      }),
      hippocampusBridge.getHabits(agentId, query).catch((err) => {
        logLifecycleCallFailure("getHabits", { agentId }, err);
        return { habits: [] };
      }),
      query
        ? hippocampusBridge.recall(agentId, query, undefined, recallLimit).catch((err) => {
          logLifecycleCallFailure("recall", { agentId }, err);
          return { items: [] };
        })
        : Promise.resolve({ items: [] }),
      delegatorAgentId && delegationStyle
        ? hippocampusBridge.getDelegationContext(delegatorAgentId, agentId, delegationStyle).catch((err) => {
          logLifecycleCallFailure("getDelegationContext", { agentId, delegatorAgentId }, err);
          return null;
        })
        : Promise.resolve(null),
    ]);

    const sections: string[] = [];

    if (priming.prompt.trim()) {
      sections.push(`## Agent Memory — Priming\n${priming.prompt.trim()}`);
    }

    if (recalled.items.length > 0) {
      const lines = recalled.items
        .slice(0, recallLimit)
        .map((m) => `- [${m.kind}] ${m.content}`)
        .join("\n");
      sections.push(`## Agent Memory — Relevant Recall\n${lines}`);
    }

    if (habits.habits.length > 0) {
      const lines = habits.habits
        .slice(0, habitLimit)
        .map((h) => `- When: ${h.trigger} → Do: ${h.action} (confidence ${(h.confidence * 100).toFixed(0)}%)`)
        .join("\n");
      sections.push(`## Agent Memory — Habits\n${lines}`);
    }

    const delegatorContext = normalizeDelegationContext(rawDelegationContext);
    if (delegatorContext) {
      sections.push(`## Delegator Context\n${delegatorContext}`);
    }

    if (sections.length === 0) return null;
    return sections.join("\n\n");
  } catch (err) {
    logger.warn(
      { err, agentId },
      "hippocampus: failed to build memory context for run (continuing without memory)",
    );
    return null;
  }
}

/**
 * Post-run: extract facts & process trajectory from the run output.
 * Best-effort — failures are logged and swallowed.
 */
export async function extractMemoriesFromRun(input: {
  agentId: string;
  runId: string;
  issueId: string | null;
  issueTitle: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  stdoutExcerpt: string;
  stderrExcerpt: string;
}): Promise<void> {
  const { agentId, runId, issueId, issueTitle, outcome, stdoutExcerpt, stderrExcerpt } = input;

  try {
    const hippocampusBridge = getHippocampusBridge() as HippocampusLifecycleBridge;
    if (hippocampusBridge.mode === "off") return;

    const healthy = await isBridgeAvailable(hippocampusBridge, { agentId, runId });
    if (!healthy) return;

    // Build pseudo-conversation messages from the run excerpts for extraction
    const messages: Array<{ role: string; content: string }> = [];
    if (stdoutExcerpt.trim()) {
      messages.push({ role: "assistant", content: stdoutExcerpt.trim() });
    }
    if (stderrExcerpt.trim()) {
      messages.push({ role: "system", content: `[stderr] ${stderrExcerpt.trim()}` });
    }

    // Only extract if there's meaningful content
    if (messages.length === 0 || messages.every((m) => m.content.length < 20)) {
      return;
    }

    // Extract facts from the conversation
    const extractResult = await hippocampusBridge.extract(agentId, messages).catch((err) => {
      logLifecycleCallFailure("extract", { agentId, runId }, err);
      return null;
    });

    // Process trajectory for task-level learning
    if (issueId && (outcome === "succeeded" || outcome === "failed")) {
      const quality = outcome === "succeeded" ? 0.8 : 0.2;
      await hippocampusBridge
        .processTrajectory(
          agentId,
          issueId,
          outcome,
          quality,
          [
            {
              action: issueTitle ?? "heartbeat run",
              result: outcome,
              reasoning: extractResult
                ? `Extracted ${extractResult.added} new facts, updated ${extractResult.updated}`
                : "no facts extracted",
            },
          ],
        )
        .catch((err) => {
          logLifecycleCallFailure("processTrajectory", { agentId, runId }, err);
        });
    }

    logger.info(
      {
        agentId,
        runId,
        extracted: extractResult ? { added: extractResult.added, updated: extractResult.updated } : null,
      },
      "hippocampus: post-run memory extraction completed",
    );
  } catch (err) {
    logger.warn(
      { err, agentId, runId },
      "hippocampus: post-run memory extraction failed (non-fatal)",
    );
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
    if (hippocampusBridge.mode === "off") return;

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
