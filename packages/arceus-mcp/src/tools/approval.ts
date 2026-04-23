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
        type: z.enum(["strategy", "hire", "meeting_blocker", "external_action", "tool_governance"]),
        title: z.string().min(1),
        description: z.string().min(1),
        meetingId: z.string().nullable().optional(),
        agendaItemId: z.string().nullable().optional(),
      },
    },
    async ({ type, title, description, meetingId, agendaItemId }) => {
      const body = { type, requestedByRole: ctx.role, title, description, meetingId, agendaItemId };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: APPROVALS,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "approval_request", body),
      });
      return toMcpContent(res.data);
    }
  );
};
