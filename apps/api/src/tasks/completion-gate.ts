/**
 * Server-side gate for task_complete.
 *
 * Rejects completion when:
 * 1. No evidence artifact is attached (or supplied in the request)
 * 2. For code-producing task kinds — workspace typecheck fails
 * 3. For viewable task kinds — preview is unreachable
 *
 * Soft roles (CEO/PM/etc.) still need evidence, but skip build/preview.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Task } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";
import { workspaceManager } from "../workspace/manager.js";
import { ensureDepsInstalled } from "../workspace/ensure-deps.js";
import { getLocalPreviewState, probePreviewHealth } from "../workspace/preview.js";

/** Task kinds that ship code into the product workspace. */
export const CODE_TASK_KINDS = new Set<Task["kind"]>([
  "implementation",
  "local_preview",
  "bug_fix",
]);

/** Task kinds that must be viewable in a running preview. */
export const VIEWABLE_TASK_KINDS = new Set<Task["kind"]>([
  "local_preview",
  "implementation",
]);

export interface CompletionGateFailure {
  ok: false;
  cause: "missing_evidence" | "baseline_failed" | "preview_unavailable" | "validation";
  summary: string;
  stopWhen: string;
  details?: Record<string, unknown>;
}

export interface CompletionGateSuccess {
  ok: true;
  evidenceArtifactIds: string[];
}

export type CompletionGateResult = CompletionGateFailure | CompletionGateSuccess;

function parseTscErrors(output: string): string[] {
  const re = /^(.+?\(\d+,\d+\):\s+error\s+TS\d+:.+)$/gm;
  const errs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) errs.push(m[1].trim());
  return errs;
}

function runTsc(cwd: string, timeoutMs: number): Promise<{ ok: boolean; errors: string[] }> {
  return new Promise((resolveP) => {
    const child = spawn("npx", ["tsc", "--noEmit"], { cwd, shell: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveP({ ok: false, errors: [`tsc timed out after ${timeoutMs}ms`] });
        return;
      }
      const errors = parseTscErrors(out);
      resolveP({ ok: code === 0 && errors.length === 0, errors });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ ok: false, errors: [`tsc failed to start: ${err.message}`] });
    });
  });
}

async function resolveEvidenceIds(
  task: Task,
  requested: string[],
): Promise<{ ids: string[]; missing: string[] }> {
  const attached = task.artifactIds ?? [];
  const combined = [...new Set([...requested, ...attached])];
  if (combined.length === 0) return { ids: [], missing: [] };

  const missing: string[] = [];
  const ids: string[] = [];
  for (const id of combined) {
    const row = await artifactsRepo.findArtifactById(getDb(), id);
    if (!row) {
      // Also accept ids already on the task even if the row lookup fails
      // (legacy / friendly-id edge cases) — only reject brand-new unknowns.
      if (attached.includes(id)) ids.push(id);
      else missing.push(id);
      continue;
    }
    ids.push(id);
  }
  return { ids, missing };
}

/**
 * Evaluate whether a task may be marked completed.
 * Pure decision + side-effect-free except reading workspace/DB/preview.
 */
export async function evaluateCompletionGate(args: {
  task: Task;
  companyId: string;
  evidenceArtifactIds?: string[];
  /** Skip build/preview for non-product roles (CEO planning, etc.). */
  enforceBuild: boolean;
}): Promise<CompletionGateResult> {
  const requested = args.evidenceArtifactIds ?? [];
  const { ids, missing } = await resolveEvidenceIds(args.task, requested);

  if (missing.length > 0) {
    return {
      ok: false,
      cause: "validation",
      summary: `Unknown evidence artifact id(s): ${missing.slice(0, 5).join(", ")}. Create them with artifact_create first.`,
      stopWhen: "payload_fixed",
      details: { missing },
    };
  }

  if (ids.length === 0) {
    return {
      ok: false,
      cause: "missing_evidence",
      summary:
        "Cannot complete without evidence. Call artifact_create (or workspace_collect_evidence) and pass evidenceArtifactIds.",
      stopWhen: "evidence_attached",
    };
  }

  if (!args.enforceBuild) {
    return { ok: true, evidenceArtifactIds: ids };
  }

  if (CODE_TASK_KINDS.has(args.task.kind)) {
    const productDir = workspaceManager.getLocalPath(args.companyId);
    if (!existsSync(productDir)) {
      return {
        ok: false,
        cause: "baseline_failed",
        summary: "Product workspace missing — cannot verify build before completion.",
        stopWhen: "workspace_available",
      };
    }

    const pkgPath = join(productDir, "package.json");
    if (existsSync(pkgPath)) {
      await ensureDepsInstalled(productDir, 180_000);
      const tsc = await runTsc(productDir, 60_000);
      if (!tsc.ok) {
        return {
          ok: false,
          cause: "baseline_failed",
          summary: `Typecheck failed — fix errors before task_complete. First errors: ${tsc.errors.slice(0, 3).join(" | ") || "see tsc output"}`,
          stopWhen: "typecheck_passes",
          details: { errors: tsc.errors.slice(0, 10) },
        };
      }
    }
  }

  if (VIEWABLE_TASK_KINDS.has(args.task.kind)) {
    const preview = getLocalPreviewState(args.companyId);
    const url = preview.validationUrl ?? preview.entryUrl ?? preview.url ?? args.task.localPreviewUrl;
    if (!url) {
      return {
        ok: false,
        cause: "preview_unavailable",
        summary:
          "Viewable task has no preview URL. Call workspace_start_preview (then task_set_preview_url) before completing.",
        stopWhen: "preview_ready",
      };
    }
    const probe = await probePreviewHealth(args.companyId, 8000);
    if (!probe.reachable) {
      return {
        ok: false,
        cause: "preview_unavailable",
        summary: `Preview unreachable (${probe.error ?? "unknown"}). Fix the preview before task_complete.`,
        stopWhen: "preview_reachable",
        details: { url, error: probe.error },
      };
    }
  }

  return { ok: true, evidenceArtifactIds: ids };
}
