import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { toMcpContent } from "../envelope.js";

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
  _ctx: McpContext,
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
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SPRINTS}/create`,
        body: { goal, tasks },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );
};
