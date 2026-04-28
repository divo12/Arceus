/**
 * Developer workspace file-system monitor — polls for changed files,
 * emits activity events, and auto-starts live preview when a runnable
 * project is detected.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  activeExecution,
  executionStatus,
  productDir,
  developerWorkspaceMonitor,
  developerWorkspaceSnapshot,
  developerStepLoopActive,
  setDeveloperWorkspaceMonitor,
  setDeveloperWorkspaceSnapshot,
  WORKSPACE_MONITOR_INTERVAL_MS,
  WORKSPACE_MONITOR_IGNORE,
} from "../orchestration/state.js";
import { nowIso } from "@arceus/task-engine";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphFileChanges, resolveActiveSprintId } from "../observability/graph-emitter.js";
import { getLocalPreviewState, hasReportedPreviewCandidate, hasLocalPreviewCandidate, startLocalPreview } from "./preview.js";
import { touchAgentSession, updateAgentSessionState } from "../agents/sessions.js";
import { scheduleDeveloperWatchdog, failDeveloperStall } from "./watchdog.js";
import { appendTaskResult, setTaskPreviewUrl } from "../tasks/mutations.js";

/** Recursively collect file paths and modification times from the product directory. */
export async function collectWorkspaceSnapshot(dir = productDir, base = productDir, result = new Map<string, number>()) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (WORKSPACE_MONITOR_IGNORE.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      await collectWorkspaceSnapshot(fullPath, base, result);
      continue;
    }

    try {
      const info = await stat(fullPath);
      result.set(relative(base, fullPath).replace(/\\/g, "/"), info.mtimeMs);
    // eslint-disable-next-line no-restricted-syntax -- intentional: filesystem stat probe; missing path is the expected branch.
    } catch {
      /* ignore transient file errors */
    }
  }

  return result;
}

/** Stop the periodic workspace polling interval and clear the cached snapshot. */
export function stopDeveloperWorkspaceMonitor() {
  if (developerWorkspaceMonitor) {
    clearInterval(developerWorkspaceMonitor);
    setDeveloperWorkspaceMonitor(null);
  }
  setDeveloperWorkspaceSnapshot(new Map<string, number>());
}

/** Compare the current workspace to the last snapshot and emit events for changed files. */
export async function pollDeveloperWorkspaceChanges() {
  if (!activeExecution || executionStatus !== "executing") {
    return;
  }

  const nextSnapshot = await collectWorkspaceSnapshot();
  const changedFiles = Array.from(nextSnapshot.entries())
    .filter(([path, mtime]) => (developerWorkspaceSnapshot.get(path) ?? 0) < mtime)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([path]) => path);

  setDeveloperWorkspaceSnapshot(nextSnapshot);

  if (changedFiles.length === 0) {
    return;
  }

  touchAgentSession("developer");
  updateAgentSessionState("developer", {
    lastWorkspaceChangeAt: nowIso(),
    lastProgressAt: nowIso(),
    lastEventSummary: `Workspace changed: ${changedFiles[0]}${changedFiles.length > 1 ? ` (+${changedFiles.length - 1} more)` : ""}`,
    awaiting: "processing workspace changes",
    stallReason: null,
  });
  scheduleDeveloperWatchdog(failDeveloperStall);

  for (const filePath of changedFiles) {
    emitEmployeeActivity("developer", "file_edit", filePath, {
      taskId: activeExecution.buildTaskId,
    });
    appendTaskResult(activeExecution.buildTaskId, `edited:${filePath}`);
  }

  const fileChangeSprintId = resolveActiveSprintId();
  if (fileChangeSprintId && activeExecution.buildTaskId) {
    emitGraphFileChanges(fileChangeSprintId, activeExecution.buildTaskId, changedFiles.map((f) => ({ path: f, action: "modified" as const })));
  }

  try {
    await maybeStartDeveloperLivePreview(changedFiles);
  } catch (err) {
    emitEmployeeActivity("system", "error", `Preview detection failed: ${err instanceof Error ? err.message : String(err)}`, {
      taskId: activeExecution?.buildTaskId ?? null,
    });
  }
}

/** Take an initial snapshot and start polling for workspace file changes. */
export async function startDeveloperWorkspaceMonitor() {
  stopDeveloperWorkspaceMonitor();
  setDeveloperWorkspaceSnapshot(await collectWorkspaceSnapshot());
  setDeveloperWorkspaceMonitor(setInterval(() => {
    void pollDeveloperWorkspaceChanges();
  }, WORKSPACE_MONITOR_INTERVAL_MS));
}

/** If no preview is running and the workspace has a runnable project, start a live preview. */
export async function maybeStartDeveloperLivePreview(changedFiles: string[]) {
  if (!activeExecution || executionStatus !== "executing") {
    return;
  }

  if (developerStepLoopActive) {
    return;
  }

  const previewState = getLocalPreviewState();
  if (previewState.status === "starting" || previewState.status === "ready") {
    const previewUrl = previewState.validationUrl ?? previewState.entryUrl ?? previewState.url;
    if (previewUrl) {
      setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
    }
    return;
  }

  const preferredTargetPath = changedFiles[0]?.split("/")[0] ?? null;
  const hasCandidate = hasReportedPreviewCandidate() || await hasLocalPreviewCandidate(productDir, preferredTargetPath);
  if (!hasCandidate) {
    return;
  }

  emitEmployeeActivity("developer", "info", `Detected runnable workspace target. Attempting live preview from ${changedFiles[0] ?? "workspace changes"}.`, {
    taskId: activeExecution.buildTaskId,
  });

  const preview = await startLocalPreview(productDir, preferredTargetPath);
  const previewUrl = preview.validationUrl ?? preview.entryUrl ?? preview.url;
  if (preview.status !== "ready" || !previewUrl) {
    emitEmployeeActivity("developer", "info", preview.lastError ?? "Live preview attempt did not become reachable yet.", {
      taskId: activeExecution.buildTaskId,
    });
    return;
  }

  setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
  appendTaskResult(activeExecution.buildTaskId, `preview:${previewUrl}`);
  emitEmployeeActivity("developer", "info", `Live preview available during implementation → ${previewUrl}`, {
    taskId: activeExecution.buildTaskId,
  });
}

/** Attempt to start a preview server if a runnable project exists in the workspace. */
export async function tryAutoPreview() {
  const previewState = getLocalPreviewState();
  if (previewState.status === "starting" || previewState.status === "ready") {
    emitEmployeeActivity("system", "preview", `Auto-preview skipped — already ${previewState.status}`);
    return;
  }

  const hasCandidate = hasReportedPreviewCandidate() || await hasLocalPreviewCandidate(productDir);
  if (!hasCandidate) {
    emitEmployeeActivity("system", "preview", "Auto-preview skipped — no runnable project found in workspace/");
    return;
  }

  emitEmployeeActivity("system", "preview", "Auto-starting preview after developer beat…");
  const preview = await startLocalPreview(productDir);
  const previewUrl = preview.validationUrl ?? preview.entryUrl ?? preview.url;
  if (preview.status === "ready" && previewUrl) {
    emitEmployeeActivity("system", "preview", `Preview auto-started → ${previewUrl}`, { detail: { url: previewUrl, status: preview.status } });
  } else {
    emitEmployeeActivity("system", "error", `Auto-preview failed: ${preview.lastError ?? "did not become reachable"}`, { detail: { status: preview.status, lastError: preview.lastError } });
  }
}
