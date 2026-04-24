import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const EXEC = "/api/internal/v1/execution";

export const registerExecutionTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "execution_get_status",
    {
      description:
        "Read the current execution-cycle status: company status, current sprint info, and agent count. " +
        "Use to determine whether the company is active, paused, or awaiting reconciliation.",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: EXEC,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "execution_complete_cycle",
    {
      description:
        "Mark the current execution cycle complete and signal readiness for the next sprint. " +
        "Requires the active sprint to be in 'completed' status (finalize first). CEO only.",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${EXEC}/complete-cycle`,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "execution_complete_cycle", {}),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "execution_pause",
    {
      description:
        "Pause company execution for human review. Halts new beats; in-flight beats finish. CEO only.",
      inputSchema: {
        reason: z.string().max(500).optional().describe("Why execution is being paused"),
      },
    },
    async ({ reason }) => {
      const body = { reason };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${EXEC}/pause`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "execution_pause", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "execution_reconcile",
    {
      description:
        "Reconcile state after human review and optionally resume execution. CEO only.",
      inputSchema: {
        notes: z.string().max(2000).optional().describe("Notes from the review"),
        resumeExecution: z.boolean().default(true).describe("Whether to resume execution after reconciling"),
      },
    },
    async ({ notes, resumeExecution }) => {
      const body = { notes, resumeExecution };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${EXEC}/reconcile`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "execution_reconcile", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "execution_stop",
    {
      description:
        "Halt the company entirely (status → 'archived'). Terminal action. CEO only.",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${EXEC}/stop`,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "execution_stop", {}),
      });
      return toMcpContent(res.data);
    }
  );
};
