import { z } from "zod";
import type { AgentIdentity, AgentBeatContext, SprintReviewState, Task, DefectArea } from "@arceus/contracts";
import { createWorkflowTask, nowIso } from "@arceus/task-engine";
import { getRoleSoul, getAgentSkills } from "@arceus/company-runtime";
import {
  getSnapshot,
  upsertTask,
  updateSprint,
} from "../persistence/store.js";
import {
  persistRuntimeArtifact,
  listPersistedArtifacts,
} from "../persistence/artifact-persistence.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import {
  emitGraphDecision,
  emitGraphNodeAdded,
  emitGraphBeatStarted,
  emitGraphBeatCompleted,
} from "../observability/graph-emitter.js";
import {
  structuredCompletion,
  startBeatTokenAccumulator,
  drainBeatTokenAccumulator,
} from "../infra/azure-openai.js";
import { probePreviewHealth, getLocalPreviewState } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { checkEntryPointImports, generateOrphanWiringPrescription } from "../workspace/entry-check.js";
import { ensureAgentSession } from "../prompts/llm.js";
import { touchAgentSession } from "../agents/sessions.js";
import { runPromptText } from "../prompts/llm.js";
import { emitReactive } from "../orchestration/reactive.js";
import { productDir } from "../orchestration/state.js";
import { buildGateFailureBugFields, buildBugFixTaskFields, shouldEscalate } from "./review-helpers.js";
import { runVerificationGate } from "./verification-gate.js";
import { finalizeSprintCompletion } from "./lifecycle.js";

// ── QA Report Schema & types ────────────────────────────────────

interface QAFinding {
  taskId: string;
  defectArea: DefectArea;
  severity: Task["priority"];
  description: string;
  expected: string;
  actual: string;
  file: string;
  fixSuggestion: string;
}

interface QAReport {
  verdict: "pass" | "fail";
  tasks: Array<{
    taskId: string;
    verdict: "pass" | "fail";
    findings: QAFinding[];
    dodChecklist: Array<{ item: string; status: "pass" | "fail"; evidence: string }>;
  }>;
  testFilesWritten: string[];
  buildStatus: "pass" | "fail" | "skipped";
  testSuiteStatus: "pass" | "fail" | "skipped" | "no_tests";
}

const QAReportSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  tasks: z.array(z.object({
    taskId: z.string(),
    verdict: z.enum(["pass", "fail"]),
    findings: z.array(z.object({
      defect_area: z.enum(["build_failure", "test_failure", "ui_rendering", "ui_interaction", "api_behavior", "accessibility", "content", "design_mismatch", "logic_error", "performance"]),
      severity: z.enum(["critical", "high", "medium", "low"]),
      description: z.string(),
      expected: z.string(),
      actual: z.string(),
      file: z.string(),
      fix_suggestion: z.string(),
    })),
    dod_checklist: z.array(z.object({
      item: z.string(),
      status: z.enum(["pass", "fail"]),
      evidence: z.string(),
    })),
  })),
  test_files_written: z.array(z.string()),
  build_status: z.enum(["pass", "fail", "skipped"]),
  test_suite_status: z.enum(["pass", "fail", "skipped", "no_tests"]),
});

function qaSchemaResultToQAReport(result: z.infer<typeof QAReportSchema>): QAReport {
  return {
    verdict: result.verdict,
    tasks: result.tasks.map((t) => ({
      taskId: t.taskId,
      verdict: t.verdict,
      findings: t.findings.map((f) => ({
        taskId: t.taskId,
        defectArea: f.defect_area as DefectArea,
        severity: f.severity as Task["priority"],
        description: f.description,
        expected: f.expected,
        actual: f.actual,
        file: f.file,
        fixSuggestion: f.fix_suggestion,
      })),
      dodChecklist: t.dod_checklist.map((c) => ({
        item: c.item,
        status: c.status,
        evidence: c.evidence,
      })),
    })),
    testFilesWritten: result.test_files_written,
    buildStatus: result.build_status,
    testSuiteStatus: result.test_suite_status,
  };
}

// ── CTO Escalation Decision Schema ──────────────────────────────

const ctoEscalationDecisionSchema = z.object({
  decision: z.enum(["fix", "skip", "abort"]),
  reasoning: z.string(),
  criticalBugs: z.array(z.string()).optional(),
});

// ── Beat return type ────────────────────────────────────────────

type BeatResult = { summary: string; tokensUsed: number; actionsCount: number; toolCalls: number };

// ── Sprint Review Verification (Spec 21) ────────────────────────

/**
 * Run the tester's QA verification beat for a sprint in the reviewing phase.
 *
 * Probes preview health, checks entry-point wiring, runs the tester agent
 * to produce a structured QA report, files bug_fix tasks for failures,
 * and advances the review state accordingly.
 */
export async function executeSprintReviewVerification(
  ctx: AgentBeatContext,
  beatId: string,
): Promise<BeatResult> {
  const snapshot = getSnapshot();
  const sprint = ctx.currentSprint;
  if (!sprint || sprint.status !== "reviewing") {
    return { summary: "Sprint not in reviewing state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const reviewState: SprintReviewState | null = (sprint as any).reviewState ?? null;
  if (!reviewState) {
    return { summary: "No review state found", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const sprintId = sprint.id;
  const role = ctx.role;
  const soul = getRoleSoul(role);

  const reviewBeatId = `review_${beatId}`;
  const reviewBeatSprintId = sprintId;
  const reviewBeatStart = Date.now();
  emitGraphBeatStarted(reviewBeatSprintId, sprintId, reviewBeatId, role, "sprint_verification", `Sprint ${sprint.number} review`);

  const completedTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.status === "completed" && t.kind !== "bug_fix" && t.kind !== "follow_up",
  );

  const taskLines = completedTasks.map((t) =>
    `- [${t.id}] ${t.title}\n  Kind: ${t.kind}\n  DoD: ${t.definitionOfDone.join(", ")}\n  Artifacts: ${t.artifactIds.length}`
  ).join("\n");

  const previewProbe = await probePreviewHealth(8000);
  const previewUrl = getLocalPreviewState().validationUrl ?? getLocalPreviewState().entryUrl ?? getLocalPreviewState().url;

  if (!previewProbe.reachable) {
    emitEmployeeActivity("tester", "error", `Beat ${beatId}: preview unreachable (${previewProbe.error}) — auto-failing sprint verification`, { beatId });
  }

  const sprintEntryCheck = checkEntryPointImports();

  // ── Cycle-over-cycle diff (Fix #5) ───────────────────────────────
  let previousCycleContext = "";
  if (reviewState.reworkCycleCount > 0) {
    try {
      const priorArtifacts = await listPersistedArtifacts(snapshot.company.id);
      const priorFailReports = priorArtifacts
        .filter(
          (a) =>
            a.kind === "qa_report" &&
            a.sprintId === sprintId &&
            a.title.includes("FAIL"),
        )
        .slice(0, 1);
      if (priorFailReports.length > 0) {
        const prior = priorFailReports[0];
        const snippet = prior.content.slice(0, 4000);
        previousCycleContext = [
          "",
          `## Previous Cycle Findings (cycle ${reviewState.reworkCycleCount})`,
          "The developer has completed another rework pass. The report below is from the PREVIOUS verification cycle.",
          "Your job this cycle:",
          "  • RESOLVED — findings from the previous cycle that are now fixed (no longer reproducible).",
          "  • RECURRING — findings from the previous cycle that are STILL present (the fix didn't land or didn't work).",
          "  • NEW — findings in the current build that were NOT present in the previous cycle (regressions).",
          "",
          "Treat RECURRING findings as higher severity — they indicate the developer cannot fix the underlying issue.",
          "",
          "── Previous cycle report (verbatim excerpt) ──",
          snippet,
          prior.content.length > 4000 ? "…(truncated)" : "",
          "── End previous cycle report ──",
          "",
          "At the very TOP of your output, add a one-line cycle diff in exactly this format:",
          `CYCLE_DIFF: resolved=<N> recurring=<N> new=<N>`,
          "Then produce your normal QA report below that line.",
        ].join("\n");
      }
    } catch {
      // best-effort — never block verification on diff lookup
    }
  }

  const prompt = [
    `You are verifying Sprint ${sprint.number}: "${sprint.goal}".`,
    "",
    "## Completed Tasks",
    taskLines || "(No completed tasks)",
    "",
    "## Preview Health Check (automated)",
    `Preview status: ${previewProbe.reachable ? "REACHABLE" : "UNREACHABLE"}`,
    `Preview URL: ${previewUrl ?? "none"}`,
    previewProbe.reachable
      ? `HTTP status: ${previewProbe.statusCode}`
      : `Error: ${previewProbe.error ?? "unknown"}`,
    previewProbe.reachable ? `Content length: ${previewProbe.contentLength} bytes` : "",
    previewProbe.reachable ? `Has product content: ${previewProbe.hasProductContent}` : "",
    previewProbe.bodySnippet ? `Page text snippet: ${previewProbe.bodySnippet}` : "",
    "",
    "## Entry-Point Integration Check (automated)",
    `Entry file: ${sprintEntryCheck.entryFile ?? "not found"}`,
    `Import check passed: ${sprintEntryCheck.pass}`,
    `Details: ${sprintEntryCheck.reason}`,
    sprintEntryCheck.orphanedModules.length > 0 ? `Orphaned modules: ${sprintEntryCheck.orphanedModules.join(", ")}` : "",
    !sprintEntryCheck.pass ? "Note: The entry file currently does not import the product modules — this is a structural issue that will be tracked as a single bug task. Consider it when forming your verdict but do not duplicate it in your findings." : "",
    previousCycleContext,
    "",
    "If the preview is UNREACHABLE, the sprint cannot pass — a product that cannot be accessed is not shippable.",
    "",
    "## Your Verification Steps",
    "1. Review the automated preview health and entry-point results above as context for your verdict.",
    "2. USE YOUR TOOLS to read the actual source files in the product workspace and verify they match the sprint goal.",
    `   - Read the entry file (start with ${productDir}/src/App.tsx or equivalent) and verify it imports product modules`,
    "   - Do NOT produce a theoretical report — cite actual files and import statements you verified",
    "3. Analyze each completed task against its Definition of Done.",
    "4. List concrete, reproducible defects with file evidence. It is valid to return an empty findings list if nothing is broken — do not invent findings to fill the schema.",
    "5. Produce a QA report.",
    "",
    "## QA Report Requirements",
    "For each completed task, assess whether it passes or fails its Definition of Done.",
    "For each real defect, describe the defect area, severity (critical/high/medium/low), what was expected vs actual, the file involved, and a fix suggestion.",
    "Only file a finding when you have concrete evidence (a file path, a reproducible behavior). Vague observations should be omitted.",
    "Do not duplicate the entry-point structural issue in your findings — it is tracked separately.",
    "For each DoD item, state whether it passes or fails with evidence.",
    "State overall build and test suite status.",
    "Conclude with an overall verdict: PASS or FAIL.",
  ].join("\n");

  try {
    const session = await ensureAgentSession(snapshot, role);
    touchAgentSession(role, "working");
    emitEmployeeActivity(role, "working", `Beat ${beatId}: running sprint verification for Sprint ${sprint.number}`, { beatId });

    const output = await runPromptText(role, session.sessionId, soul.systemPrompt + getAgentSkills(role), prompt);
    touchAgentSession(role, "idle");

    const tokensUsed = drainBeatTokenAccumulator(beatId);

    // Emit CYCLE_DIFF line (Fix #5)
    if (output && reviewState.reworkCycleCount > 0) {
      const diffMatch = output.match(/CYCLE_DIFF:\s*resolved=(\d+)\s+recurring=(\d+)\s+new=(\d+)/i);
      if (diffMatch) {
        emitEmployeeActivity(
          "tester",
          "working",
          `Sprint ${sprint.number} cycle ${reviewState.reworkCycleCount + 1}: ${diffMatch[1]} resolved, ${diffMatch[2]} recurring, ${diffMatch[3]} new regressions`,
          { beatId },
        );
      }
    }

    // Extract structured QA report
    let qaReport: QAReport | null = null;
    if (output) {
      try {
        const extracted = await structuredCompletion(
          "workerDeployment",
          [
            {
              role: "system",
              content: "Extract a structured QA report from the tester's analysis below. Only record findings the tester stated as concrete, reproducible defects with a specific file or behavior — do NOT fabricate findings from vague prose, general observations, or speculative remarks. If the tester did not list explicit defects for a task, its findings array must be empty. Preserve the tester's verdicts exactly.",
            },
            { role: "user", content: output },
          ],
          QAReportSchema,
          "qa_report_extract",
          { temperature: 0 },
        );
        qaReport = qaSchemaResultToQAReport(extracted);
      } catch (extractErr) {
        emitEmployeeActivity("tester", "error", `QA report extraction failed: ${extractErr instanceof Error ? extractErr.message : "unknown"} — treating as unparseable`, { beatId });
      }
    }

    // Hard override: if preview unreachable OR entry-point disconnected, force fail.
    const effectiveVerdict = !previewProbe.reachable ? "fail"
      : !sprintEntryCheck.pass ? "fail"
      : qaReport ? qaReport.verdict
      : null;
    const entryPointIsSoleFailCause =
      !sprintEntryCheck.pass && previewProbe.reachable && qaReport?.verdict !== "fail";

    if (effectiveVerdict === "pass") {
      emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} tester verdict: PASS — advancing to final gate`, { beatId });
      emitGraphDecision(sprintId, null, "cto_review", `Sprint ${sprint.number} QA: PASS`, "Tester verified all tasks pass their Definition of Done", "tester", 1.0);

      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? { ...s.reviewState, testerVerdict: "pass" as const, phase: "final_gate" as const } : s.reviewState,
      }));

      await persistRuntimeArtifact(snapshot.company.id, {
        id: `artifact_${crypto.randomUUID()}`,
        agent: "tester",
        kind: "qa_report",
        title: `Sprint ${sprint.number} QA Report — PASS`,
        content: output ?? "Verification passed",
        createdAt: nowIso(),
        sprintId,
        taskId: null,
        fileReferences: (qaReport?.testFilesWritten ?? []).map((f) => ({ path: f, action: "created" })),
      });

      emitGraphBeatCompleted(reviewBeatSprintId, sprintId, reviewBeatId, "completed", `PASS — Sprint ${sprint.number}`, 1, Date.now() - reviewBeatStart);
      return { summary: `Tester verification PASS for Sprint ${sprint.number}`, tokensUsed, actionsCount: 1, toolCalls: 1 };

    } else if (effectiveVerdict === "fail") {
      const failReason = !previewProbe.reachable
        ? `Preview unreachable: ${previewProbe.error}`
        : !sprintEntryCheck.pass
          ? `Entry-point disconnected: ${sprintEntryCheck.reason}`
          : "Tester QA report verdict: FAIL";
      emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} tester verdict: FAIL — ${failReason}`, { beatId });
      emitGraphDecision(sprintId, null, "cto_review", `Sprint ${sprint.number} QA: FAIL`, failReason, "tester", 0);

      const updatedReviewState: SprintReviewState = {
        ...(reviewState as SprintReviewState),
        testerVerdict: "fail",
        phase: "rework",
        reworkCycleCount: reviewState.reworkCycleCount + 1,
      };

      const newBugTaskIds: string[] = [...reviewState.bugTaskIds];
      const rolesWithBugs = new Set<AgentIdentity["role"]>();

      if (!previewProbe.reachable && (!qaReport || qaReport.tasks.length === 0)) {
        const bugTask = createWorkflowTask(
          getSnapshot(), "bug_fix", "developer",
          "Fix preview — app unreachable",
          `The product preview is not reachable. Error: ${previewProbe.error ?? "unknown"}. The app must start and respond to HTTP requests before the sprint can pass.`,
          `Preview URL ${previewUrl ?? "(none)"} returns error: ${previewProbe.error ?? "no response"}.`,
          "Working preview that responds with HTTP 200",
          ["Preview URL responds with HTTP 200", "App renders without connection errors"],
          "critical", "planned", sprintId,
        );
        upsertTask(bugTask);
        newBugTaskIds.push(bugTask.id);
        rolesWithBugs.add("developer");
        emitGraphNodeAdded(sprintId, bugTask);
      }

      if (!sprintEntryCheck.pass) {
        const orphanList = sprintEntryCheck.orphanedModules.length > 0
          ? ` Orphaned modules: ${sprintEntryCheck.orphanedModules.join(", ")}.`
          : "";
        const wiringPrescription = generateOrphanWiringPrescription(
          sprintEntryCheck.orphanedModules,
          sprintEntryCheck.entryFile,
        );
        const prescriptionSection = wiringPrescription.length > 0
          ? [
              "",
              "── Wire each orphan like this ──",
              wiringPrescription,
              "",
              "Target entry-file structure (adapt to this product's domain):",
              `<Layout>`,
              `  {/* import + render every orphan listed above */}`,
              `</Layout>`,
              "",
              "Rules:",
              "1. Every orphan module above MUST be imported by the entry file (direct or transitive).",
              "2. Every imported component MUST be rendered in the JSX tree — not just imported.",
              "3. Pass realistic props where required — do NOT leave components with empty/placeholder props only.",
              "4. Do NOT create new components — only wire the ones already on disk.",
            ].join("\n")
          : "";

        const entryBug = createWorkflowTask(
          getSnapshot(), "bug_fix", "developer",
          "Wire entry file to product modules",
          `Entry file ${sprintEntryCheck.entryFile ?? "(not found)"} does not import this sprint's components. ${sprintEntryCheck.reason}${orphanList} Components exist on disk but are never rendered.${prescriptionSection}`,
          "Entry file is disconnected from the product modules this sprint produced.",
          "Entry file imports and renders the sprint's components so they appear in the running app.",
          [
            "Entry file imports the sprint's product modules",
            "No orphaned modules remain in sprint scope",
            "Preview renders the sprint's components",
          ],
          "critical", "planned", sprintId,
        );
        upsertTask(entryBug);
        newBugTaskIds.push(entryBug.id);
        rolesWithBugs.add("developer");
        emitGraphNodeAdded(sprintId, entryBug);
      }

      const taskReports = entryPointIsSoleFailCause ? [] : (qaReport?.tasks ?? []);
      const MAX_FINDINGS_PER_TASK = 3;

      for (const taskReport of taskReports) {
        if (taskReport.verdict !== "fail") continue;
        const hiredRoles = new Set(
          getSnapshot().agents.map((a) => a.role as AgentIdentity["role"]),
        );
        const actionableFindings = taskReport.findings
          .filter((f) => f.severity === "critical" || f.severity === "high")
          .slice(0, MAX_FINDINGS_PER_TASK);
        for (const finding of actionableFindings) {
          const bugFields = buildBugFixTaskFields({
            finding: {
              ...finding,
              taskId: taskReport.taskId,
            },
            sprintId,
            parentTaskId: taskReport.taskId,
            hiredRoles,
          });
          const bugTask = createWorkflowTask(
            getSnapshot(), bugFields.kind, bugFields.assignedRole,
            bugFields.title, bugFields.description, bugFields.problemStatement,
            bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
            bugFields.sprintId,
          );
          bugTask.parentTaskId = bugFields.parentTaskId;
          upsertTask(bugTask);
          newBugTaskIds.push(bugTask.id);
          rolesWithBugs.add(bugFields.assignedRole);
          emitGraphNodeAdded(sprintId, bugTask);
        }
      }

      updatedReviewState.bugTaskIds = newBugTaskIds;

      if (shouldEscalate(updatedReviewState)) {
        updatedReviewState.phase = "escalated";
        updatedReviewState.escalatedToCto = true;
        if (!updatedReviewState.escalatedAt) updatedReviewState.escalatedAt = nowIso();
        emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} rework limit reached (${updatedReviewState.reworkCycleCount}/${updatedReviewState.maxReworkCycles}) — escalating to CTO`, { beatId });
        emitReactive("cto", "escalation_received");
        emitGraphDecision(sprintId, null, "escalation",
          `Sprint ${sprint.number} rework limit reached — escalating to CTO`,
          `Rework cycle ${updatedReviewState.reworkCycleCount}/${updatedReviewState.maxReworkCycles} exhausted`,
          "tester", 0);
      }

      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: updatedReviewState,
      }));

      for (const bugRole of rolesWithBugs) {
        emitReactive(bugRole, "bug_reported");
      }

      await persistRuntimeArtifact(snapshot.company.id, {
        id: `artifact_${crypto.randomUUID()}`,
        agent: "tester",
        kind: "qa_report",
        title: `Sprint ${sprint.number} QA Report — FAIL (cycle ${updatedReviewState.reworkCycleCount})`,
        content: output ?? "Verification failed",
        createdAt: nowIso(),
        sprintId,
        taskId: null,
        fileReferences: [],
      });

      emitGraphBeatCompleted(reviewBeatSprintId, sprintId, reviewBeatId, "completed", `FAIL — Sprint ${sprint.number}`, 1, Date.now() - reviewBeatStart);
      return {
        summary: `Tester verification FAIL for Sprint ${sprint.number} — ${newBugTaskIds.length - reviewState.bugTaskIds.length} new bugs filed`,
        tokensUsed, actionsCount: 1, toolCalls: 1,
      };

    } else {
      // Couldn't parse QA report — tool failure, not QA failure
      const nextCycleCount = (reviewState.reworkCycleCount ?? 0) + 1;
      const willEscalate = nextCycleCount >= reviewState.maxReworkCycles;

      emitEmployeeActivity("tester", "error", `Sprint ${sprint.number} tester output could not be parsed as QA report — treating as tool failure (cycle ${nextCycleCount}/${reviewState.maxReworkCycles})`, { beatId });

      if (willEscalate) {
        emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} parse-failure limit reached — escalating to CTO`, { beatId });
        emitReactive("cto", "escalation_received");
      }

      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          reworkCycleCount: nextCycleCount,
          phase: willEscalate ? "rework" as const : "tester_verification" as const,
          escalatedToCto: willEscalate ? true : s.reviewState.escalatedToCto,
          escalatedAt: willEscalate && !s.reviewState.escalatedAt ? nowIso() : s.reviewState.escalatedAt,
        } : s.reviewState,
      }));
      emitGraphBeatCompleted(
        reviewBeatSprintId,
        sprintId,
        reviewBeatId,
        "failed",
        willEscalate ? "Output unparseable — escalating" : "Output unparseable — retrying",
        0,
        Date.now() - reviewBeatStart,
      );

      await persistRuntimeArtifact(snapshot.company.id, {
        id: `artifact_${crypto.randomUUID()}`,
        agent: "tester",
        kind: "qa_report",
        title: `Sprint ${sprint.number} QA Report — UNPARSEABLE (cycle ${nextCycleCount})`,
        content: output ?? "(no output)",
        createdAt: nowIso(),
        sprintId,
        taskId: null,
        fileReferences: [],
      });

      return {
        summary: willEscalate
          ? `Tester output unparseable — parse-failure limit reached, escalating to CTO`
          : `Tester output unparseable — retrying next beat (cycle ${nextCycleCount}/${reviewState.maxReworkCycles})`,
        tokensUsed, actionsCount: 1, toolCalls: 1,
      };
    }
  } catch (err) {
    touchAgentSession(role, "idle");
    emitEmployeeActivity(role, "error", `Beat ${beatId}: sprint verification failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    emitGraphBeatCompleted(reviewBeatSprintId, sprintId, reviewBeatId, "failed", err instanceof Error ? err.message : String(err), 0, Date.now() - reviewBeatStart);
    return {
      summary: `Sprint verification failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }
}

// ── Final Gate (Spec 21) ────────────────────────────────────────

/** Run the final build+test gate and finalize or re-enter rework. */
export async function executeSprintFinalGate(
  _ctx: AgentBeatContext,
  beatId: string,
): Promise<BeatResult> {
  const snapshot = getSnapshot();
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (!sprint || sprint.status !== "reviewing") {
    return { summary: "Sprint not in reviewing state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const reviewState: SprintReviewState | null = (sprint as any).reviewState ?? null;
  if (!reviewState) {
    return { summary: "No review state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const productDirForGate = workspaceManager.getLegacyProductDir();
  const gateResult = await runVerificationGate(productDirForGate, "final");

  if (sprintId) {
    emitGraphDecision(sprintId, null, "gate_verdict",
      `Final gate: ${gateResult.passed ? "PASSED" : "FAILED"}`,
      gateResult.passed ? "Final build check passed" : `Final build check failed: ${gateResult.buildResult?.stderr?.slice(0, 200) ?? "unknown error"}`,
      "system", gateResult.passed ? 1.0 : 0);
  }

  const updatedGateResults = [...reviewState.gateResults, gateResult];

  if (gateResult.passed) {
    emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} final gate PASSED — completing sprint`, { beatId, detail: { gateResult } });

    updateSprint(sprintId, (s) => ({
      ...s,
      reviewState: s.reviewState ? { ...s.reviewState, gateResults: updatedGateResults, phase: "complete" as const, completedAt: nowIso() } : s.reviewState,
    }));

    await finalizeSprintCompletion(sprintId);

    return {
      summary: `Sprint ${sprint.number} final gate PASSED — sprint completed`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
    };
  } else {
    emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} final gate FAILED — back to rework`, { beatId, detail: { gateResult } });

    const bugFields = buildGateFailureBugFields(gateResult, sprintId);
    const newBugIds = [...reviewState.bugTaskIds];
    if (bugFields) {
      const bugTask = createWorkflowTask(
        getSnapshot(), bugFields.kind, bugFields.assignedRole,
        bugFields.title, bugFields.description, bugFields.problemStatement,
        bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
        bugFields.sprintId,
      );
      upsertTask(bugTask);
      newBugIds.push(bugTask.id);
      emitReactive(bugFields.assignedRole, "bug_reported");
    }

    const newReworkCount = reviewState.reworkCycleCount + 1;
    const escalate = newReworkCount >= reviewState.maxReworkCycles;

    updateSprint(sprintId, (s) => ({
      ...s,
      reviewState: s.reviewState ? {
        ...s.reviewState,
        gateResults: updatedGateResults,
        bugTaskIds: newBugIds,
        reworkCycleCount: newReworkCount,
        phase: (escalate ? "escalated" : "rework") as any,
        escalatedToCto: escalate || s.reviewState.escalatedToCto,
        escalatedAt: escalate && !s.reviewState.escalatedAt ? nowIso() : s.reviewState.escalatedAt,
      } : s.reviewState,
    }));

    if (escalate) {
      emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} rework limit exceeded — escalating to CTO`, { beatId });
      emitReactive("cto", "escalation_received");
    }

    return {
      summary: `Sprint ${sprint.number} final gate FAILED — ${escalate ? "escalated to CTO" : "back to rework"}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
    };
  }
}

// ── Retest After Rework ─────────────────────────────────────────

/** Advance from rework to tester re-verification after all bug fixes resolve. */
export async function executeRetestAfterRework(
  _ctx: AgentBeatContext,
  beatId: string,
): Promise<BeatResult> {
  const snapshot = getSnapshot();
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  emitEmployeeActivity("tester", "transition", `Bug fixes resolved — advancing to tester re-verification`, { beatId });

  updateSprint(sprintId, (s) => ({
    ...s,
    reviewState: s.reviewState ? {
      ...s.reviewState,
      phase: "tester_verification" as const,
      bugTaskIds: [],
      testerVerdict: null,
    } : s.reviewState,
  }));

  return {
    summary: `Bug fixes resolved — tester will re-verify on next beat`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
  };
}

// ── CTO Escalation Review (Spec 21) ─────────────────────────────

/** CTO escalation beat: make a fix/skip/abort decision on a stuck sprint. */
export async function executeCtoBeatEscalationReview(
  _ctx: AgentBeatContext,
  beatId: string,
): Promise<BeatResult> {
  startBeatTokenAccumulator(beatId);
  const snapshot = getSnapshot();
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  const reviewState = sprint?.reviewState;
  if (!sprint || !reviewState || !reviewState.escalatedToCto) {
    return { summary: "No escalation pending", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  emitEmployeeActivity("cto", "working", `Beat ${beatId}: reviewing escalated Sprint ${sprint.number} (${reviewState.reworkCycleCount} rework cycles exhausted)`, { beatId });

  const bugTasks = reviewState.bugTaskIds
    .map((id) => snapshot.tasks.find((t) => t.id === id))
    .filter(Boolean);

  const bugSummary = bugTasks.map((t) =>
    `- [${t!.status}] ${t!.title}: ${t!.description?.slice(0, 150) ?? "no description"}`
  ).join("\n");

  const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprintId);
  const completedCount = sprintTasks.filter((t) => t.status === "completed").length;
  const failedCount = sprintTasks.filter((t) => t.status === "failed").length;

  const prompt = [
    `Sprint ${sprint.number} "${sprint.title}" has been escalated to you after ${reviewState.reworkCycleCount} failed rework cycles (max ${reviewState.maxReworkCycles}).`,
    ``,
    `Sprint progress: ${completedCount}/${sprintTasks.length} tasks completed, ${failedCount} failed.`,
    `Tester verdict: ${reviewState.testerVerdict ?? "unknown"}`,
    ``,
    `Remaining bug tasks:`,
    bugSummary || "(none tracked)",
    ``,
    `You must decide:`,
    `- "fix": Force one more targeted rework cycle on the critical bugs only`,
    `- "skip": Ship the sprint as-is, accepting known defects as tech debt`,
    `- "abort": Cancel the sprint entirely and re-plan`,
    ``,
    `Consider: severity of remaining bugs, business impact, and whether another rework cycle is likely to succeed.`,
  ].join("\n");

  try {
    const result = await structuredCompletion(
      "workerDeployment",
      [
        { role: "system", content: "You are the CTO making a ship-or-kill decision on an escalated sprint. Be decisive and justify your reasoning." },
        { role: "user", content: prompt },
      ],
      ctoEscalationDecisionSchema,
      "cto_escalation_review",
      { temperature: 0.3 },
    );

    const decision = result.decision;
    const tokensUsed = drainBeatTokenAccumulator(beatId);

    emitEmployeeActivity("cto", "decision", `Beat ${beatId}: CTO escalation decision = ${decision} — ${result.reasoning.slice(0, 200)}`, {
      beatId, detail: { decision, reasoning: result.reasoning },
    });

    updateSprint(sprintId, (s) => ({
      ...s,
      reviewState: s.reviewState ? {
        ...s.reviewState,
        ctoDecision: decision,
      } : s.reviewState,
    }));

    if (decision === "fix") {
      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          phase: "rework" as const,
          maxReworkCycles: s.reviewState.maxReworkCycles + 1,
        } : s.reviewState,
      }));
      for (const bugTask of bugTasks) {
        if (bugTask?.assignedRole) {
          emitReactive(bugTask.assignedRole, "bug_reported");
        }
      }
      emitEmployeeActivity("cto", "transition", `Beat ${beatId}: CTO granted extra rework cycle — Sprint ${sprint.number} back to rework`, { beatId });
    } else if (decision === "skip") {
      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          phase: "complete" as const,
          completedAt: new Date().toISOString(),
        } : s.reviewState,
      }));
      await finalizeSprintCompletion(sprintId);
      emitEmployeeActivity("cto", "transition", `Beat ${beatId}: CTO shipped Sprint ${sprint.number} with known defects`, { beatId });
    } else if (decision === "abort") {
      updateSprint(sprintId, (s) => ({
        ...s,
        status: "completed" as const,
        completedAt: new Date().toISOString(),
        summary: `Aborted by CTO after ${reviewState.reworkCycleCount} rework cycles: ${result.reasoning.slice(0, 300)}`,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          phase: "complete" as const,
          completedAt: new Date().toISOString(),
        } : s.reviewState,
      }));
      emitEmployeeActivity("cto", "transition", `Beat ${beatId}: CTO aborted Sprint ${sprint.number} — will need re-planning`, { beatId });
      emitReactive("ceo", "sprint_completed");
    }

    return {
      summary: `CTO escalation review: ${decision} — ${result.reasoning.slice(0, 300)}`,
      tokensUsed, actionsCount: 1, toolCalls: 1,
    };
  } catch (err) {
    const tokensUsed = drainBeatTokenAccumulator(beatId);
    emitEmployeeActivity("cto", "error", `Beat ${beatId}: CTO escalation review failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    return {
      summary: `CTO escalation review failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed, actionsCount: 0, toolCalls: 0,
    };
  }
}
