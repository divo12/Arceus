import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const MEMORY = "/api/internal/v1/memory";

const ROLE_ENUM = [
  "ceo",
  "cto",
  "pm",
  "developer",
  "tester",
  "ui_designer",
  "marketing",
  "skills_lead",
] as const;

export const registerMemoryTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  // ─── memory_search ─────────────────────────────────────────────────
  server.registerTool(
    "memory_search",
    {
      description:
        "Semantic search over your role's memory. Use when you need to recall a specific " +
        "fact you or a collaborator previously recorded — not for general context (that " +
        "arrives pre-injected each beat). Returns top-K memory hits ranked by MMR relevance. " +
        "scope='self' (default) searches only your own memory; scope='company' additionally " +
        "returns memories explicitly handed off to you via memory_handoff. Zero LLM in the " +
        "retrieval path.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Natural-language query; embedded and ranked over role memory."),
        scope: z
          .enum(["self", "company"])
          .optional()
          .describe("'self' (default, private) or 'company' (self + received handoffs)."),
        kind: z
          .enum(["static", "dynamic", "any"])
          .optional()
          .describe("Filter by memory kind. 'any' (default) returns both static and dynamic."),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Max results (1-20, default 5)."),
        since: z
          .string()
          .datetime()
          .optional()
          .describe("ISO-8601 timestamp; only return memories recorded after this."),
      },
    },
    async (args) => {
      const body = args;
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${MEMORY}/search`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "memory_search", body),
      });
      return toMcpContent(res.data);
    }
  );

  // ─── memory_add_learning ───────────────────────────────────────────
  server.registerTool(
    "memory_add_learning",
    {
      description:
        "Explicitly record a fact, pattern, or insight worth remembering. Use for important " +
        "or surprising findings where the automatic extractor might miss it (auto-extraction " +
        "from task output runs post-beat). The action-decider dedupes: returns action=ADD for " +
        "new entries, UPDATE if it merges with an existing memory, NONE if semantically " +
        "duplicate. Prefer concise, self-contained wording (10-2000 chars).",
      inputSchema: {
        content: z
          .string()
          .min(10)
          .max(2000)
          .describe("The fact, pattern, or insight to remember, in prose."),
        kind: z
          .enum(["static", "dynamic", "procedural"])
          .optional()
          .describe("Tier: static (durable), dynamic (expiring, default), procedural (habit)."),
        tags: z
          .array(z.string().min(1).max(64))
          .max(5)
          .optional()
          .describe("Free-form tags for filtering (max 5)."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Your confidence in this fact, 0-1 (default 0.8)."),
        expiryDays: z
          .number()
          .int()
          .positive()
          .max(365)
          .optional()
          .describe("TTL in days; only honored for kind='dynamic'."),
        sourceTaskId: z
          .string()
          .optional()
          .describe("Task this learning emerged from; for traceability."),
      },
    },
    async (args) => {
      const body = args;
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${MEMORY}/learnings`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "memory_add_learning", body),
      });
      return toMcpContent(res.data);
    }
  );

  // ─── memory_handoff ────────────────────────────────────────────────
  server.registerTool(
    "memory_handoff",
    {
      description:
        "Route a typed fact to another role's memory so they see it on their next beat. " +
        "Use when your work produces information a downstream role needs to act on (e.g. " +
        "developer → tester after completing a feature; qa → cto after finding a blocker). " +
        "kind categorizes the handoff (finding/decision/blocker_warning/context_transfer). " +
        "urgency=high surfaces as a banner in the target's prompt. Creates a handoff artifact " +
        "for audit. Self-handoff rejected. Payload capped at ~10 KB.",
      inputSchema: {
        targets: z
          .array(z.enum(ROLE_ENUM))
          .min(1)
          .max(3)
          .describe("Target role(s) to route to (1-3). Cannot include your own role."),
        kind: z
          .enum(["finding", "decision", "blocker_warning", "context_transfer"])
          .describe(
            "finding = I discovered X; decision = I decided X; " +
              "blocker_warning = I'm blocked on X; context_transfer = general context.",
          ),
        content: z
          .string()
          .min(20)
          .max(5000)
          .describe("Handoff content. Make it self-contained; target should act without re-asking."),
        relatedArtifactIds: z
          .array(z.string())
          .max(5)
          .optional()
          .describe("Artifact IDs evidencing this handoff (plans, findings, probes)."),
        urgency: z
          .enum(["low", "normal", "high"])
          .optional()
          .describe("Priority hint. 'high' renders as a banner in target's next beat (default: normal)."),
      },
    },
    async (args) => {
      const body = args;
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${MEMORY}/handoff`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "memory_handoff", body),
      });
      return toMcpContent(res.data);
    }
  );
};
