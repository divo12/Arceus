import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const COMPANY = "/api/internal/v1/company";
const AGENTS = "/api/internal/v1/agents";
const BOARD = "/api/internal/v1/board";

export const registerCompanyTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "company_get_summary",
    {
      description:
        "Read company-level state: name, goal, status, active sprint summary, budget, and agent count. " +
        "Use at beat start for situational awareness.",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${COMPANY}/summary`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "agents_list_sessions",
    {
      description:
        "List all agents and their current session status (idle, active, running). " +
        "Use to check who else is working before opening a meeting or assigning a task.",
      inputSchema: {},
    },
    async () => {
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${AGENTS}/sessions`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "company_set_status",
    {
      description:
        "Update the company-wide status (ideation, active, paused, archived). CEO only.",
      inputSchema: {
        status: z.enum(["ideation", "active", "paused", "archived"]),
      },
    },
    async ({ status }) => {
      const body = { status };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${COMPANY}/status`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "company_set_status", body),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "board_get_messages",
    {
      description:
        "Read paginated board chat history. Filter by since-timestamp, since-sprint, or card type.",
      inputSchema: {
        since: z.string().optional().describe("ISO timestamp; only messages at or after this time"),
        sinceSprint: z.string().optional().describe("Sprint ID; messages from when that sprint started"),
        cardType: z.string().optional().describe("Filter by chat card type"),
        limit: z.number().int().min(1).max(100).optional().describe("Max messages to return (default 20)"),
      },
    },
    async ({ since, sinceSprint, cardType, limit }) => {
      const qs = new URLSearchParams();
      if (since) qs.set("since", since);
      if (sinceSprint) qs.set("sinceSprint", sinceSprint);
      if (cardType) qs.set("cardType", cardType);
      if (limit !== undefined) qs.set("limit", String(limit));
      const suffix = qs.toString();
      const res = await client.request<ToolResult>({
        method: "GET",
        path: `${BOARD}/messages${suffix ? `?${suffix}` : ""}`,
      });
      return toMcpContent(res.data);
    }
  );
};
