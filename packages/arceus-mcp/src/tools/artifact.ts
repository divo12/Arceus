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
        taskId: z.string().optional()
          .describe("DEPRECATED — use attachToTaskIds instead. Single task to link."),
        attachToTaskIds: z.array(z.string()).max(10).optional()
          .describe("Task IDs to attach this artifact to at creation"),
      },
    },
    async ({ kind, title, content, taskId, attachToTaskIds }) => {
      const body = { agent: ctx.role, kind, title, content, taskId, attachToTaskIds };
      const res = await client.request<ToolResult>({
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
      // `role` is NOT sent in the body — the route resolves it per-request
      // via req.mcp.role (x-role header → session-context). Putting
      // ctx.role here produced empty strings because the MCP server's
      // process env carries no per-beat role.
      const body = { taskId, slug };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${ARTIFACTS}/${artifactId}/workspace-writes`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "artifact_write_to_workspace", { artifactId, ...body }),
      });
      return toMcpContent(res.data);
    }
  );

  // `artifact_persist` retired (Spec 28 Phase C.1) — `artifact_create` now writes
  // through `addArtifactSync` so persistence is automatic. The route still
  // returns 410 Gone with `tool_retired` for ~2 weeks, then will be removed.
};
