import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { addArtifact, writeArtifactToWorkspace, attachArtifactToTask } from "../../tasks/index.js";
import { getSnapshot } from "../../persistence/store.js";
import { artifacts, type Artifact } from "../../orchestration/state.js";
import { persistRuntimeArtifact } from "../../persistence/artifact-persistence.js";
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
  agent: z.string().min(1).max(100),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(200_000),
  taskId: z.string().min(1).optional(),
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

const persistenceBody = z.object({
  sprintId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  fileReferences: z.array(z.unknown()).optional(),
});

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpArtifactsRoutes(app: FastifyInstance): Promise<void> {
  // POST /artifacts — create + optionally attach to a task
  app.post(`${ARTIFACT_BASE}`, async (req, reply) => {
    const body = parseOrFail(createArtifactBody, req.body, reply);
    if (!body) return;

    const artifact = addArtifact(body.agent, body.kind, body.title, body.content);

    if (body.taskId) {
      attachArtifactToTask(body.taskId, artifact.id);
    }

    const location = `${ARTIFACT_BASE}/${artifact.id}`;
    cacheAndSend(
      req,
      reply,
      201,
      success(`Artifact ${artifact.id} created.`, {
        artifactId: artifact.id,
        kind: artifact.kind,
        taskId: body.taskId ?? null,
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

  // POST /artifacts/:artifactId/persistence — force DB/Supabase persistence
  app.post<{ Params: { artifactId: string } }>(
    `${ARTIFACT_BASE}/:artifactId/persistence`,
    async (req, reply) => {
      const body = parseOrFail(persistenceBody, req.body, reply);
      if (!body) return;
      const { artifactId } = req.params;

      const artifact = findArtifact(artifactId);
      if (!artifact) {
        sendNotFound(reply, `Artifact ${artifactId}`);
        return;
      }

      const mcp = req.mcp!;
      const companyId = mcp.companyId || getSnapshot().company.id;

      try {
        await persistRuntimeArtifact(companyId, {
          id: artifact.id,
          agent: artifact.agent,
          kind: artifact.kind === "specification" ? "specification" : artifact.kind,
          title: artifact.title,
          content: artifact.content,
          createdAt: artifact.createdAt,
          sprintId: body.sprintId ?? null,
          taskId: body.taskId ?? null,
          fileReferences: body.fileReferences ?? [],
        });
      } catch (error) {
        reply.code(503).send(
          failure(
            `Persistence failed: ${error instanceof Error ? error.message : "unknown error"}`,
            "upstream",
            "safe",
            "db_available",
          ),
        );
        return;
      }

      cacheAndSend(
        req,
        reply,
        200,
        success(`Artifact ${artifactId} persisted.`, {
          artifactId,
          companyId,
          sprintId: body.sprintId ?? null,
          taskId: body.taskId ?? null,
        }),
      );
    },
  );
}
