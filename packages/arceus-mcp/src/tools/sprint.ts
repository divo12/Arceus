import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const SPRINTS = "/api/internal/v1/sprints";

const sprintTaskSchema = z.object({
  title: z.string().min(1).max(500).describe("Task title — clear, actionable"),
  assigned_role: z.string().min(1).describe("Role to own this task: ceo, cto, pm, developer, tester, ui_designer, marketing, skills_lead"),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  depends_on: z.array(z.string()).default([]).describe("Titles of tasks this depends on (must match exactly)"),
  description: z.string().max(2000).default("").describe("What this task delivers"),
});

export const registerSprintTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "sprint_create",
    {
      description:
        "Create a new sprint with a goal and a set of tasks. Each task is assigned to a role " +
        "with a priority and optional dependencies (by title). The sprint becomes active immediately " +
        "and agents will pick up tasks on their next heartbeat. CEO role only.",
      inputSchema: {
        goal: z.string().min(3).max(1000).describe("Sprint goal — what success looks like"),
        tasks: z.array(sprintTaskSchema).min(1).max(30).describe("Tasks to create in this sprint"),
      },
    },
    async ({ goal, tasks }, extra) => {
      // DEBUG: log what OpenCode passes in the MCP tool callback's extra param
      console.error(`[MCP-DEBUG sprint_create] extra keys=${Object.keys(extra).join(",")}`);
      console.error(`[MCP-DEBUG sprint_create] extra.sessionId=${(extra as any).sessionId}`);
      console.error(`[MCP-DEBUG sprint_create] extra._meta=${JSON.stringify((extra as any)._meta)}`);
      console.error(`[MCP-DEBUG sprint_create] extra.authInfo=${JSON.stringify((extra as any).authInfo)}`);
      console.error(`[MCP-DEBUG sprint_create] extra.requestId=${(extra as any).requestId}`);
      console.error(`[MCP-DEBUG sprint_create] full extra=${JSON.stringify(extra, (k, v) => typeof v === "function" ? "[function]" : v)}`);
      const body = { goal, tasks };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SPRINTS}/create`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "sprint_create", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "sprint_get_active",
    {
      description:
        "Read the currently active sprint with task counts (total, completed, verified, blocked, failed). " +
        "Use at beat start to see what sprint you're operating in and overall progress.",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: `${SPRINTS}/active`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "sprint_check_completion",
    {
      description:
        "Check whether a sprint is ready to finalize. Returns counts of completed/verified/blocked/failed tasks plus readyToFinalize flag. Read-only.",
      inputSchema: { sprintId: z.string() },
    },
    async ({ sprintId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: `${SPRINTS}/${sprintId}/completion`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "sprint_run_qa_gate",
    {
      description:
        "Run the QA suite gate for a sprint. Reports unverified completed tasks and failed tasks. Read-only — does not mutate task statuses. Tester or CTO role.",
      inputSchema: { sprintId: z.string() },
    },
    async ({ sprintId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SPRINTS}/${sprintId}/qa-gate`,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "sprint_run_qa_gate", { sprintId }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "sprint_run_final_gate",
    {
      description:
        "Run the final build/integration/preview gate for a sprint. Read-only summary of verification readiness. CTO role only.",
      inputSchema: { sprintId: z.string() },
    },
    async ({ sprintId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SPRINTS}/${sprintId}/final-gate`,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "sprint_run_final_gate", { sprintId }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "sprint_finalize",
    {
      description:
        "Finalize a sprint: marks it completed and records timestamps. CEO role only. Call only after sprint_check_completion reports readyToFinalize.",
      inputSchema: { sprintId: z.string() },
    },
    async ({ sprintId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SPRINTS}/${sprintId}/finalize`,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "sprint_finalize", { sprintId }),
      });
      return toMcpContent(res.data);
    }
  );
};
