import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { workspaceManager } from "../../workspace/manager.js";
import { probePreviewHealth, startLocalPreview } from "../../workspace/preview.js";
import {
  getHealth,
  recordPreview,
  recordTypecheck,
} from "../../workspace/build-health.js";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const WORKSPACE_BASE = "/api/internal/v1/workspaces";

const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const sendValidation = (reply: FastifyReply, err: ZodError): FastifyReply => {
  return reply.code(422).send({
    ...failure("Request validation failed.", "validation", "never", "payload_fixed"),
    error: {
      cause: "validation" as ErrorCause,
      retry: "never" as const,
      stopWhen: "payload_fixed",
      details: zodDetails(err),
    },
  });
};

const parseOrFail = <T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data;
};

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
  locationHeader?: string | null,
): FastifyReply => {
  if (locationHeader) void reply.header("location", locationHeader);
  cacheSuccessfulResponse(req, { status, body, locationHeader: locationHeader ?? null });
  return reply.code(status).send(body);
};

// ── Schemas ──────────────────────────────────────────────

const checkpointBody = z.object({
  taskId: z.string().min(1),
  agentRole: z.string().min(1),
  message: z.string().min(1).max(1000),
});

const previewProbeBody = z.object({
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

const checkExportsBody = z.object({
  modulePath: z.string().min(1),
  expectedExports: z.array(z.string().min(1)).min(1).max(50),
});

const verifyBaselineBody = z.object({
  skipPreview: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
}).optional();

const parseTscErrors = (output: string): string[] => {
  const re = /^(.+?\(\d+,\d+\):\s+error\s+TS\d+:.+)$/gm;
  const errs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) errs.push(m[1].trim());
  return errs;
};

const runTsc = (cwd: string, timeoutMs: number): Promise<{ ok: boolean; errors: string[] }> =>
  new Promise((resolveP) => {
    const child = spawn("npx", ["tsc", "--noEmit"], { cwd, shell: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
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

const extractExports = (source: string): string[] => {
  const exports = new Set<string>();
  const namedRe = /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const groupRe = /export\s*\{([^}]+)\}/g;
  const reExportRe = /export\s+\*\s+from/g;
  const defaultRe = /export\s+default\b/;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(source)) !== null) exports.add(m[1]);
  while ((m = groupRe.exec(source)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/i).pop()?.trim();
      if (name) exports.add(name);
    }
  }
  if (defaultRe.test(source)) exports.add("default");
  if (reExportRe.test(source)) exports.add("*");
  return [...exports];
};

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpWorkspacesRoutes(app: FastifyInstance): Promise<void> {
  // POST /workspaces/checkpoints — git commit + bundle sync
  app.post(`${WORKSPACE_BASE}/checkpoints`, async (req, reply) => {
    const body = parseOrFail(checkpointBody, req.body, reply);
    if (!body) return reply;

    const mcp = req.mcp!;
    const companyId = mcp.companyId;

    if (!companyId) {
      return reply.code(409).send(
        failure(
          "Company workspace not provisioned yet.",
          "conflict",
          "never",
          "company_bootstrapped",
        ),
      );
      return;
    }

    let commitSha: string;
    let warnings: string[];
    try {
      const result = await workspaceManager.commitAndSync(
        companyId,
        body.taskId,
        body.agentRole,
        body.message,
      );
      commitSha = result.commitSha;
      warnings = result.warnings;
    } catch (error) {
      return reply.code(503).send(
        failure(
          `Workspace commit failed: ${error instanceof Error ? error.message : "unknown error"}`,
          "upstream",
          "safe",
          "workspace_available",
        ),
      );
      return;
    }

    return cacheAndSend(
      req,
      reply,
      201,
      success(`Checkpoint committed as ${commitSha}.`, {
        companyId,
        taskId: body.taskId,
        commitSha,
        warnings,
      }),
      `${WORKSPACE_BASE}/checkpoints/${commitSha}`,
    );
  });

  // POST /workspaces/preview-start — start (or restart) the local preview dev server
  app.post(`${WORKSPACE_BASE}/preview-start`, async (req, reply) => {
    const body = parseOrFail(
      z.object({ targetPath: z.string().nullable().optional() }),
      req.body ?? {},
      reply,
    );
    if (!body) return reply;

    const productDir = workspaceManager.getLocalPath(req.mcp!.companyId);
    try {
      const state = await startLocalPreview(productDir, body.targetPath);
      const url = state.url ?? state.entryUrl ?? state.validationUrl;
      if (state.status === "ready") {
        return cacheAndSend(req, reply, 200, success(
          `Preview started → ${url ?? "(no url)"}`,
          { status: state.status, url, entryUrl: state.entryUrl, framework: state.framework, runtime: state.runtime, port: state.port },
        ));
      }
      return reply.code(503).send(failure(
        `Preview did not become ready: ${state.lastError ?? state.status}`,
        "upstream", "safe", "preview_reachable",
      ));
    } catch (err) {
      return reply.code(503).send(failure(
        `Preview start failed: ${err instanceof Error ? err.message : String(err)}`,
        "upstream", "safe", "preview_reachable",
      ));
    }
  });

  // POST /workspaces/preview-probes — HTTP probe of the local preview URL
  app.post(`${WORKSPACE_BASE}/preview-probes`, async (req, reply) => {
    const body = parseOrFail(previewProbeBody, req.body ?? {}, reply);
    if (!body) return reply;

    const probe = await probePreviewHealth(body.timeoutMs);

    return cacheAndSend(
      req,
      reply,
      200,
      success(
        probe.reachable
          ? `Preview reachable (HTTP ${probe.statusCode ?? "unknown"}).`
          : `Preview unreachable: ${probe.error ?? "unknown"}`,
        {
          reachable: probe.reachable,
          statusCode: probe.statusCode,
          contentLength: probe.contentLength,
          hasProductContent: probe.hasProductContent,
          bodySnippet: probe.bodySnippet,
          error: probe.error,
        },
      ),
    );
  });

  // GET /workspaces/preview-url?taskId=... — return the preview URL for a task
  app.get<{ Querystring: { taskId?: string } }>(
    `${WORKSPACE_BASE}/preview-url`,
    async (req, reply) => {
      const { taskId } = req.query;
      let previewUrl: string | null = null;
      if (taskId) {
        // Spec 31 Phase 7.B.5 — read task from canonical via repo.
        const task = await tasksRepo.findByIdHydrated(getDb(), taskId);
        if (!task) {
          return reply.code(404).send(failure(`Task ${taskId} not found.`, "not_found", "never", "resource_created"));
          return;
        }
        previewUrl = task.localPreviewUrl ?? null;
      }
      return cacheAndSend(req, reply, 200, success(
        previewUrl ? `Preview URL resolved.` : `No preview URL recorded.`,
        { taskId: taskId ?? null, previewUrl },
      ));
    },
  );

  // GET /workspaces/build-health — return the cached build health snapshot
  app.get(`${WORKSPACE_BASE}/build-health`, async (req, reply) => {
    const health = getHealth();
    return cacheAndSend(req, reply, 200, success("Build health snapshot.", health));
  });

  // POST /workspaces/check-exports — verify a module exports the expected names
  app.post(`${WORKSPACE_BASE}/check-exports`, async (req, reply) => {
    const body = parseOrFail(checkExportsBody, req.body, reply);
    if (!body) return reply;

    const root = workspaceManager.getLocalPath(req.mcp!.companyId);
    const abs = resolvePath(root, body.modulePath);
    if (!abs.startsWith(root + "/") && abs !== root) {
      return reply.code(422).send(failure("modulePath must stay inside the workspace.", "validation", "never", "payload_fixed"));
      return;
    }

    let source: string;
    try {
      source = await readFile(abs, "utf8");
    } catch (err) {
      return reply.code(404).send(failure(
        `Could not read module ${body.modulePath}: ${err instanceof Error ? err.message : "unknown error"}`,
        "not_found", "never", "resource_created",
      ));
      return;
    }

    const found = extractExports(source);
    const foundSet = new Set(found);
    const missing = body.expectedExports.filter((name) => !foundSet.has(name));

    return cacheAndSend(req, reply, 200, success(
      missing.length === 0 ? "All expected exports found." : `Missing ${missing.length} export(s).`,
      { modulePath: body.modulePath, found, missing, ok: missing.length === 0 },
    ));
  });

  // POST /workspaces/verify-baseline — composite typecheck + preview probe
  app.post(`${WORKSPACE_BASE}/verify-baseline`, async (req, reply) => {
    const body = parseOrFail(verifyBaselineBody as unknown as ZodSchema<{ skipPreview?: boolean; timeoutMs?: number } | undefined>, req.body ?? {}, reply);
    if (body === null) return;
    const { skipPreview, timeoutMs } = body ?? {};

    const failures: { category: string; errors: string[] }[] = [];

    // Typecheck
    const tsc = await runTsc(workspaceManager.getLocalPath(req.mcp!.companyId), timeoutMs ?? 60_000);
    recordTypecheck(tsc.ok, tsc.errors);
    if (!tsc.ok) failures.push({ category: "typecheck", errors: tsc.errors.slice(0, 3) });

    // Preview probe (optional)
    if (!skipPreview) {
      const probe = await probePreviewHealth(5000);
      recordPreview(probe.reachable, probe.error ? [probe.error] : []);
      if (!probe.reachable) {
        failures.push({ category: "preview", errors: [probe.error ?? "preview unreachable"] });
      }
    }

    const ok = failures.length === 0;
    return cacheAndSend(req, reply, 200, success(
      ok ? "Baseline verified." : `Baseline failed (${failures.length} category).`,
      { ok, failures, ranAt: new Date().toISOString() },
    ));
  });
}
