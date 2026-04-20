import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { workspaceManager } from "../../workspace/manager.js";
import { probePreviewHealth } from "../../workspace/preview.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const WORKSPACE_BASE = "/api/internal/v1/workspaces";

const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const sendValidation = (reply: FastifyReply, err: ZodError): void => {
  reply.code(422).send({
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
): void => {
  if (locationHeader) void reply.header("location", locationHeader);
  cacheSuccessfulResponse(req, { status, body, locationHeader: locationHeader ?? null });
  reply.code(status).send(body);
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

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpWorkspacesRoutes(app: FastifyInstance): Promise<void> {
  // POST /workspaces/checkpoints — git commit + bundle sync
  app.post(`${WORKSPACE_BASE}/checkpoints`, async (req, reply) => {
    const body = parseOrFail(checkpointBody, req.body, reply);
    if (!body) return;

    const mcp = req.mcp!;
    const companyId = mcp.companyId;

    if (!companyId || companyId === "company_pending") {
      reply.code(409).send(
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
      reply.code(503).send(
        failure(
          `Workspace commit failed: ${error instanceof Error ? error.message : "unknown error"}`,
          "upstream",
          "safe",
          "workspace_available",
        ),
      );
      return;
    }

    cacheAndSend(
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

  // POST /workspaces/preview-probes — HTTP probe of the local preview URL
  app.post(`${WORKSPACE_BASE}/preview-probes`, async (req, reply) => {
    const body = parseOrFail(previewProbeBody, req.body ?? {}, reply);
    if (!body) return;

    const probe = await probePreviewHealth(body.timeoutMs);

    cacheAndSend(
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
}
