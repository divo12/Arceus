import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { requestApproval } from "../../memory/handoffs.js";
import { getSnapshot } from "../../persistence/store.js";
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
  "architecture_change",
  "scope_change",
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
      type: body.type as "strategy" | "hire" | "meeting_blocker" | "external_action" | "tool_governance",
      requestedByRole: body.requestedByRole,
      title: body.title,
      description: body.description,
      meetingId: body.meetingId ?? null,
      agendaItemId: body.agendaItemId ?? null,
    });

    if (!approval) {
      // Cache the 409 so a retry with the same Idempotency-Key returns the
      // same response instead of re-executing requestApproval (which would
      // still fail but would advertise as a fresh call to the agent).
      cacheAndSend(
        req,
        reply,
        409,
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

  // GET /approvals/:approvalId — read a single approval, or GET /approvals?status=&pendingMyDecision=
  app.get<{ Params: { approvalId?: string }; Querystring: { status?: string; limit?: string } }>(
    `${APPROVALS_BASE}/:approvalId`,
    async (req, reply) => {
      const { approvalId } = req.params;
      const snapshot = getSnapshot();
      const approval = snapshot.approvals?.find((a) => a.id === approvalId);
      if (!approval) {
        reply.code(404).send(failure(`Approval ${approvalId} not found.`, "not_found", "never", "approval_exists"));
        return;
      }
      cacheAndSend(req, reply, 200, success(`Approval ${approvalId}.`, { approval }));
    },
  );

  // GET /approvals — list approvals with filters
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    APPROVALS_BASE,
    async (req, reply) => {
      const { status, limit: limitStr } = req.query;
      const snapshot = getSnapshot();
      const limit = Math.min(parseInt(limitStr || "50", 10), 100);
      let approvals = snapshot.approvals ?? [];

      if (status) {
        approvals = approvals.filter((a) => a.status === status);
      }

      const results = approvals.slice(-limit);
      cacheAndSend(req, reply, 200, success(`${results.length} approval(s).`, {
        approvals: results,
        total: results.length,
      }));
    },
  );

  // POST /approvals/:approvalId/decide — CEO decides on an approval
  app.post<{ Params: { approvalId: string } }>(
    `${APPROVALS_BASE}/:approvalId/decide`,
    async (req, reply) => {
      if (req.mcp?.role !== "ceo") {
        reply.code(403).send(failure("Only CEO can decide approvals.", "governance", "never", "role_is_ceo"));
        return;
      }

      const decideBody = z.object({
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().max(2000).optional(),
      });
      const body = parseOrFail(decideBody, req.body, reply);
      if (!body) return;

      const { approvalId } = req.params;
      const snapshot = getSnapshot();
      const approval = snapshot.approvals?.find((a) => a.id === approvalId);
      if (!approval) {
        reply.code(404).send(failure(`Approval ${approvalId} not found.`, "not_found", "never", "approval_exists"));
        return;
      }

      if (approval.status !== "pending") {
        reply.code(409).send(failure(
          `Approval ${approvalId} is "${approval.status}" — not pending.`,
          "approval_not_pending", "never", "approval_pending",
        ));
        return;
      }

      // Type-gated: CEO cannot decide board-only types
      const boardOnlyTypes = ["strategy", "hire", "external_action"];
      if (boardOnlyTypes.includes(approval.type)) {
        reply.code(403).send(failure(
          `Approval type "${approval.type}" requires board decision, not CEO.`,
          "type_not_allowed", "never", "board_decides",
        ));
        return;
      }

      approval.status = body.decision;
      approval.resolutionSummary = body.reason ?? `${body.decision} by CEO`;

      cacheAndSend(req, reply, 200, success(`Approval ${approvalId} ${body.decision}.`, {
        approvalId,
        decision: body.decision,
      }));
    },
  );
}
