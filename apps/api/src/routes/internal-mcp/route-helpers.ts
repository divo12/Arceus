/**
 * Shared route helpers — extracted from per-route-file boilerplate.
 * Every route module can import these instead of re-declaring.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodSchema } from "zod";
import { failure, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

export const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

export const sendValidation = (reply: FastifyReply, err: ZodError): FastifyReply => {
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

export const sendNotFound = (reply: FastifyReply, resource: string): FastifyReply => {
  return reply.code(404).send(failure(`${resource} not found.`, "not_found", "never", "resource_created"));
};

export const sendConflict = (reply: FastifyReply, summary: string): FastifyReply => {
  return reply.code(409).send(failure(summary, "conflict", "never", "state_reset"));
};

export const sendGone = (reply: FastifyReply, tool: string, replacement: string): FastifyReply => {
  return reply.code(410).send(failure(
    `Tool "${tool}" is retired. Use "${replacement}" instead.`,
    "tool_retired",
    "never",
    "use_replacement",
  ));
};

export const parseOrFail = <T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data;
};

export const cacheAndSend = (
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
