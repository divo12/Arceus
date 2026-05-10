import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpContext } from "./context.js";
import { ArceusHttpClient } from "./http-client.js";
import { sessionAls } from "./session-als.js";
import { registerTaskTools } from "./tools/task.js";
import { registerArtifactTools } from "./tools/artifact.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerMeetingTools } from "./tools/meeting.js";
import { registerApprovalTools } from "./tools/approval.js";
import { registerSprintTools } from "./tools/sprint.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerBeatTools } from "./tools/beat.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerSkillTools } from "./tools/skill.js";
import { registerChatTools } from "./tools/chat.js";
import { registerStrategyTools } from "./tools/strategy.js";

export const createArceusMcpServer = (ctx: McpContext): McpServer => {
  const server = new McpServer({ name: "arceus-mcp", version: "0.1.0" });
  const client = new ArceusHttpClient(ctx);

  // Per-call sessionID propagation. The OpenCode plugin's
  // `tool.execute.before` hook injects `_sessionId` into args for every
  // `arceus_*` tool. We extend each tool's input schema to accept it,
  // strip it before the original handler runs, and stash it in
  // AsyncLocalStorage so http-client.request() can resolve beat
  // context per-call without per-role server registration.
  const originalRegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    cb: Parameters<typeof server.registerTool>[2],
  ) => {
    const augmented = {
      ...config,
      inputSchema: {
        ...(config.inputSchema ?? {}),
        _sessionId: z.string().optional(),
      },
    };
    const wrapped = (async (args: Record<string, unknown>, extra: unknown) => {
      const sessionId = typeof args?._sessionId === "string" ? args._sessionId : undefined;
      // Strip before the real handler sees it — handlers destructure
      // their own keys and shouldn't observe this synthetic field.
      if (args && typeof args === "object") {
        delete args._sessionId;
      }
      const handler = cb as (a: unknown, e: unknown) => unknown;
      if (sessionId) {
        return await sessionAls.run({ sessionId }, () => handler(args, extra));
      }
      return await handler(args, extra);
    }) as typeof cb;
    return originalRegisterTool(name, augmented, wrapped);
  });

  registerTaskTools(server, ctx, client);
  registerArtifactTools(server, ctx, client);
  registerWorkspaceTools(server, ctx, client);
  registerMeetingTools(server, ctx, client);
  registerApprovalTools(server, ctx, client);
  registerSprintTools(server, ctx, client);
  registerMemoryTools(server, ctx, client);
  registerBeatTools(server, ctx, client);
  registerCompanyTools(server, ctx, client);
  registerExecutionTools(server, ctx, client);
  registerSkillTools(server, ctx, client);
  registerChatTools(server, ctx, client);
  registerStrategyTools(server, ctx, client);
  registerMetaTools(server, ctx, client);

  return server;
};
