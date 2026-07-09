import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, success, toMcpContent } from "../envelope.js";

const TASKS = "/api/internal/v1/tasks";

export const registerTaskTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "task_complete",
    {
      description:
        "Mark a task completed. Requires evidenceArtifactIds; server re-checks typecheck/preview for code tasks.",
      inputSchema: {
        taskId: z.string(),
        evidenceArtifactIds: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("Artifact ids proving the work (code/output/qa_report). Required."),
        summary: z.string().max(2000).optional(),
      },
    },
    async ({ taskId, evidenceArtifactIds, summary }) => {
      const body = { evidenceArtifactIds, summary };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/completion`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_complete", { taskId, evidenceArtifactIds }),
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
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/block`,
        body: { reason },
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_block", { taskId, reason }),
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
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/verification`,
        body: { verifiedBy },
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_verify", { taskId, verifiedBy }),
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
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/results`,
        body: { entry },
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_append_result", { taskId, entry }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_set_preview_url",
    {
      description:
        "Publish the running preview server's URL to this task so the chat preview pane renders. The server reads the live preview state — DO NOT pass a URL. Call `workspace_start_preview` first; this tool fails with 409 if no preview is running.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const res = await client.request<ToolResult>({
        method: "PUT",
        path: `${TASKS}/${taskId}/preview-url`,
        body: {},
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_set_preview_url", { taskId }),
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
        referenceArtifactIds: z.array(z.string()).max(10).optional()
          .describe("Artifact IDs to link at creation (replaces task_attach_artifact)"),
      },
    },
    async (args) => {
      const res = await client.request<ToolResult>({
        method: "POST",
        path: TASKS,
        body: args,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_create", args),
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
        referenceArtifactIds: z.array(z.string()).max(10).optional()
          .describe("Artifact IDs to link (replaces task_attach_artifact)"),
      },
    },
    async ({ taskId, ...patch }) => {
      const res = await client.request<ToolResult>({
        method: "PATCH",
        path: `${TASKS}/${taskId}`,
        body: patch,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_update", { taskId, ...patch }),
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
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/hydration`,
        body: spec,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_hydrate_from_spec", { taskId, ...spec }),
      });
      return toMcpContent(res.data);
    }
  );

  // `task_attach_artifact` retired (Spec 28 Phase C.1) — use
  // `task_create({ referenceArtifactIds })` or `task_update({ referenceArtifactIds })`
  // (added in Phase A.2). The route still returns 410 Gone with `tool_retired`
  // for ~2 weeks, then will be removed.

  server.registerTool(
    "task_claim",
    {
      description:
        "Claim a planned/created task for this beat. Transitions the task to in_progress. " +
        "Call this BEFORE starting work on a task — the orchestrator does not assign tasks.",
      inputSchema: {
        taskId: z.string(),
        reason: z.string().max(1000).describe("Why you are picking this task (e.g. highest priority unblocked)"),
      },
    },
    async ({ taskId, reason }) => {
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/claim`,
        body: { reason },
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_claim", { taskId, reason }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_update_progress",
    {
      description:
        "Report progress on the current task. Call periodically during long work to keep the system informed.",
      inputSchema: {
        taskId: z.string(),
        percent: z.number().min(0).max(100).optional().describe("Estimated completion percentage"),
        note: z.string().max(2000).optional().describe("What you just did or are about to do"),
        completedSteps: z.number().int().nonnegative().optional(),
        totalSteps: z.number().int().positive().nullable().optional(),
        filesModified: z.array(z.string()).optional(),
      },
    },
    async ({ taskId, ...progress }) => {
      const res = await client.request<ToolResult>({
        method: "PATCH",
        path: `${TASKS}/${taskId}/progress`,
        body: progress,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_update_progress", { taskId, ...progress }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_append_command",
    {
      description:
        "Append a shell command (and optional exit code) to the task's running log. Content-hash idempotent.",
      inputSchema: {
        taskId: z.string(),
        command: z.string().min(1).max(2000),
        exitCode: z.number().int().optional(),
      },
    },
    async ({ taskId, command, exitCode }) => {
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/commands`,
        body: { command, exitCode },
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_append_command", { taskId, command, exitCode }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_get",
    {
      description:
        "Read a task by id. Pass includeProgress:true to also receive plan-step + command history with percentComplete.",
      inputSchema: {
        taskId: z.string(),
        includeProgress: z.boolean().optional(),
      },
    },
    async ({ taskId, includeProgress }) => {
      const query = includeProgress ? "?includeProgress=true" : "";
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${TASKS}/${taskId}${query}`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_report_bug",
    {
      description:
        "File a bug spawned from the current task. Creates a child bug-fix task assigned to developer.",
      inputSchema: {
        taskId: z.string().describe("The source task during which the bug was found"),
        bugTitle: z.string().min(1).max(200),
        bugDescription: z.string().min(1).max(4000),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        reproducible: z.boolean().optional(),
        stepsToReproduce: z.string().max(4000).optional(),
      },
    },
    async ({ taskId, ...body }) => {
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${TASKS}/${taskId}/report-bug`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_report_bug", { taskId, ...body }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_get_preview_path",
    {
      description:
        "Get the preview-slot info for a task: {previewUrl, previewPath, lastProbedAt}.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${TASKS}/${taskId}/preview-path`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_list_progress",
    {
      description:
        "List a task's plan steps + executed commands with percentComplete. Read-only.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${TASKS}/${taskId}/progress`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "task_clear_progress",
    {
      description:
        "Clear a task's plan-step + command history. CTO or PM role only.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const res = await client.request<ToolResult>({
        method: "DELETE",
        path: `${TASKS}/${taskId}/progress`,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_clear_progress", { taskId }),
      });
      return toMcpContent(res.data);
    }
  );
};
