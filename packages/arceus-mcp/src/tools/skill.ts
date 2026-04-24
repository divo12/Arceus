import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const SKILLS = "/api/internal/v1/skills";

export const registerSkillTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient,
): void => {
  // ── read-only ────────────────────────────────────────────
  server.registerTool(
    "skill_health_report",
    {
      description:
        "Aggregate per-skill EMA, invocation counts, failure rate, and recent rollback count " +
        "over a rolling window. Use to triage which skills need attention. Read-only.",
      inputSchema: {
        skillId: z.string().uuid().optional().describe("Limit to a single skill (default: all skills for the company)"),
        windowDays: z.number().int().min(1).max(90).default(7),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/health-report`,
        body: input,
      });
      return toMcpContent(res.data);
    },
  );

  server.registerTool(
    "skill_audit_unused",
    {
      description:
        "List active skills that have not been invoked in the lookback window. Use to find " +
        "candidates for deprecation. Read-only.",
      inputSchema: {
        staleDays: z.number().int().min(1).max(365).default(30),
        includeRoles: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/audit-unused`,
        body: input,
      });
      return toMcpContent(res.data);
    },
  );

  server.registerTool(
    "skill_inspect_history",
    {
      description:
        "List revisions for a skill — applied_by, summary, git tag, sha, rollback links — " +
        "cross-checked against the actual git tag list. Read-only.",
      inputSchema: {
        skillId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/inspect-history`,
        body: input,
      });
      return toMcpContent(res.data);
    },
  );

  server.registerTool(
    "skill_validate_definition",
    {
      description:
        "Parse and validate a SKILL.md body without writing. Returns frontmatter, errors, " +
        "warnings, and slug-collision info. No side effects.",
      inputSchema: {
        content: z.string().min(1).max(64 * 1024),
        intent: z.enum(["register", "update"]).default("register"),
        skillId: z.string().uuid().optional(),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/).optional(),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/validate-definition`,
        body: input,
      });
      return toMcpContent(res.data);
    },
  );

  // ── writes ───────────────────────────────────────────────
  server.registerTool(
    "skill_register",
    {
      description:
        "Register a new skill: writes SKILL.md, commits, tags, and inserts a revision row " +
        "atomically. Refuses if the slug already exists in this company.",
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
        name: z.string().min(1).max(80),
        role: z.string().min(1).max(40),
        description: z.string().min(1).max(500),
        triggerCondition: z.string().min(1).max(200),
        content: z.string().min(1).max(64 * 1024),
        summary: z.string().min(1).max(280).describe("Commit message and revisions.summary"),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/register`,
        body: input,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "skill_register", input),
      });
      return toMcpContent(res.data);
    },
  );

  server.registerTool(
    "skill_update",
    {
      description:
        "Write a new revision of an existing skill. Atomically updates SKILL.md, commits, " +
        "tags, and inserts a revision row. Refuses if the skill is missing or deprecated.",
      inputSchema: {
        skillId: z.string().uuid(),
        content: z.string().min(1).max(64 * 1024),
        summary: z.string().min(1).max(280),
        rollbackFromTag: z.string().max(200).optional()
          .describe("If this update is a rollback, the prior git tag we copied content from."),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/update`,
        body: input,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "skill_update", input),
      });
      return toMcpContent(res.data);
    },
  );

  server.registerTool(
    "skill_deprecate",
    {
      description:
        "Mark a skill as deprecated. Writes a deprecation tag + revision row but no SKILL.md change.",
      inputSchema: {
        skillId: z.string().uuid(),
        reason: z.string().min(1).max(500),
        summary: z.string().min(1).max(280),
      },
    },
    async (input) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${SKILLS}/deprecate`,
        body: input,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "skill_deprecate", input),
      });
      return toMcpContent(res.data);
    },
  );
};
