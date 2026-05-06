import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./context.js";
import { ArceusHttpClient } from "./http-client.js";
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
