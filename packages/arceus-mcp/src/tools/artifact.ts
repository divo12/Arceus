import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const ARTIFACTS = "/api/internal/v1/artifacts";

export const registerArtifactTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "artifact_create",
    {
      description: "Create a new artifact (plan, code, report). Returns the artifact id.",
      inputSchema: {
        kind: z.enum(["plan", "code", "output", "specification"]),
        title: z.string().max(200),
        content: z.string(),
        taskId: z.string().optional(),
      },
    },
    async ({ kind, title, content, taskId }) => {
      const body = { agent: ctx.role, kind, title, content, taskId };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: ARTIFACTS,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "artifact_create", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "artifact_write_to_workspace",
    {
      description: "Write an artifact's content to the beat workspace. Returns the written path.",
      inputSchema: {
        artifactId: z.string(),
        taskId: z.string(),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/).max(120),
      },
    },
    async ({ artifactId, taskId, slug }) => {
      const body = { taskId, role: ctx.role, slug };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${ARTIFACTS}/${artifactId}/workspace-writes`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "artifact_write_to_workspace", { artifactId, ...body }),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "artifact_persist",
    {
      description: "Promote a runtime artifact to durable storage. Bandwidth cost. PM/skills_lead only.",
      inputSchema: {
        artifactId: z.string(),
        sprintId: z.string().nullable().optional(),
        taskId: z.string().nullable().optional(),
      },
    },
    async ({ artifactId, sprintId, taskId }) => {
      const body = { sprintId, taskId };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${ARTIFACTS}/${artifactId}/persistence`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "artifact_persist", { artifactId, ...body }),
      });
      return toMcpContent(res.data);
    }
  );
};
