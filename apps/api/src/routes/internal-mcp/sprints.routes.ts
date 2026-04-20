import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { triggerCeoSprintProposal } from "../../sprints/proposals.js";
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

const proposalBody = z.object({}).passthrough().optional();

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpSprintsRoutes(app: FastifyInstance): Promise<void> {
  // POST /sprints/proposals — CEO-only async dispatch
  app.post(`${SPRINTS_BASE}/proposals`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      reply.code(403).send(
        failure(
          "Sprint proposals may only be dispatched by the CEO role.",
          "governance",
          "never",
          "role_is_ceo",
        ),
      );
      return;
    }

    const parsed = parseOrFail(proposalBody, req.body ?? {}, reply);
    if (parsed === null) return;

    void triggerCeoSprintProposal().catch((err) => {
      req.log.warn({ err }, "ceo sprint proposal dispatch failed");
    });

    cacheAndSend(
      req,
      reply,
      202,
      success("CEO sprint proposal dispatched asynchronously.", {
        queued: true,
        note: "Proposal runs async with in-flight and cooldown guards.",
      }),
    );
  });
}
