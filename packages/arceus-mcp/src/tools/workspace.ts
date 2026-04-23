import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const WORKSPACES = "/api/internal/v1/workspaces";

export const registerWorkspaceTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "workspace_checkpoint",
    {
      description: "Commit current workspace state as a git checkpoint. Returns the commit sha.",
      inputSchema: {
        taskId: z.string(),
        message: z.string().max(1000),
      },
    },
    async ({ taskId, message }) => {
      const body = { taskId, agentRole: ctx.role, message };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${WORKSPACES}/checkpoints`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_checkpoint", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_probe_preview",
    {
      description: "Probe the preview server and report status + URL.",
      inputSchema: {
        timeoutMs: z.number().int().min(100).max(30_000).optional(),
      },
    },
    async ({ timeoutMs }) => {
      const body = { timeoutMs };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${WORKSPACES}/preview-probes`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_probe_preview", body),
      });
      return toMcpContent(res.data);
    }
  );
};
