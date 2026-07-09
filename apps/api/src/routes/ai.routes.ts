/**
 * @module ai.routes
 * AI Gateway — `POST /api/ai/complete`.
 *
 * Lets a company's product call the LLM without ever holding an API key.
 * The company is resolved SERVER-SIDE from JWT, Host, or Origin/Referer
 * (Vercel rewrites `/api/ai/*` to Railway — Host becomes the API apex,
 * so Origin carries `<name>-<hash>.arceus.sh`). Azure key stays server-side;
 * spend is metered + budget-capped per company.
 */
import type { FastifyInstance } from "fastify";
import { aiCompleteForCompany, AiGatewayError } from "../ai-gateway/gateway.js";
import { resolveAiGatewayCompanyId } from "../ai-gateway/resolve-company.js";

export default async function aiRoutes(app: FastifyInstance) {
  app.post("/api/ai/complete", async (request, reply) => {
    const companyId = await resolveAiGatewayCompanyId({
      jwtCompanyId: request.companyId ?? null,
      hostHeader: typeof request.headers.host === "string" ? request.headers.host : null,
      originHeader: typeof request.headers.origin === "string" ? request.headers.origin : null,
      refererHeader: typeof request.headers.referer === "string" ? request.headers.referer : null,
    });
    if (!companyId) {
      reply.code(401);
      return {
        error: "no_company",
        message: "AI gateway requests must come from a company product (its arceus.sh subdomain) or an authenticated session.",
      };
    }

    try {
      return await aiCompleteForCompany(companyId, request.body);
    } catch (err) {
      if (err instanceof AiGatewayError) {
        reply.code(err.status);
        return { error: err.code, message: err.message };
      }
      request.log?.error?.(err);
      reply.code(502);
      return { error: "upstream_error", message: "The AI service is temporarily unavailable." };
    }
  });
}
