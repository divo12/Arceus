/**
 * Fastify plugin: decorate every request with userId + companyId from JWT.
 * Null when token is absent or invalid — does NOT reject (use requireUserAuth
 * as a preHandler on routes that demand authentication).
 *
 * Wrapped with fastify-plugin so the onRequest hook and decorations escape
 * the plugin's child scope and apply to ALL sibling route plugins.
 */
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyJwt } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    companyId: string | null;
  }
}

function extractToken(req: FastifyRequest): string | null {
  // 1. Authorization: Bearer <token>  (API calls with fetchWithAuth)
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  // 2. arceus_session cookie  (EventSource with withCredentials)
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === "arceus_session" && v) return decodeURIComponent(v);
    }
  }
  // 3. ?token= query param  (EventSource which can't set headers or cookies cross-origin)
  const rawUrl = req.url;
  if (rawUrl?.includes("token=")) {
    const qs = rawUrl.split("?")[1] ?? "";
    for (const pair of qs.split("&")) {
      const [k, v] = pair.split("=");
      if (k === "token" && v) return decodeURIComponent(v);
    }
  }
  return null;
}

async function _userJwtPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("userId", null);
  app.decorateRequest("companyId", null);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const token = extractToken(req);
    if (!token) return;
    try {
      const payload = await verifyJwt(token);
      req.userId = payload.userId;
      req.companyId = payload.companyId;
    } catch {
      // Invalid / expired token — leave as null; requireUserAuth will reject if needed.
    }
  });
}

export const userJwtPlugin = fp(_userJwtPlugin, { name: "arceus-user-jwt" });

export async function requireUserAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.userId) {
    console.warn("[requireUserAuth] 401 — no userId. hasToken=%s cookie=%s", req.url?.includes("token="), req.headers.cookie ? "present" : "absent");
    await reply
      .code(401)
      .header("www-authenticate", "Bearer realm=\"arceus\"")
      .send({ error: "unauthorized" });
  }
}
