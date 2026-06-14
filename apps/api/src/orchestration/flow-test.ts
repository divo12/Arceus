/**
 * Flow-test integration — calls the standalone browser-agent QA service
 * (services/flow-tester) at sprint finalize to actually DRIVE the built
 * product in a real browser (create/edit/delete, search, AI buttons) and judge
 * whether the core flow works + whether the UI is god-tier or basic. On
 * problems it auto-spawns a `bug_fix` task (same loop as the code-review
 * verifier) so the next sprint fixes it.
 *
 * Dormant until `FLOW_TESTER_URL` is set (the service's Railway private URL,
 * e.g. http://flow-tester.railway.internal:8080). Fail-open: never blocks or
 * fails sprint finalization.
 */
import { createWorkflowTask } from "@arceus/task-engine";
import { buildSnapshotView } from "./snapshot-view.js";
import { emitReactive } from "./reactive.js";
import { upsertTask } from "../persistence/mutations/index.js";
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

function verdictFailed(report: FlowTestReport): boolean {
  const v = (report.verdict ?? "").trim();
  if (report.is_successful === false) return true;
  if (/VERDICT:\s*FAIL/i.test(v)) return true;
  if (/DESIGN:\s*basic/i.test(v)) return true;
  if (/ISSUES:/i.test(v) && !/ISSUES:\s*(none|n\/a)/i.test(v)) return true;
  return false;
}

/**
 * Drive the live product in a real browser and, on failure, spawn a fix task.
 * Call fire-and-forget from sprint finalize.
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

    const res = await fetch(`${FLOW_TESTER_URL}/flow-test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(FLOW_TESTER_TOKEN ? { Authorization: `Bearer ${FLOW_TESTER_TOKEN}` } : {}),
      },
      body: JSON.stringify({ url: previewUrl, goal, max_steps: 12 }),
      signal: AbortSignal.timeout(FLOW_TEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      emitEmployeeActivity("tester", "error", `Flow-test service returned ${res.status} for sprint ${sprintNumber}`, { detail: { sprintId, previewUrl } });
      return;
    }

    const report = (await res.json()) as FlowTestReport;
    const verdict = (report.verdict ?? "").trim();
    const failed = verdictFailed(report);

    emitEmployeeActivity(
      "tester",
      "decision",
      `Flow-test of "${snapshot.company.name}" (sprint ${sprintNumber}): ${failed ? "ISSUES FOUND" : "PASS"}`,
      { detail: { sprintId, finalUrl: report.final_url, verdict: verdict.slice(0, 800) } },
    );
    if (!failed) return;

    // Idempotency: don't pile up flow-test fix tasks.
    const fresh = await buildSnapshotView(companyId);
    const alreadyOpen = fresh.tasks.some(
      (t) => t.title.startsWith("Flow-test: fix") && !["completed", "cancelled", "failed"].includes(t.status),
    );
    if (alreadyOpen) return;

    const description = `A real end-to-end BROWSER flow-test of the live product (after sprint ${sprintNumber}) found problems. An LLM agent drove the actual UI like a user. Fix each issue, keep the design system + acceptance criteria intact, then complete with evidence.\n\nBrowser-agent verdict:\n${verdict.slice(0, 2000)}`;

    const fixTask = createWorkflowTask(
      fresh,
      "bug_fix",
      "developer",
      `Flow-test: fix issues from sprint ${sprintNumber}`.slice(0, 80),
      description,
      "A real browser flow-test of the product surfaced broken/dead/basic UI.",
      "All flow-test issues resolved: the core flow works end-to-end in a real browser and the UI clears the god-tier bar.",
      ["Core flow works in a real browser", "No dead controls or errors", "UI is not basic/generic"],
      "high",
      "planned",
      fresh.company.currentSprintId ?? null,
    );
    await upsertTask(fixTask);
    emitReactive(companyId, "developer", "bug_reported");
    emitEmployeeActivity("tester", "transition", `Flow-test spawned fix task ${fixTask.id} for sprint ${sprintNumber}`, { detail: { sprintId, fixTaskId: fixTask.id } });
  }, { companyId, agentRole: "tester", detail: { sprintId } });
}
