/**
 * Admin auth — Audit C4 (security: governance off + no auth).
 *
 * Gates the public `/api/*` HTTP surface against unauthenticated
 * mutations. Closes the audit's primary attack vector:
 *
 *   curl -X DELETE https://arceus.example.com/api/company
 *
 * ## Token resolution
 *
 * Looked up at boot, cached for the process lifetime:
 *   1. `ARCEUS_ADMIN_TOKEN` — admin surface only
 *   2. `ARCEUS_TOKEN` — legacy single-token deployments
 *   3. `arceus-dev-token` — non-production fallback (warns once)
 *
 * Production with no token AND auth required → fail-loud at boot.
 *
 * ## Enforcement gating
 *
 * Three modes, controlled by `ARCEUS_REQUIRE_AUTH` env:
 *   - "1" / "true" → always enforce (any environment)
 *   - "0" / "false" → never enforce (escape hatch for prod
 *     deployments still using the legacy unauthenticated web client;
 *     intentional opt-out, must be explicit)
 *   - unset → default to NODE_ENV === "production"
 *
 * Default secure-by-default: production deployments that don't set
 * the var get auth on; dev deployments don't.
 *
 * ## What's gated
 *
 * The `requireAdminAuth` preHandler only fires when:
 *   - the request method is mutating (POST/PUT/PATCH/DELETE)
 *   - the path is under `/api/*`
 *   - the path is NOT under `/api/internal/*` (those have their own
 *     `resolveBearerToken` middleware)
 *   - the path is NOT in `READ_ONLY_ALLOWLIST` (e.g. `/api/health`,
 *     SSE handshakes that need POST for body but are read-only)
 *
 * GET / HEAD / OPTIONS pass through untouched — they read state but
 * don't mutate it. The CORS allow-list (`ARCEUS_ALLOWED_ORIGINS`) is
 * the second layer that prevents browser-origin reads.
 *
 * ## Debug routes
 *
 * `isDebugPath()` returns true for the audit-cited prod-leak surfaces
 * (`/api/debug/*`, `/api/hippocampus/seed`, etc.). Server.ts uses it
 * to short-circuit the registration in production AND to gate the
 * remaining dev-mode mounts behind `requireAdminAuth`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

let resolvedAdminToken: string | null = null;
let warnedDev = false;

function resolveAdminToken(): string {
  if (resolvedAdminToken) return resolvedAdminToken;

  const token = process.env.ARCEUS_ADMIN_TOKEN ?? process.env.ARCEUS_TOKEN;

  if (token && token.length >= 16) {
    resolvedAdminToken = token;
    return resolvedAdminToken;
  }

  const inProduction = process.env.NODE_ENV === "production";
  if (inProduction && isAuthRequired()) {
    throw new Error(
      "ARCEUS_ADMIN_TOKEN (or ARCEUS_TOKEN) must be set in production (≥16 chars) " +
      "when ARCEUS_REQUIRE_AUTH is enabled. To opt out explicitly, set ARCEUS_REQUIRE_AUTH=0.",
    );
  }

  if (!warnedDev) {
    console.warn(
      "[auth] Using development default ARCEUS_ADMIN_TOKEN. " +
      "Set ARCEUS_ADMIN_TOKEN (≥16 chars) in production.",
    );
    warnedDev = true;
  }
  resolvedAdminToken = "arceus-dev-token";
  return resolvedAdminToken;
}

/**
 * Returns true if the global admin gate should enforce. Read every
 * request — the env can flip without a restart in some deployment
 * scenarios, and tests benefit from the per-call lookup.
 */
function isAuthRequired(): boolean {
  const flag = process.env.ARCEUS_REQUIRE_AUTH;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths that legitimately accept POST without admin auth. Add sparingly —
 * each entry is an attack surface.
 */
const PUBLIC_MUTATION_ALLOWLIST = new Set<string>([
  "/api/auth/register",
  "/api/auth/login",
]);

/**
 * Audit C4 (F-428) — debug/seed/simulate/check routes that the audit
 * flagged as "mounted unconditionally in prod". `isDebugPath` is the
 * single source of truth for which paths get the debug treatment:
 *   - skipped at registration time when NODE_ENV === "production"
 *   - gated behind admin token in non-production
 */
const DEBUG_PATH_PREFIXES = [
  "/api/debug/",
  "/api/execution-flow",
  "/api/hippocampus/seed",
  "/api/hippocampus/test-extraction",
  "/api/skills/simulate-task-outcome",
  "/api/governance/check",
] as const;

export function isDebugPath(url: string): boolean {
  // Strip query string before matching
  const path = url.split("?")[0] ?? url;
  return DEBUG_PATH_PREFIXES.some((p) => path === p || path.startsWith(p));
}

export function shouldDisableDebugRoutes(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Fastify preHandler. Use as a global hook to gate the public `/api/*`
 * mutating surface. Skips GET/HEAD/OPTIONS, internal-MCP routes, and
 * the explicit allowlist. Returns 401 with no body on miss — error
 * messages are deliberately terse so a probing attacker doesn't learn
 * which paths exist.
 */
export async function requireAdminAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isAuthRequired()) return;

  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) return;

  const path = req.url.split("?")[0] ?? req.url;
  if (!path.startsWith("/api/")) return;
  // Internal MCP routes have their own auth (apps/api/src/routes/internal-mcp/middleware.ts)
  if (path.startsWith("/api/internal/")) return;
  if (PUBLIC_MUTATION_ALLOWLIST.has(path)) return;

  // Authenticated users (valid user JWT decoded by userJwtPlugin) bypass the
  // admin token gate — they're already verified. Admin token is only required
  // for unauthenticated backend callers (scripts, curl, etc.).
  if (req.userId) return;

  const auth = req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice(7)
    : null;

  if (!token || token !== resolveAdminToken()) {
    await reply
      .code(401)
      .header("www-authenticate", "Bearer realm=\"arceus-admin\"")
      .send({ error: "unauthorized" });
  }
}
