/**
 * Spec 18 — Automated code review (adversarial verifier), gate-free edition.
 *
 * Runs AFTER a developer beat's edits land in git, NON-BLOCKING and
 * fire-and-forget: it never delays or fails the beat (fail-open). It
 * diffs what the beat wrote, asks a cheap LLM to review it for security /
 * correctness / quality issues, and on critical/high findings AUTO-CREATES
 * a `bug_fix` task assigned to the developer — which the heartbeat then
 * picks up and fixes on a later beat. No human gate, no blocking: this is
 * the "system reviews in parallel and auto-fixes" loop, consistent with
 * the gate-free sprint flow.
 *
 * Why not block / fix in-place during the beat? Single-threaded writes:
 * a concurrent fixer editing the same files as the live developer agent
 * corrupts the work. So review happens once the diff is committed, and
 * the fix is just another (serialized) beat.
 */
import { z } from "zod";
import { createWorkflowTask } from "@arceus/task-engine";
import { structuredCompletion } from "../infra/azure-openai.js";
import { buildSnapshotView } from "./snapshot-view.js";
import { emitReactive } from "./reactive.js";
import { upsertTask } from "../persistence/mutations/index.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { workspaceManager } from "../workspace/manager.js";
import { commitAllChanges, diffFullContent, diffNameOnly } from "../workspace/git-ops.js";

const MAX_DIFF_CHARS = 12_000;

const reviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["security", "correctness", "quality", "performance"]),
  file: z.string(),
  line: z.number().nullable(),
  description: z.string(),
  suggestion: z.string(),
});

const reviewReportSchema = z.object({
  findings: z.array(reviewFindingSchema),
});

const SYSTEM_PROMPT = `You are a senior code reviewer auditing a diff an AI developer just produced for a small single-page web product (Vite + React + TypeScript + Tailwind, shadcn/ui design system). Report ONLY real, actionable defects — be precise, not pedantic. Categorize and rank:
- critical: security holes (hardcoded secrets/API keys, eval() on user input, XSS via dangerouslySetInnerHTML of untrusted input, SQL/command injection), or code that cannot compile/run.
- high: clear correctness bugs (broken core feature logic, unhandled crashes on normal input, state never persisting when the spec requires it), or skipping the design system entirely (raw hex colors instead of tokens).
- medium: architecture smells (a single file >500 new lines, wrong layering), missing error handling on real failure paths.
- low: console.log left in, TODO/FIXME, unused imports.
Do NOT invent issues. If the diff is clean, return an empty findings array. Never report style nits as critical/high. Each finding: exact file + line (or null), what's wrong, and a concrete one-line fix.`;

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return diff.slice(0, MAX_DIFF_CHARS) + "\n\n... [diff truncated for review — review the above]";
}

/**
 * Review a developer beat's committed diff and auto-spawn a fix task on
 * critical/high findings. Best-effort: any failure is swallowed so the
 * beat is never affected. Call fire-and-forget (do NOT await in the beat
 * critical path).
 *
 * @param beforeSha HEAD sha captured at beat start (null = baseline).
 */
export async function reviewBeatAndAutoFix(args: {
  companyId: string;
  beatId: string;
  taskId: string | null;
  taskTitle: string;
  beforeSha: string | null;
}): Promise<void> {
  const { companyId, beatId, taskId, taskTitle, beforeSha } = args;
  await swallowAndAudit("code_review.beat", async () => {
    const productDir = workspaceManager.getLocalPath(companyId);

    // Commit whatever the beat wrote so we have a stable afterSha to diff.
    const afterSha = await commitAllChanges(productDir, `[review ${beatId}] ${taskTitle}`.slice(0, 100));
    if (!beforeSha || beforeSha === afterSha) return; // nothing changed since beat start

    const rawDiff = await diffFullContent(productDir, beforeSha, afterSha);
    if (!rawDiff.trim()) return; // only excluded files (lockfiles/deps) changed
    const filesChanged = await diffNameOnly(productDir, beforeSha, afterSha);

    const report = await structuredCompletion(
      "workerDeployment",
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Task: ${taskTitle}\nFiles changed: ${filesChanged.join(", ") || "(unknown)"}\n\nDiff:\n${truncateDiff(rawDiff)}`,
        },
      ],
      reviewReportSchema,
      "code_review",
      { temperature: 0.2 },
      { companyId, agentRole: "developer", runId: beatId, taskId: taskId ?? undefined },
    );

    const blocking = report.findings.filter((f) => f.severity === "critical" || f.severity === "high");
    if (report.findings.length > 0) {
      emitEmployeeActivity(
        "cto",
        "decision",
        `Code review of "${taskTitle.slice(0, 50)}": ${report.findings.length} finding(s), ${blocking.length} actionable`,
        { beatId, detail: { findings: report.findings.map((f) => ({ severity: f.severity, file: f.file, description: f.description })) } },
      );
    }
    if (blocking.length === 0) return;

    // Auto-fix: spawn ONE bug_fix task carrying the actionable findings.
    // Idempotency: skip if an open auto-review fix task already exists for
    // this source task (avoids piling up duplicates across reviews).
    const snapshot = await buildSnapshotView(companyId);
    const fixTitle = `Code review: fix ${blocking.length} issue(s) in ${taskTitle}`.slice(0, 80);
    const alreadyOpen = snapshot.tasks.some(
      (t) => t.title.startsWith("Code review: fix") && !["completed", "cancelled", "failed"].includes(t.status)
        && (t.description.includes(taskId ?? "__no_match__") || t.title.includes(taskTitle.slice(0, 30))),
    );
    if (alreadyOpen) return;

    const lines = blocking
      .map((f) => `- [${f.severity}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.description} → ${f.suggestion}`)
      .join("\n");
    const description = `Automated code review of the work for "${taskTitle}"${taskId ? ` (task ${taskId})` : ""} flagged ${blocking.length} actionable issue(s). Fix each, keep the design system + acceptance criteria intact, then complete with evidence:\n\n${lines}`;

    const fixTask = createWorkflowTask(
      snapshot,
      "bug_fix",
      "developer",
      fixTitle,
      description,
      `Code review found ${blocking.length} critical/high issue(s) that must be fixed.`,
      "All listed code-review findings resolved; build still passes.",
      blocking.map((f) => `${f.severity}: ${f.file}${f.line ? `:${f.line}` : ""} resolved`),
      "high",
      "planned",
      snapshot.company.currentSprintId ?? null,
    );
    await upsertTask(fixTask);
    emitReactive(companyId, "developer", "bug_reported");
    emitEmployeeActivity(
      "cto",
      "transition",
      `Code review spawned fix task ${fixTask.id} (${blocking.length} issue(s)) for "${taskTitle.slice(0, 40)}"`,
      { beatId, detail: { fixTaskId: fixTask.id, findings: blocking.length } },
    );
  }, { companyId, agentRole: "developer", beatId, detail: { taskId } });
}
