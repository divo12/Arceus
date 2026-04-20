import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { success, toMcpContent } from "../envelope.js";

const TASKS = "/api/internal/v1/tasks";

export const registerTaskTools = (
  server: McpServer,
  _ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "task_complete",
    {
      description: "Mark a task completed. Triggers board notifications and unblocks dependents.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${TASKS}/${taskId}/completion`,
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_block",
    {
      description: "Mark a task blocked with a reason. Records blocker for later triage.",
      inputSchema: { taskId: z.string(), reason: z.string().max(1000) },
    },
    async ({ taskId, reason }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${TASKS}/${taskId}/block`,
        body: { reason },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_verify",
    {
      description: "Record tester verification on a task. Tester role only.",
      inputSchema: { taskId: z.string(), verifiedBy: z.string().min(1) },
    },
    async ({ taskId, verifiedBy }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${TASKS}/${taskId}/verification`,
        body: { verifiedBy },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_append_result",
    {
      description: "Append a result entry to a task's running log. Content-hash idempotent.",
      inputSchema: { taskId: z.string(), entry: z.string().max(4000) },
    },
    async ({ taskId, entry }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${TASKS}/${taskId}/results`,
        body: { entry },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_set_preview_url",
    {
      description: "Set the preview URL slot on a task. Replaces any prior value.",
      inputSchema: { taskId: z.string(), url: z.string().url().nullable() },
    },
    async ({ taskId, url }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "PUT",
        path: `${TASKS}/${taskId}/preview-url`,
        body: { url },
        idempotencyKey: randomUUID(),
      });
      return res.status === 204
        ? toMcpContent(success("Preview URL set.", { taskId }))
        : toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_create",
    {
      description: "Create a new task. CEO and PM roles only.",
      inputSchema: {
        title: z.string().max(200),
        description: z.string().max(4000).optional(),
        assignedRole: z.string(),
        sprintId: z.string().nullable().optional(),
        priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      },
    },
    async (args) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: TASKS,
        body: args,
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_update",
    {
      description: "Patch task fields (title, description, priority, role). PM role only.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        priority: z.enum(["low", "medium", "high", "critical"]).optional(),
        assignedRole: z.string().optional(),
      },
    },
    async ({ taskId, ...patch }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "PATCH",
        path: `${TASKS}/${taskId}`,
        body: patch,
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_hydrate_from_spec",
    {
      description: "Rehydrate a task's fields from a spec object. Idempotent. CEO only.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().min(1),
        description: z.string(),
        problem_statement: z.string(),
        deliverable: z.string(),
        definition_of_done: z.array(z.string()),
        priority: z.enum(["low", "medium", "high", "critical"]),
      },
    },
    async ({ taskId, ...spec }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${TASKS}/${taskId}/hydration`,
        body: spec,
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_attach_artifact",
    {
      description: "Link an existing artifact to a task. Safe to call repeatedly.",
      inputSchema: { taskId: z.string(), artifactId: z.string() },
    },
    async ({ taskId, artifactId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${TASKS}/${taskId}/artifacts`,
        body: { artifactId },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );
};
