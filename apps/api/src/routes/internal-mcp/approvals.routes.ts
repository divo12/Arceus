import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { requestApproval } from "../../memory/handoffs.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const APPROVALS_BASE = "/api/internal/v1/approvals";

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

const approvalTypeSchema = z.enum([
  "strategy",
  "hire",
  "meeting_blocker",
  "external_action",
  "tool_governance",
]);

const roleSchema = z.enum([
  "ceo",
  "cto",
  "pm",
  "developer",
  "tester",
  "ui_designer",
  "marketing",
  "skills_lead",
]);

const createApprovalBody = z.object({
  type: approvalTypeSchema,
  requestedByRole: roleSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  meetingId: z.string().nullable().optional(),
  agendaItemId: z.string().nullable().optional(),
});

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpApprovalsRoutes(app: FastifyInstance): Promise<void> {
  app.post(APPROVALS_BASE, async (req, reply) => {
    const body = parseOrFail(createApprovalBody, req.body, reply);
    if (!body) return;

    const approval = requestApproval({
      type: body.type,
      requestedByRole: body.requestedByRole,
      title: body.title,
      description: body.description,
      meetingId: body.meetingId ?? null,
      agendaItemId: body.agendaItemId ?? null,
    });

    if (!approval) {
      reply.code(409).send(
        failure(
          `Agent with role ${body.requestedByRole} is not provisioned; cannot request approval.`,
          "conflict",
          "never",
          "agent_provisioned",
        ),
      );
      return;
    }

    const location = `${APPROVALS_BASE}/${approval.id}`;
    cacheAndSend(
      req,
      reply,
      201,
      success(`Approval ${approval.id} requested.`, {
        approvalId: approval.id,
        type: approval.type,
        status: approval.status,
      }),
      location,
    );
  });
}
