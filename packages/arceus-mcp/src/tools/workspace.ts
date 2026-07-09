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
      // Don't send agentRole: ctx.role is empty in prod (per-call role
      // lives in session-context, resolved server-side from x-session-id).
      // The API derives the role from req.mcp.role and ignores any
      // client-supplied value when present.
      const body = { taskId, message };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${WORKSPACES}/checkpoints`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_checkpoint", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_start_preview",
    {
      description:
        "Start the local preview dev server for the product workspace. " +
        "Auto-detects the framework (Vite, Next.js, Express, etc.) and runs the appropriate dev command. " +
        "Returns the preview URL when the server is ready. " +
        "Call this after your build work is done so you can verify and share the preview link.",
      inputSchema: {
        targetPath: z.string().optional().describe("Subdirectory inside the workspace to launch (e.g. 'frontend'). Omit for auto-detect."),
      },
    },
    async ({ targetPath }) => {
      const body = { targetPath: targetPath ?? null };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${WORKSPACES}/preview-start`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_start_preview", body),
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
      const res = await client.request<ToolResult>({
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
      const res = await client.request<ToolResult>({
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
      const res = await client.request<ToolResult>({
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
      const res = await client.request<ToolResult>({
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
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${WORKSPACES}/verify-baseline`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_verify_baseline", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_run_flow_test",
    {
      description:
        "Drive the live preview in a real browser via the flow-tester agent. " +
        "Returns {passed, verdict, final_url}. Required for viewable-task verification. " +
        "Omit url to use the task preview or the running workspace preview.",
      inputSchema: {
        url: z.string().url().optional().describe("Preview URL to test. Omit to resolve from task/preview."),
        goal: z.string().min(1).max(4000).optional().describe("Optional product-specific goal for the browser agent."),
        maxSteps: z.number().int().min(5).max(10).optional(),
        taskId: z.string().optional().describe("Resolve preview URL from this task when url is omitted."),
      },
    },
    async ({ url, goal, maxSteps, taskId }) => {
      const body = { url, goal, maxSteps, taskId };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${WORKSPACES}/flow-test`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_run_flow_test", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_deploy_production",
    {
      description:
        "Build and publish the product to https://<name>.<company_hash>.arceus.sh. " +
        "Returns {url, mode}. Call after verification so the board gets a real site URL.",
      inputSchema: {
        announce: z.boolean().optional().describe("Post the live URL to the board chat. Default true."),
      },
    },
    async ({ announce }) => {
      const body = { announce };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${WORKSPACES}/deploy-production`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "workspace_deploy_production", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "workspace_get_production_url",
    {
      description: "Read the company's live site URL (https://<name>.<hash>.arceus.sh).",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${WORKSPACES}/production-url`,
      });
      return toMcpContent(res.data);
    }
  );

  // Dream/Chorus-style durable checklist — workspace TODO.md (not the DB heartbeat field).
  server.registerTool(
    "todo_write",
    {
      description:
        "Add a TODO item or mark one done in the workspace markdown checklist (default TODO.md). List steps up front; check each off the moment it is done.",
      inputSchema: {
        item: z.string().min(1).max(1000).describe("The TODO item text (without the checkbox prefix)."),
        checked: z.boolean().optional().describe("Whether the item is done. Default false (add unchecked)."),
        path: z.string().min(1).max(200).optional().describe("Checklist file within the workspace. Default TODO.md."),
      },
    },
    async ({ item, checked, path }) => {
      const body = { item, checked: checked ?? false, path: path ?? "TODO.md" };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${WORKSPACES}/todo-write`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "todo_write", body),
      });
      return toMcpContent(res.data);
    }
  );
};
