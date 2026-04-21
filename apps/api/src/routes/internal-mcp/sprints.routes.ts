import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { createSprintWithTasks } from "../../sprints/proposals.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const SPRINTS_BASE = "/api/internal/v1/sprints";

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
): void => {
  cacheSuccessfulResponse(req, { status, body, locationHeader: null });
  reply.code(status).send(body);
};

// ── Schemas ──────────────────────────────────────────────

const sprintTaskSchema = z.object({
  title: z.string().min(1).max(500),
  assigned_role: z.string().min(1),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  depends_on: z.array(z.string()).default([]),
  description: z.string().max(2000).default(""),
});

const sprintCreateBody = z.object({
  goal: z.string().min(3).max(1000),
  tasks: z.array(sprintTaskSchema).min(1).max(30),
});

export type SprintCreateInput = z.infer<typeof sprintCreateBody>;

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpSprintsRoutes(app: FastifyInstance): Promise<void> {
  // POST /sprints/create — CEO creates a sprint with tasks (synchronous, agentic)
  app.post(`${SPRINTS_BASE}/create`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      reply.code(403).send(
        failure(
          "Only the CEO role may create sprints.",
          "governance",
          "never",
          "role_is_ceo",
        ),
      );
      return;
    }

    const parsed = parseOrFail(sprintCreateBody, req.body ?? {}, reply);
    if (parsed === null) return;

    try {
      const result = await createSprintWithTasks(parsed);
      cacheAndSend(req, reply, 201, success("Sprint created.", result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sprint creation failed.";
      reply.code(400).send(failure(msg, "validation", "never", "payload_fixed"));
    }
  });
}
