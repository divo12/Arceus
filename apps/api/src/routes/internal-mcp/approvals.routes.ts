import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { requestApproval } from "../../memory/handoffs.js";
import { updateApproval } from "../../persistence/mutations/index.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { getAgentByRole } from "@arceus/task-engine";
import { observability } from "@arceus/contracts";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const BOARD_ONLY_TYPES = ["strategy", "hire", "external_action"] as const;

const APPROVALS_BASE = "/api/internal/v1/approvals";

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
    if (!body) return reply;

    const approval = await requestApproval(req.mcp!.companyId, {
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
      return cacheAndSend(
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

    observability.logEvent({
      event: "approval.requested",
      approvalId: approval.id,
      companyId: req.mcp!.companyId,
      kind: approval.type,
      ts: Date.now(),
    });

    const location = `${APPROVALS_BASE}/${approval.id}`;
    return cacheAndSend(
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
      const approvalId = req.params.approvalId ?? "";
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const approval = snapshot.approvals?.find((a) => a.id === approvalId);
      if (!approval) {
        return reply.code(404).send(failure(`Approval ${approvalId} not found.`, "not_found", "never", "approval_exists"));
        return;
      }
      return cacheAndSend(req, reply, 200, success(`Approval ${approvalId}.`, { approval }));
    },
  );

  // GET /approvals — list approvals with filters
  app.get<{ Querystring: { status?: string; limit?: string; filedByMe?: string; pendingMyDecision?: string; since?: string } }>(
    APPROVALS_BASE,
    async (req, reply) => {
      const { status, limit: limitStr, filedByMe, pendingMyDecision, since } = req.query;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const limit = Math.min(parseInt(limitStr || "50", 10), 100);
      let approvals = snapshot.approvals ?? [];

      if (status) {
        approvals = approvals.filter((a) => a.status === status);
      }

      const role = req.mcp?.role;
      if (filedByMe === "true" && role) {
        const me = getAgentByRole(snapshot, role as Parameters<typeof getAgentByRole>[1]);
        approvals = me ? approvals.filter((a) => a.requestedByAgentId === me.id) : [];
      }

      if (pendingMyDecision === "true") {
        if (role !== "ceo") {
          approvals = [];
        } else {
          approvals = approvals.filter(
            (a) => a.status === "pending" && !BOARD_ONLY_TYPES.includes(a.type as typeof BOARD_ONLY_TYPES[number]),
          );
        }
      }

      if (since) {
        const cutoff = Date.parse(since);
        if (!Number.isNaN(cutoff)) {
          approvals = approvals.filter((a) => {
            const ts = (a as { createdAt?: string }).createdAt;
            return !ts || Date.parse(ts) >= cutoff;
          });
        }
      }

      const results = approvals.slice(-limit);
      return cacheAndSend(req, reply, 200, success(`${results.length} approval(s).`, {
        approvals: results,
        total: results.length,
      }));
    },
  );

  // PATCH /approvals/:approvalId — filer amends pending approval
  const updateApprovalBody = z.object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    meetingId: z.string().nullable().optional(),
    agendaItemId: z.string().nullable().optional(),
  });

  app.patch<{ Params: { approvalId: string } }>(
    `${APPROVALS_BASE}/:approvalId`,
    async (req, reply) => {
      const { approvalId } = req.params;
      const role = req.mcp?.role;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const approval = snapshot.approvals?.find((a) => a.id === approvalId);
      if (!approval) {
        return reply.code(404).send(failure(`Approval ${approvalId} not found.`, "not_found", "never", "approval_exists"));
        return;
      }
      if (approval.status !== "pending") {
        return reply.code(409).send(failure(
          `Approval ${approvalId} is "${approval.status}" — cannot amend after decision.`,
          "approval_not_pending", "never", "approval_pending",
        ));
        return;
      }
      const filer = role ? getAgentByRole(snapshot, role as Parameters<typeof getAgentByRole>[1]) : null;
      if (filer?.id !== approval.requestedByAgentId) {
        return reply.code(403).send(failure(
          `Only the filer may amend approval ${approvalId}.`,
          "governance", "never", "role_is_filer",
        ));
        return;
      }

      const body = parseOrFail(updateApprovalBody, req.body, reply);
      if (!body) return reply;

      const updated = updateApproval(approvalId, (current) => ({
        ...current,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.meetingId !== undefined ? { meetingId: body.meetingId } : {}),
        ...(body.agendaItemId !== undefined ? { agendaItemId: body.agendaItemId } : {}),
      }));

      return cacheAndSend(req, reply, 200, success(`Approval ${approvalId} updated.`, { approval: updated }));
    },
  );

  // POST /approvals/:approvalId/decide — CEO decides on an approval
  app.post<{ Params: { approvalId: string } }>(
    `${APPROVALS_BASE}/:approvalId/decide`,
    async (req, reply) => {
      if (req.mcp?.role !== "ceo") {
        return reply.code(403).send(failure("Only CEO can decide approvals.", "governance", "never", "role_is_ceo"));
        return;
      }

      const decideBody = z.object({
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().max(2000).optional(),
      });
      const body = parseOrFail(decideBody, req.body, reply);
      if (!body) return reply;

      const { approvalId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp.companyId);
      const approval = snapshot.approvals?.find((a) => a.id === approvalId);
      if (!approval) {
        return reply.code(404).send(failure(`Approval ${approvalId} not found.`, "not_found", "never", "approval_exists"));
        return;
      }

      if (approval.status !== "pending") {
        return reply.code(409).send(failure(
          `Approval ${approvalId} is "${approval.status}" — not pending.`,
          "approval_not_pending", "never", "approval_pending",
        ));
        return;
      }

      // Type-gated: CEO cannot decide board-only types
      const boardOnlyTypes = ["strategy", "hire", "external_action"];
      if (boardOnlyTypes.includes(approval.type)) {
        return reply.code(403).send(failure(
          `Approval type "${approval.type}" requires board decision, not CEO.`,
          "type_not_allowed", "never", "board_decides",
        ));
        return;
      }

      approval.status = body.decision;
      approval.resolutionSummary = body.reason ?? `${body.decision} by CEO`;

      observability.logEvent({
        event: "approval.resolved",
        approvalId,
        companyId: req.mcp.companyId,
        outcome: body.decision,
        ts: Date.now(),
      });

      return cacheAndSend(req, reply, 200, success(`Approval ${approvalId} ${body.decision}.`, {
        approvalId,
        decision: body.decision,
      }));
    },
  );
}
