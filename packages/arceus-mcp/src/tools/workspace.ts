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

  // ── Phase G: workspace MCP §8 ─────────────────────────

  server.registerTool(
    "workspace_get_preview_url",
    {
      description: "Read the preview URL for a task (or the global preview URL when no task is supplied).",
      inputSchema: { taskId: z.string().optional() },
    },
    async ({ taskId }) => {
      const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: `${WORKSPACES}/preview-url${query}`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_get_build_health",
    {
      description: "Read cached typecheck/build/test/preview health (status, since, first errors).",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: `${WORKSPACES}/build-health`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_check_exports",
    {
      description: "Verify a module file exports the expected names. Returns {found, missing, ok}.",
      inputSchema: {
        modulePath: z.string(),
        expectedExports: z.array(z.string()).min(1).max(50),
      },
    },
    async ({ modulePath, expectedExports }) => {
      const body = { modulePath, expectedExports };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${WORKSPACES}/check-exports`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_check_exports", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_verify_baseline",
    {
      description: "Composite baseline: typecheck + preview probe. Returns {ok, failures:[{category,errors}]}.",
      inputSchema: {
        skipPreview: z.boolean().optional(),
        timeoutMs: z.number().int().min(1000).max(120_000).optional(),
      },
    },
    async ({ skipPreview, timeoutMs }) => {
      const body = { skipPreview, timeoutMs };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${WORKSPACES}/verify-baseline`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_verify_baseline", body),
      });
      return toMcpContent(res.data);
    }
  );
};
