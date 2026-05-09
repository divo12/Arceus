/**
 * Developer workspace file-system monitor — polls for changed files,
 * emits activity events, and auto-starts live preview when a runnable
 * project is detected.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  getActiveExecution,
  getExecutionStatus,
  getProductDir,
  getDeveloperWorkspaceMonitor,
  getDeveloperWorkspaceSnapshot,
  getDeveloperStepLoopActive,
  setDeveloperWorkspaceMonitor,
  setDeveloperWorkspaceSnapshot,
  WORKSPACE_MONITOR_INTERVAL_MS,
  WORKSPACE_MONITOR_IGNORE,
} from "../orchestration/state.js";
import { nowIso } from "@arceus/task-engine";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphFileChanges, resolveActiveSprintId } from "../observability/graph-emitter/index.js";
import { getLocalPreviewState, hasReportedPreviewCandidate, hasLocalPreviewCandidate, startLocalPreview } from "./preview.js";
import { touchAgentSession, updateAgentSessionState } from "../agents/sessions.js";
import { getCurrentDeveloperSessionKey } from "../orchestration/state.js";
import { scheduleDeveloperWatchdog, failDeveloperStall } from "./watchdog.js";
import { appendTaskResult, setTaskPreviewUrl } from "../tasks/mutations.js";

/** Recursively collect file paths and modification times from the product directory. */
async function collectWorkspaceSnapshot(dir: string, base: string, result = new Map<string, number>()) {
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
    } catch {
      /* ignore transient file errors */
    }
  }

  return result;
}

/** Stop the periodic workspace polling interval and clear the cached snapshot. */
export function stopDeveloperWorkspaceMonitor() {
  const monitor = getDeveloperWorkspaceMonitor();
  if (monitor) {
    clearInterval(monitor);
    setDeveloperWorkspaceMonitor(null);
  }
  setDeveloperWorkspaceSnapshot(new Map<string, number>());
}

/** Compare the current workspace to the last snapshot and emit events for changed files. */
async function pollDeveloperWorkspaceChanges() {
  const activeExecution = getActiveExecution();
  if (!activeExecution || getExecutionStatus() !== "executing") {
    return;
  }

  const companyProductDir = getProductDir(activeExecution.companyId);
  const previousSnapshot = getDeveloperWorkspaceSnapshot();
  const nextSnapshot = await collectWorkspaceSnapshot(companyProductDir, companyProductDir);
  const changedFiles = Array.from(nextSnapshot.entries())
    .filter(([path, mtime]) => (previousSnapshot.get(path) ?? 0) < mtime)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([path]) => path);

  setDeveloperWorkspaceSnapshot(nextSnapshot);

  if (changedFiles.length === 0) {
    return;
  }

  const devKey = getCurrentDeveloperSessionKey(activeExecution.companyId) || "developer";
  touchAgentSession(devKey);
  updateAgentSessionState(devKey, {
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
    void appendTaskResult(activeExecution.buildTaskId, `edited:${filePath}`);
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

/** If no preview is running and the workspace has a runnable project, start a live preview. */
async function maybeStartDeveloperLivePreview(changedFiles: string[]) {
  const activeExecution = getActiveExecution();
  if (!activeExecution || getExecutionStatus() !== "executing") {
    return;
  }

  if (getDeveloperStepLoopActive()) {
    return;
  }

  const previewState = getLocalPreviewState();
  if (previewState.status === "starting" || previewState.status === "ready") {
    const previewUrl = previewState.validationUrl ?? previewState.entryUrl ?? previewState.url;
    if (previewUrl) {
      void setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
    }
    return;
  }

  const preferredTargetPath = changedFiles[0]?.split("/")[0] ?? null;
  const companyProductDir = getProductDir(activeExecution.companyId);
  const hasCandidate = hasReportedPreviewCandidate() || await hasLocalPreviewCandidate(companyProductDir, preferredTargetPath);
  if (!hasCandidate) {
    return;
  }

  emitEmployeeActivity("developer", "info", `Detected runnable workspace target. Attempting live preview from ${changedFiles[0] ?? "workspace changes"}.`, {
    taskId: activeExecution.buildTaskId,
  });

  const preview = await startLocalPreview(companyProductDir, preferredTargetPath);
  const previewUrl = preview.validationUrl ?? preview.entryUrl ?? preview.url;
  if (preview.status !== "ready" || !previewUrl) {
    emitEmployeeActivity("developer", "info", preview.lastError ?? "Live preview attempt did not become reachable yet.", {
      taskId: activeExecution.buildTaskId,
    });
    return;
  }

  void setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
  void appendTaskResult(activeExecution.buildTaskId, `preview:${previewUrl}`);
  emitEmployeeActivity("developer", "info", `Live preview available during implementation → ${previewUrl}`, {
    taskId: activeExecution.buildTaskId,
  });
}

