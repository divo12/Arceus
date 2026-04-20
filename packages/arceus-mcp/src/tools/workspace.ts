import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { toMcpContent } from "../envelope.js";

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
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${WORKSPACES}/checkpoints`,
        body: { taskId, agentRole: ctx.role, message },
        idempotencyKey: randomUUID(),
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
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${WORKSPACES}/preview-probes`,
        body: { timeoutMs },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );
};
