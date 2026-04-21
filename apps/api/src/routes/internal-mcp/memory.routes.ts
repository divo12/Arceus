import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { enrichRoleMemory } from "../../memory/operations.js";
import { emitEmployeeActivity } from "../../observability/activity.js";
import type { AgentIdentity } from "@arceus/contracts";
import { success, failure } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const MEMORY_BASE = "/api/internal/v1/memory";

const handoffBody = z.object({
  targets: z.array(z.string()).min(1).max(4),
  context: z.string().min(1).max(4000),
});

const sendValidation = (reply: FastifyReply, err: ZodError): void => {
  reply.code(422).send(
    failure("Request validation failed.", "validation", "never", "payload_fixed")
  );
};

export default async function internalMcpMemoryRoutes(app: FastifyInstance): Promise<void> {
  // POST /memory/handoff — agent passes context to target roles
  app.post(`${MEMORY_BASE}/handoff`, async (req, reply) => {
    const parsed = handoffBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidation(reply, parsed.error);
      return;
    }
    const { targets, context } = parsed.data;
    const mcp = req.mcp!;
    const sourceRole = mcp.role ?? "unknown";

    const delivered: string[] = [];
    for (const target of targets) {
      enrichRoleMemory(target as AgentIdentity["role"], {
        currentFocus: [`Handoff from ${sourceRole}: ${context}`],
        recentLearnings: [`Handoff from ${sourceRole}: ${context}`],
      });
      delivered.push(target);
    }

    emitEmployeeActivity(
      sourceRole as AgentIdentity["role"],
      "info",
      `Memory handoff → ${delivered.join(", ")}: ${context.slice(0, 120)}${context.length > 120 ? "…" : ""}`,
    );

    const body = success(
      `Handoff delivered to ${delivered.length} role(s).`,
      { sourceRole, targets: delivered },
    );
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    reply.code(200).send(body);
  });
}
