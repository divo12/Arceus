/**
 * @module ai.routes
 * AI Gateway — `POST /api/ai/complete`.
 *
 * Lets a company's product call the LLM without ever holding an API key.
 * The company is resolved SERVER-SIDE: from an authenticated JWT, or from
 * the preview subdomain the product is served on (`<slug>.arceus.sh`,
 * routed here by preview-proxy which lets `/api/ai/*` fall through). The
 * Azure key stays on the server; spend is metered + budget-capped per
 * company inside `aiCompleteForCompany`.
 */
import type { FastifyInstance } from "fastify";
import { aiCompleteForCompany, AiGatewayError } from "../ai-gateway/gateway.js";
import { previewSubdomainOf } from "./preview-proxy.js";
import { getPreviewTargetForSlug } from "../workspace/preview.js";

export default async function aiRoutes(app: FastifyInstance) {
  app.post("/api/ai/complete", async (request, reply) => {
    // Resolve the company server-side. Prefer an authenticated JWT; else
    // derive it from the preview subdomain. The product holds no secret.
    let companyId: string | null = request.companyId ?? null;
    if (!companyId) {
      const host = typeof request.headers.host === "string" ? request.headers.host : "";
      const slug = previewSubdomainOf(host);
      if (slug) companyId = getPreviewTargetForSlug(slug)?.companyId ?? null;
    }
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
