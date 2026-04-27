import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { addArtifactSync, writeArtifactToWorkspace, attachArtifactToTask } from "../../tasks/index.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { artifacts, type Artifact } from "../../orchestration/state.js";
import { observability } from "@arceus/contracts";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const ARTIFACT_BASE = "/api/internal/v1/artifacts";

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

const sendNotFound = (reply: FastifyReply, resource: string): void => {
  reply.code(404).send(failure(`${resource} not found.`, "not_found", "never", "resource_created"));
};

const parseOrFail = <T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data;
};

const findArtifact = (artifactId: string): Artifact | null =>
  artifacts.find((a) => a.id === artifactId) ?? null;

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

const ARTIFACT_KINDS = ["plan", "code", "output", "specification"] as const;

const createArtifactBody = z.object({
  agent: z.string().max(100).optional(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(200_000),
  taskId: z.string().min(1).optional(),
  attachToTaskIds: z.array(z.string()).max(10).optional(),
});

const workspaceWriteBody = z.object({
  taskId: z.string().min(1),
  role: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "slug must be lowercase kebab/underscore"),
});

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpArtifactsRoutes(app: FastifyInstance): Promise<void> {
  // POST /artifacts — create + optionally attach to a task
  app.post(`${ARTIFACT_BASE}`, async (req, reply) => {
    const body = parseOrFail(createArtifactBody, req.body, reply);
    if (!body) return;

    const agent = body.agent || req.mcp?.role || "unknown";
    // Spec 28 Phase B.1 — durable write before returning success.
    const artifact = await addArtifactSync(agent, body.kind, body.title, body.content);

    // Attach to tasks — support both single taskId and array
    const taskIds = body.attachToTaskIds ?? (body.taskId ? [body.taskId] : []);
    for (const tid of taskIds) {
      attachArtifactToTask(tid, artifact.id);
      observability.logEvent({
        event: "task.artifact_attached",
        taskId: tid,
        artifactId: artifact.id,
        companyId: req.mcp!.companyId,
        ts: Date.now(),
      });
    }

    observability.logEvent({
      event: "artifact.created",
      artifactId: artifact.id,
      companyId: req.mcp!.companyId,
      kind: body.kind,
      attachedTaskIds: taskIds,
      ts: Date.now(),
    });

    const location = `${ARTIFACT_BASE}/${artifact.id}`;
    cacheAndSend(
      req,
      reply,
      201,
      success(`Artifact ${artifact.id} created.`, {
        artifactId: artifact.id,
        kind: artifact.kind,
        attachedToTaskIds: taskIds,
      }),
      location,
    );
  });

  // POST /artifacts/:artifactId/workspace-writes — materialize artifact into workspace docs
  app.post<{ Params: { artifactId: string } }>(
    `${ARTIFACT_BASE}/:artifactId/workspace-writes`,
    async (req, reply) => {
      const body = parseOrFail(workspaceWriteBody, req.body, reply);
      if (!body) return;
      const { artifactId } = req.params;

      const artifact = findArtifact(artifactId);
      if (!artifact) {
        sendNotFound(reply, `Artifact ${artifactId}`);
        return;
      }

      try {
        await writeArtifactToWorkspace(body.taskId, body.role, body.slug, artifact.content);
      } catch (error) {
        reply.code(503).send(
          failure(
            `Failed to write artifact to workspace: ${error instanceof Error ? error.message : "unknown error"}`,
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
        200,
        success(`Artifact ${artifactId} written to docs/${body.slug}.md.`, {
          artifactId,
          taskId: body.taskId,
          relativePath: `docs/${body.slug}.md`,
        }),
      );
    },
  );

  // POST /artifacts/:artifactId/persistence — RETIRED (Spec 28 Phase C.1).
  // `artifact_create` now writes through `addArtifactSync` so explicit
  // persistence is unnecessary. Returns 410 Gone for ~2 weeks, then removed.
  app.post<{ Params: { artifactId: string } }>(
    `${ARTIFACT_BASE}/:artifactId/persistence`,
    async (_req, reply) => {
      reply.code(410).send({
        ...failure(
          "artifact_persist is retired. Artifacts are persisted automatically on creation.",
          "tool_retired",
          "never",
          "caller_updated",
        ),
        replacement: "artifact_create",
      });
    },
  );

  // GET /artifacts/:artifactId — read a single artifact
  app.get<{ Params: { artifactId: string } }>(
    `${ARTIFACT_BASE}/:artifactId`,
    async (req, reply) => {
      const { artifactId } = req.params;
      const artifact = findArtifact(artifactId);
      if (!artifact) {
        sendNotFound(reply, `Artifact ${artifactId}`);
        return;
      }
      cacheAndSend(req, reply, 200, success(`Artifact ${artifactId}.`, { artifact }));
    },
  );

  // GET /artifacts?sprintId=X — list artifacts for a sprint
  app.get<{ Querystring: { sprintId?: string; kind?: string; limit?: string } }>(
    ARTIFACT_BASE,
    async (req, reply) => {
      const { sprintId, kind, limit: limitStr } = req.query;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const limit = Math.min(parseInt(limitStr || "50", 10), 100);

      let filtered = artifacts;

      if (sprintId) {
        // Find tasks in this sprint, then find artifacts attached to those tasks
        const sprintTaskIds = new Set(
          snapshot.tasks.filter((t) => t.sprintId === sprintId).map((t) => t.id),
        );
        filtered = filtered.filter(
          (a) => snapshot.tasks.some(
            (t) => sprintTaskIds.has(t.id) && t.artifactIds.includes(a.id),
          ),
        );
      }

      if (kind) {
        filtered = filtered.filter((a) => a.kind === kind);
      }

      const results = filtered.slice(-limit);

      cacheAndSend(req, reply, 200, success(
        `${results.length} artifact(s) found.`,
        { artifacts: results, total: results.length },
      ));
    },
  );
}
