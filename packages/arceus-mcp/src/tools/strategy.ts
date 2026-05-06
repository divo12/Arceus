import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const STRATEGY = "/api/internal/v1/strategy";

// Must stay in lockstep with strategyRoleSchema in apps/api/src/agents/ceo.ts.
// Tightening this from z.string() to z.enum prevents the LLM from drifting on
// role names (casing, made-up roles like "engineer") — the OpenCode SDK rejects
// pre-flight with a clear "must be one of [...]" rather than the API rejecting
// after HTTP with the same enum check.
const ROLE_KEYS = [
  "ceo",
  "cto",
  "pm",
  "developer",
  "tester",
  "ui_designer",
  "marketing",
  "skills_lead",
] as const;

const strategyRoleSchema = z.object({
  role: z.enum(ROLE_KEYS).describe("Role key — must be exactly one of the 8 supported roles (lowercase, snake_case)"),
  title: z.string().min(1).describe("Human-readable job title"),
  parent_role: z.enum(ROLE_KEYS).nullable().describe(
    "Direct manager role (null only for ceo). Allowed reporting lines: ceo→{cto, marketing}; cto→{pm, developer, tester, ui_designer, skills_lead}; pm→{developer, tester, ui_designer}.",
  ),
  capabilities: z.array(z.string()).describe("What this role can do"),
});

export const registerStrategyTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "strategy_apply",
    {
      description:
        "Provision the company org chart by applying a board-approved strategy. " +
        "Creates agents, hierarchy, and memories in a single atomic transaction. " +
        "Call this AFTER the board approves a hiring_slate card. " +
        "Missing mandatory roles (tester, skills_lead) are auto-injected. " +
        "CEO role only.",
      inputSchema: {
        strategy_title: z.string().min(1).describe("Short title for this strategy"),
        summary: z.string().min(1).describe("One-paragraph strategy summary"),
        first_release: z.string().min(1).describe("What the first release delivers"),
        scope_boundary: z.array(z.string()).min(1).describe("What is explicitly out of scope"),
        role_rationale: z.array(z.string()).describe("Why each role is needed"),
        roles: z.array(strategyRoleSchema).min(4).max(8).describe("Team roles to provision"),
      },
    },
    async ({ strategy_title, summary, first_release, scope_boundary, role_rationale, roles }) => {
      const body = { strategy_title, summary, first_release, scope_boundary, role_rationale, roles };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: `${STRATEGY}/apply`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "strategy_apply", body),
      });
      return toMcpContent(res.data);
    }
  );
};
