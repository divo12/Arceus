import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { toMcpContent } from "../envelope.js";

const BEATS = "/api/internal/v1/beats";

export const registerBeatTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient,
): void => {
  server.registerTool(
    "beat_read_last_progress",
    {
      description:
        "Read progress notes from this role's last N beats — summaries, outcomes, " +
        "and timing. Use to understand what you accomplished recently before deciding " +
        "what to work on next. Read-only.",
      inputSchema: {
        n: z.number().int().min(1).max(10).default(3).describe("Number of recent beats to return (1–10, default 3)"),
      },
    },
    async ({ n }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: `${BEATS}/recent?n=${n}`,
      });
      return toMcpContent(res.data);
    },
  );
};
