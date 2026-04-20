import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { toMcpContent } from "../envelope.js";

const MEETINGS = "/api/internal/v1/meetings";

export const registerMeetingTools = (
  server: McpServer,
  _ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "meeting_record",
    {
      description: "Record a meeting with agenda, decisions, and learnings. CEO/PM/skills_lead only.",
      inputSchema: {
        type: z.enum(["daily_sync", "eval_triggered", "escalation"]),
        facilitatorRole: z.string().min(1).max(64),
        participantRoles: z.array(z.string()).min(1).max(16),
        summary: z.string().min(1).max(500),
        agenda: z.array(
          z.object({
            topic: z.string().min(1).max(200),
            type: z.enum(["update", "blocker", "question", "proposal"]),
            content: z.string().min(1).max(4000),
            raisedByRole: z.string().min(1).max(64),
            relatedTaskId: z.string().nullable().optional(),
            needsBoardApproval: z.boolean().optional(),
          })
        ).min(1).max(32),
        decisions: z.array(
          z.object({
            description: z.string().min(1).max(2000),
            decidedByRoles: z.array(z.string().min(1)).min(1),
            impactIds: z.array(z.string()).default([]),
          })
        ).optional(),
        learnings: z.array(
          z.object({
            role: z.string().min(1).max(64),
            content: z.string().min(1).max(2000),
            promotedToSummary: z.boolean().optional(),
          })
        ).optional(),
        taskModifications: z.array(
          z.object({
            taskId: z.string().min(1),
            modificationType: z.enum(["assign", "reprioritize", "reassign", "cancel", "decompose_further", "unblock"]),
            details: z.string().min(1).max(2000),
            assignedRole: z.string().nullable().optional(),
            priority: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
            resultingStatus: z.enum(["created", "planned", "in_progress", "verifying", "blocked", "completed", "failed", "cancelled"]).nullable().optional(),
          })
        ).optional(),
        memoryModifications: z.array(
          z.object({
            role: z.string().min(1).max(64),
            modificationType: z.enum(["current_focus", "recent_learning", "active_pattern", "open_blocker", "important_decision", "clear_blocker"]),
            content: z.string().min(1).max(2000),
          })
        ).optional(),
      },
    },
    async (args) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: MEETINGS,
        body: args,
        idempotencyKey: randomUUID(),
      });
      return toMcpContent(res.data);
    }
  );
};
