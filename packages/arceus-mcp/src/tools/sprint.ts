import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { toMcpContent } from "../envelope.js";

const SPRINTS = "/api/internal/v1/sprints";

export const registerSprintTools = (
  server: McpServer,
  _ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "sprint_propose",
    {
      description: "Trigger a CEO sprint proposal (LLM call, ~$0.05). CEO role only.",
      inputSchema: { rationale: z.string().max(2000).optional() },
    },
    async ({ rationale }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SPRINTS}/proposals`,
        body: rationale ? { rationale } : {},
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );
};
