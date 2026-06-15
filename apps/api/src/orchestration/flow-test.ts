/**
 * Flow-test integration — calls the standalone browser-agent QA service
 * (services/flow-tester) at sprint finalize to actually DRIVE the built product
 * in a real browser (create/edit/delete, search, AI buttons) and judge whether
 * the core flow works + whether the UI is god-tier or basic.
 *
 * Routing (2026-06-15): the review is framed as the CEO examining the live
 * product to plan the NEXT sprint. Findings become a `follow_up` SUGGESTION
 * (status `created`, no sprint) that surfaces in the CEO's between-sprints
 * retrospective — the CEO proposes the worthwhile ones in a FUTURE sprint. They
 * are NEVER jammed into the just-completed ("this") sprint as a developer
 * bug_fix, and no agent is woken to act on them mid-sprint.
 *
 * Dormant until `FLOW_TESTER_URL` is set. Fail-open: never blocks or fails
 * sprint finalization.
 */
import { createWorkflowTask } from "@arceus/task-engine";
import type { CompanySnapshot, Task } from "@arceus/contracts";
import { buildSnapshotView } from "./snapshot-view.js";
import { upsertTask, appendChatMessage } from "../persistence/mutations/index.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { swallowAndAudit } from "../observability/swallow.js";

const FLOW_TESTER_URL = (process.env.FLOW_TESTER_URL ?? "").replace(/\/+$/, "");
const FLOW_TESTER_TOKEN = process.env.FLOW_TESTER_TOKEN ?? "";
const FLOW_TEST_TIMEOUT_MS = 240_000;

/** True when the flow-tester service is configured (env present). */
export function flowTesterConfigured(): boolean {
  return FLOW_TESTER_URL.length > 0;
}

interface FlowTestReport {
  ok?: boolean;
  is_successful?: boolean | null;
  verdict?: string;
  action_trace?: unknown[];
  final_url?: string;
}

export function verdictFailed(report: FlowTestReport): boolean {
  const v = (report.verdict ?? "").trim();
  if (report.is_successful === false) return true;
  if (/VERDICT:\s*FAIL/i.test(v)) return true;
  if (/DESIGN:\s*basic/i.test(v)) return true;
  if (/ISSUES:/i.test(v) && !/ISSUES:\s*(none|n\/a)/i.test(v)) return true;
  return false;
}

/**
 * Build the CEO-facing suggestion task from a browser review verdict.
 *
 * CRITICAL: `kind: "follow_up"` + `status: "created"` is exactly what the CEO's
 * between-sprints retrospective surfaces (see ceo.ts), and `sprintId` is forced
 * to `null` so the suggestion is BACKLOG — `createWorkflowTask` would otherwise
 * fall back to `company.currentSprintId` (the just-completed sprint), which is
 * precisely the "don't put it in this sprint" failure we're avoiding.
 */
export function buildFlowTestSuggestionTask(
  snapshot: CompanySnapshot,
  sprintNumber: number,
  verdict: string,
): Task {
  const description =
    `A real end-to-end BROWSER review of the live product (after sprint ${sprintNumber}) by an autonomous QA agent surfaced improvements. ` +
    `These are SUGGESTIONS for the CEO to consider proposing in a FUTURE sprint — NOT fixes for the just-completed sprint.\n\n` +
    `Browser-agent review:\n${verdict.slice(0, 2000)}`;

  const base = createWorkflowTask(
    snapshot,
    "follow_up",
    "developer",
    `Flow-test suggestion (sprint ${sprintNumber} review)`.slice(0, 80),
    description,
    "A real browser review of the shipped product surfaced UX/UI improvements.",
    "The CEO proposes the worthwhile improvements into a FUTURE sprint; the core flow + design clear the bar.",
    ["Core flow works in a real browser", "No dead controls or errors", "UI is not basic/generic"],
    "medium",
    "created",
    null,
  );
  // Force backlog: createWorkflowTask coalesces a null sprintId to the current
  // sprint. We must NOT land in the just-completed sprint.
  return { ...base, sprintId: null };
}

/** Append a CEO chat card so the company feed shows the CEO reviewing the live product. */
async function appendCeoReviewCard(
  companyId: string,
  sprintNumber: number,
  content: string,
  phase: string,
): Promise<void> {
  await appendChatMessage({
    id: `chat_${crypto.randomUUID()}`,
    companyId,
    sprintId: null,
    agentId: null,
    role: "ceo",
    content,
    cardType: "status_update",
    cardData: { phase, sprintNumber },
    createdAt: new Date().toISOString(),
  });
}

/**
 * Drive the live product in a real browser, framed as the CEO examining the
 * product to plan the next sprint. On findings, file a CEO-facing suggestion for
 * a FUTURE sprint. Call fire-and-forget from sprint finalize.
 */
export async function runFlowTestAndReport(args: {
  companyId: string;
  sprintId: string;
  sprintNumber: number;
  previewUrl: string;
}): Promise<void> {
  if (!FLOW_TESTER_URL) return; // not configured — no-op
  const { companyId, sprintId, sprintNumber, previewUrl } = args;

  await swallowAndAudit("flow_test.sprint", async () => {
    const snapshot = await buildSnapshotView(companyId);
    const intent = snapshot.company.goal || snapshot.company.name;
    const goal = `The product under test is: "${snapshot.company.name}". Its intent: ${intent}. Exercise the core user flows of THIS product specifically.`;

    // Frontend signal: the CEO is examining the live website to plan next sprint.
    emitEmployeeActivity("ceo", "context", `Examining the live product to plan the next sprint — reviewing ${previewUrl} in a real browser`, {
      detail: { sprintId, previewUrl, phase: "reviewing_product" },
    });
    await appendCeoReviewCard(
      companyId,
      sprintNumber,
      `🔍 Reviewing the shipped product live in a browser to decide what to improve in the next sprint…`,
      "reviewing_product",
    );

    const res = await fetch(`${FLOW_TESTER_URL}/flow-test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(FLOW_TESTER_TOKEN ? { Authorization: `Bearer ${FLOW_TESTER_TOKEN}` } : {}),
      },
      body: JSON.stringify({ url: previewUrl, goal, max_steps: 8 }),
      signal: AbortSignal.timeout(FLOW_TEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      emitEmployeeActivity("ceo", "error", `Could not review the live product for sprint ${sprintNumber} (service ${res.status})`, { detail: { sprintId, previewUrl } });
      return;
    }

    const report = (await res.json()) as FlowTestReport;
    const verdict = (report.verdict ?? "").trim();
    const failed = verdictFailed(report);

    emitEmployeeActivity(
      "ceo",
      "decision",
      `Reviewed "${snapshot.company.name}" live (after sprint ${sprintNumber}): ${failed ? "improvements to propose next sprint" : "looks good — nothing to add"}`,
      { detail: { sprintId, finalUrl: report.final_url, verdict: verdict.slice(0, 800), phase: failed ? "next_sprint_planning" : "reviewed_ok" } },
    );

    if (!failed) {
      await appendCeoReviewCard(
        companyId,
        sprintNumber,
        `✅ I reviewed the live product — the core flow works and the design holds up. Nothing to add for the next sprint.`,
        "reviewed_ok",
      );
      return;
    }

    // Idempotency: don't pile up flow-test suggestions.
    const fresh = await buildSnapshotView(companyId);
    const alreadyOpen = fresh.tasks.some(
      (t) => t.title.startsWith("Flow-test suggestion") && !["completed", "cancelled", "failed"].includes(t.status),
    );

    // CEO card: the CEO is proposing these for the NEXT sprint (not this one).
    await appendCeoReviewCard(
      companyId,
      sprintNumber,
      `📋 I reviewed the live product and I'm noting improvements to propose in the NEXT sprint:\n\n${verdict.slice(0, 1200)}`,
      "next_sprint_planning",
    );

    if (alreadyOpen) return;

    // File a CEO-facing suggestion (backlog follow_up) for a FUTURE sprint.
    const suggestion = buildFlowTestSuggestionTask(fresh, sprintNumber, verdict);
    await upsertTask(suggestion);
    emitEmployeeActivity("ceo", "transition", `Filed a next-sprint suggestion from the live review (${suggestion.id})`, { detail: { sprintId, suggestionTaskId: suggestion.id, phase: "next_sprint_planning" } });
  }, { companyId, agentRole: "ceo", detail: { sprintId } });
}
