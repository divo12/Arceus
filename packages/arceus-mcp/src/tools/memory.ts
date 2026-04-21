import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { toMcpContent } from "../envelope.js";

const MEMORY = "/api/internal/v1/memory";

export const registerMemoryTools = (
  server: McpServer,
  _ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "memory_handoff",
    {
      description:
        "Pass context to another role's next beat. Use when your work produces information " +
        "that a downstream role needs (e.g. developer → tester after completing a feature). " +
        "The context is written into the target role's memory so they see it when they wake up.",
      inputSchema: {
        targets: z.array(z.string()).min(1).max(4).describe("Target role(s) to receive the handoff"),
        context: z.string().max(4000).describe("The information to hand off (what you did, where files are, what to verify)"),
      },
    },
    async ({ targets, context }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${MEMORY}/handoff`,
        body: { targets, context },
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );
};
