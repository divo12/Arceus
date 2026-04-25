import type { FastifyInstance } from "fastify";
import {
  mcpAuth,
  mcpRequestContext,
  mcpRateLimitHeaders,
  mcpIdempotencyReplay,
  mcpEmitToolInvoked,
  mcpEmitToolResult,
  mcpCapturePayloadCause,
} from "./middleware.js";
import internalMcpTasksRoutes from "./tasks.routes.js";
import internalMcpArtifactsRoutes from "./artifacts.routes.js";
import internalMcpWorkspacesRoutes from "./workspaces.routes.js";
import internalMcpMeetingsRoutes from "./meetings.routes.js";
import internalMcpApprovalsRoutes from "./approvals.routes.js";
import internalMcpSprintsRoutes from "./sprints.routes.js";
import internalMcpMemoryRoutes from "./memory.routes.js";
import internalMcpBeatsRoutes from "./beats.routes.js";
import internalMcpCompanyRoutes from "./company.routes.js";
import internalMcpExecutionRoutes from "./execution.routes.js";
import internalMcpSkillsRoutes from "./skills.routes.js";

export default async function internalMcpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/internal/v1/")) return;
    await mcpAuth(req, reply);
    if (reply.sent) return;
    await mcpRequestContext(req, reply);
    if (reply.sent) return;
    await mcpRateLimitHeaders(req, reply);
    if (reply.sent) return;
    await mcpIdempotencyReplay(req, reply);
    if (reply.sent) return;
    // Spec 32 — emit tool.invoked once we know the tool + ctx are valid.
    await mcpEmitToolInvoked(req, reply);
  });

  app.addHook("onResponse", async (req, reply) => {
    if (!req.url.startsWith("/api/internal/v1/")) return;
    await mcpEmitToolResult(req, reply);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.url.startsWith("/api/internal/v1/")) return payload;
    return mcpCapturePayloadCause(req, reply, payload);
  });

  await app.register(internalMcpTasksRoutes);
  await app.register(internalMcpArtifactsRoutes);
  await app.register(internalMcpWorkspacesRoutes);
  await app.register(internalMcpMeetingsRoutes);
  await app.register(internalMcpApprovalsRoutes);
  await app.register(internalMcpSprintsRoutes);
  await app.register(internalMcpMemoryRoutes);
  await app.register(internalMcpBeatsRoutes);
  await app.register(internalMcpCompanyRoutes);
  await app.register(internalMcpExecutionRoutes);
  await app.register(internalMcpSkillsRoutes);
}
