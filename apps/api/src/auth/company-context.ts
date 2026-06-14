/**
 * Native-multi-tenant request-company primitives (Phase 2).
 *
 * Arceus is multi-tenant: every company-scoped operation must resolve its
 * tenant from the request's own JWT, never from a process-global "current
 * company" pointer (the old `getActiveCompanyId()/requireActiveCompanyId()`
 * fallback, which silently resolved the WRONG company whenever it was stale —
 * the recurring multi-tenant bug class this phase removes).
 *
 *   - `requireUserAndCompany` — preHandler. Rejects 401 (no authenticated user)
 *     or 400 (authenticated but no company in the JWT). Use in place of
 *     `requireUserAuth` on routes that operate on a specific company.
 *   - `companyIdOf` — reads the request's companyId as a non-null string.
 *     Defensive: throws if absent, which can only happen if the route forgot
 *     the preHandler. There is intentionally NO global fallback.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireUserAuth } from "./user-jwt-middleware.js";

/** The subset of FastifyRequest these helpers read — keeps them unit-testable. */
interface RequestIdentity {
  userId: string | null;
  companyId: string | null;
}

/**
 * Resolve the request's companyId as a guaranteed non-null string. Pair with
 * the `requireUserAndCompany` preHandler, which guarantees it at runtime; the
 * throw is a defensive backstop for a missing preHandler, never a normal path.
 */
export function companyIdOf(req: RequestIdentity): string {
  if (!req.companyId) {
    throw new Error(
      "companyIdOf: no company in request context. Add the requireUserAndCompany preHandler to this route — Arceus is multi-tenant and has no global current-company fallback.",
    );
  }
  return req.companyId;
}

/**
 * preHandler: require an authenticated user AND a company in the JWT. Composes
 * `requireUserAuth` (401 on no user) then adds a 400 when the user has no
 * company in session. Once this runs, `companyIdOf(req)` is safe.
 */
export async function requireUserAndCompany(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUserAuth(req, reply);
  if (reply.sent) return; // 401 already sent by requireUserAuth
  if (!req.companyId) {
    await reply.code(400).send({ error: "no_company_in_session" });
  }
}
