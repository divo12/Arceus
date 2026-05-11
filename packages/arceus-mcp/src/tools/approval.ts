import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const APPROVALS = "/api/internal/v1/approvals";

export const registerApprovalTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "approval_request",
    {
      description: "Request an external approval (strategy, hire, compliance). Routes to board.",
      inputSchema: {
        type: z.enum(["strategy", "hire", "meeting_blocker", "external_action", "tool_governance", "architecture_change", "scope_change"]),
        title: z.string().min(1),
        description: z.string().min(1),
        meetingId: z.string().nullable().optional(),
        agendaItemId: z.string().nullable().optional(),
      },
    },
    async ({ type, title, description, meetingId, agendaItemId }) => {
      // Don't send requestedByRole: ctx.role is empty in prod because
      // the MCP server runs with no BEAT_ID/COMPANY_ID/ROLE env (per-call
      // identity lives in session-context). The API resolves the role
      // from req.mcp.role (x-session-id → session map) and ignores any
      // client-supplied value when present.
      const body = { type, title, description, meetingId, agendaItemId };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: APPROVALS,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "approval_request", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "approval_get",
    {
      description:
        "Read a single approval by id, or list approvals via filters (status, filedByMe, pendingMyDecision, since, limit). Pass approvalId for single read.",
      inputSchema: {
        approvalId: z.string().optional(),
        status: z.enum(["pending", "approved", "rejected", "applied"]).optional(),
        filedByMe: z.boolean().optional(),
        pendingMyDecision: z.boolean().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ approvalId, status, filedByMe, pendingMyDecision, since, limit }) => {
      if (approvalId) {
        const res = await client.request<ToolResult>({
          method: "GET",
          path: `${APPROVALS}/${approvalId}`,
        });
        return toMcpContent(res.data);
      }
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (filedByMe) params.set("filedByMe", "true");
      if (pendingMyDecision) params.set("pendingMyDecision", "true");
      if (since) params.set("since", since);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      const res = await client.request<ToolResult>({
        method: "GET",
        path: qs ? `${APPROVALS}?${qs}` : APPROVALS,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "approval_update",
    {
      description:
        "Amend a pending approval you filed (title, description, meeting links). Fails if already decided or not the filer.",
      inputSchema: {
        approvalId: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        meetingId: z.string().nullable().optional(),
        agendaItemId: z.string().nullable().optional(),
      },
    },
    async ({ approvalId, title, description, meetingId, agendaItemId }) => {
      const body = { title, description, meetingId, agendaItemId };
      const res = await client.request<ToolResult>({
        method: "PATCH",
        path: `${APPROVALS}/${approvalId}`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "approval_update", { approvalId, ...body }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "approval_decide",
    {
      description:
        "CEO decides a pending approval (approved or rejected). Returns 403 for board-only types (strategy, hire, external_action).",
      inputSchema: {
        approvalId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ approvalId, decision, reason }) => {
      const body = { decision, reason };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${APPROVALS}/${approvalId}/decide`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "approval_decide", { approvalId, decision }),
      });
      return toMcpContent(res.data);
    }
  );
};
