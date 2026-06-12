import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  arceusRequest,
  failure,
  loadContext,
  run,
  success,
  type ToolResult,
} from "./_lib/envelope.js";

interface TaskShape {
  id: string;
  definitionOfDone?: string[];
}

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);

const diff = (criteria: string[], observed: string): { matches: string[]; gaps: string[]; unexpected: string[] } => {
  const observedLc = observed.toLowerCase();
  const observedTokens = new Set(tokenize(observed));
  const matches: string[] = [];
  const gaps: string[] = [];
  for (const crit of criteria) {
    const phrase = crit.toLowerCase();
    if (observedLc.includes(phrase)) {
      matches.push(crit);
      continue;
    }
    const tokens = tokenize(crit);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((t) => observedTokens.has(t)).length;
    if (hits / tokens.length >= 0.6) {
      matches.push(crit);
    } else {
      gaps.push(crit);
    }
  }

  const criteriaTokens = new Set(criteria.flatMap((c) => tokenize(c)));
  const unexpected = [...observedTokens]
    .filter((t) => !criteriaTokens.has(t))
    .filter((t) => /error|fail|exception|undefined|null|crash/.test(t));

  return { matches, gaps, unexpected };
};

export default tool({
  description: "Diff observed behavior text against the current task's definition-of-done. Returns {matches, gaps, unexpected}. QA-only.",
  args: {
    observed: z.string().min(1).max(50_000),
    criteria: z.array(z.string()).optional(),
    taskId: z.string().optional(),
  },
  execute: async ({ observed, criteria, taskId }, toolCtx) =>
    run(async () => {
      const ctx = loadContext(toolCtx);
      const resolvedTaskId = taskId ?? ctx.taskId;

      let crits = criteria;
      if (!crits || crits.length === 0) {
        if (!resolvedTaskId) {
          return failure(
            "No criteria and no taskId to fetch a definition-of-done from. Pass criteria[] or taskId.",
            "validation",
            "never",
            "payload_fixed",
          );
        }
        const res = await arceusRequest<ToolResult<{ task: TaskShape }>>(ctx, {
          method: "GET",
          path: `/api/internal/v1/tasks/${resolvedTaskId}`,
        });
        if (res.status >= 400) {
          return failure(
            `Could not load task ${resolvedTaskId} (HTTP ${res.status}).`,
            "upstream",
            "safe",
            "task_exists",
          );
        }
        crits = res.data?.data?.task?.definitionOfDone ?? [];
      }

      if (crits.length === 0) {
        return failure(
          `Task ${resolvedTaskId} has no definition-of-done to diff against.`,
          "validation",
          "never",
          "criteria_present",
        );
      }

      const result = diff(crits, observed);
      const verdict = result.gaps.length === 0 && result.unexpected.length === 0;
      return success(
        verdict
          ? `Observed behavior matches all ${crits.length} criteria.`
          : `Diff found ${result.gaps.length} gap(s) and ${result.unexpected.length} unexpected signal(s).`,
        {
          taskId: resolvedTaskId || undefined,
          criteriaCount: crits.length,
          ...result,
          verdict,
        },
      );
    }),
});

export { diff };
