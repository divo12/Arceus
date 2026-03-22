/**
 * Memory Lifecycle — hooks into the heartbeat to inject/extract
 * memories via the Hippocampus sidecar before and after adapter runs.
 */

import { hippocampusClient } from "./hippocampus-client.js";
import { logger } from "../middleware/logger.js";

const MEMORY_ENABLED = process.env.HIPPOCAMPUS_API_URL != null;

/**
 * Pre-run: fetch priming prompt + recall relevant memories for the current
 * task context.  Returns a markdown block suitable for injection into the
 * adapter prompt (e.g. via context.paperclipMemoryContext).
 *
 * On failure (sidecar down, timeout, etc.) returns null so the heartbeat
 * can continue without memory.
 */
export async function buildMemoryContextForRun(input: {
  agentId: string;
  issueTitle: string | null;
  issueId: string | null;
  wakeReason: string | null;
}): Promise<string | null> {
  if (!MEMORY_ENABLED) return null;

  const { agentId, issueTitle, issueId, wakeReason } = input;

  try {
    const healthy = await hippocampusClient.health().then(() => true).catch(() => false);
    if (!healthy) return null;

    // Fetch priming + habits + recall in parallel
    const query = [issueTitle, wakeReason, issueId].filter(Boolean).join(" — ");
    const [priming, habits, recalled] = await Promise.all([
      hippocampusClient.getPriming(agentId).catch(() => ({ prompt: "" })),
      hippocampusClient.getHabits(agentId, query).catch(() => ({ habits: [] })),
      query
        ? hippocampusClient.recall(agentId, query).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] }),
    ]);

    const sections: string[] = [];

    // Priming — long-term identity/preferences context
    if (priming.prompt.trim()) {
      sections.push(`## Agent Memory — Priming\n${priming.prompt.trim()}`);
    }

    // Recalled memories relevant to the current task
    if (recalled.items.length > 0) {
      const lines = recalled.items
        .slice(0, 10)
        .map((m) => `- [${m.kind}] ${m.content}`)
        .join("\n");
      sections.push(`## Agent Memory — Relevant Recall\n${lines}`);
    }

    // Habits for the current context
    if (habits.habits.length > 0) {
      const lines = habits.habits
        .slice(0, 5)
        .map((h) => `- When: ${h.trigger} → Do: ${h.action} (confidence ${(h.confidence * 100).toFixed(0)}%)`)
        .join("\n");
      sections.push(`## Agent Memory — Habits\n${lines}`);
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
  if (!MEMORY_ENABLED) return;

  const { agentId, runId, issueId, issueTitle, outcome, stdoutExcerpt, stderrExcerpt } = input;

  try {
    const healthy = await hippocampusClient.health().then(() => true).catch(() => false);
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
    const extractResult = await hippocampusClient.extract(agentId, messages).catch((err) => {
      logger.warn({ err, agentId, runId }, "hippocampus: extract failed");
      return null;
    });

    // Process trajectory for task-level learning
    if (issueId && (outcome === "succeeded" || outcome === "failed")) {
      const quality = outcome === "succeeded" ? 0.8 : 0.2;
      await hippocampusClient
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
          logger.warn({ err, agentId, runId }, "hippocampus: processTrajectory failed");
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
