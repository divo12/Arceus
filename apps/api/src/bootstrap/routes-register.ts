/**
 * Bootstrap — CORS, preHandlers, and route plugin registration.
 * Audit C4 / Spec 34 v3 PR 12.
 */
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";
import { isDebugPath, requireAdminAuth, shouldDisableDebugRoutes } from "../auth/admin.js";
import { userJwtPlugin } from "../auth/user-jwt-middleware.js";
import {
  agentsRoutes,
  aiRoutes,
  artifactsRoutes,
  auditRoutes,
  authRoutes,
  chatRoutes,
  companyRoutes,
  controlPlaneRoutes,
  debugRoutes,
  governanceRoutes,
  healthRoutes,
  heartbeatRoutes,
  hippocampusRoutes,
  inspectorRoutes,
  internalEventsRoutes,
  internalMcpRoutes,
  internalTelemetryRoutes,
  meetingsRoutes,
  orchestratorRoutes,
  previewRoutes,
  skillsRoutes,
  sprintsRoutes,
  strategyRoutes,
  tasksRoutes,
  workspaceRoutes,
} from "../routes/index.js";

interface RouteRuntime {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export async function registerCors(app: FastifyInstance): Promise<void> {
  // Audit C4 (F-450): replace `origin: true` (echoes any origin) with an
  // explicit allow-list driven by ARCEUS_ALLOWED_ORIGINS. Without an
  // allow-list, browsers from arbitrary origins can read SSE streams /
  // agent activity even when the API itself is behind admin auth.
  const allowedOriginsRaw = process.env.ARCEUS_ALLOWED_ORIGINS
    ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:4000,http://localhost:5273");
  const allowedOrigins = allowedOriginsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Product sites on Vercel (`https://<name>.<hash>.arceus.sh`) call the
  // AI gateway on Railway. Allow any https origin under the preview apex
  // in addition to the explicit allow-list.
  const productApex = (process.env.ARCEUS_PREVIEW_PUBLIC_DOMAIN ?? "")
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\/+$/, "");

  await app.register(cors, {
    origin: (origin, cb) => {
      // No origin (curl, server-to-server, native Node clients) — allow.
      // The admin auth gate is the second layer that catches mutations
      // from these clients.
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        cb(null, true);
        return;
      }
      if (productApex) {
        try {
          const u = new URL(origin);
          if (u.protocol === "https:" && (u.hostname === productApex || u.hostname.endsWith(`.${productApex}`))) {
            cb(null, true);
            return;
          }
        } catch {
          // fall through
        }
      }
      cb(new Error(`CORS: origin '${origin}' not in ARCEUS_ALLOWED_ORIGINS`), false);
    },
    credentials: true,
  });
}

export function registerSecurityHooks(app: FastifyInstance): void {
  // Audit C4 (F-428): in production, debug/seed/simulate/check paths
  // 404 unconditionally. Path-level filter (not plugin-level) so other
  // non-debug routes in the same file (e.g. read-only /api/hippocampus/
  // context, the rest of /api/governance/*) keep working in prod.
  app.addHook("preHandler", async (req, reply) => {
    if (shouldDisableDebugRoutes() && isDebugPath(req.url)) {
      await reply.code(404).send();
    }
  });

  // Audit C4 (F-424): global preHandler that requires admin bearer token
  // on every mutating /api/* route. Internal MCP routes have their own
  // auth and are excluded by the helper. Dev mode (NODE_ENV !== "production")
  // is no-op unless ARCEUS_REQUIRE_AUTH=1 forces it on.
  app.addHook("preHandler", requireAdminAuth);
}

export async function registerRoutes(app: FastifyInstance, runtime: RouteRuntime): Promise<void> {
  const routeDeps = runtime;

  // Decode JWT from Authorization header and decorate req.userId / req.companyId.
  // Must run before any route plugin so the decoration is available everywhere.
  await app.register(userJwtPlugin);

  await app.register(authRoutes);
  await app.register(healthRoutes);
  await app.register(companyRoutes, routeDeps);
  await app.register(strategyRoutes, routeDeps);
  await app.register(chatRoutes);
  await app.register(tasksRoutes);
  await app.register(sprintsRoutes);
  await app.register(meetingsRoutes);
  await app.register(agentsRoutes);
  await app.register(heartbeatRoutes, routeDeps);
  await app.register(orchestratorRoutes, routeDeps);
  await app.register(governanceRoutes);
  await app.register(controlPlaneRoutes);
  await app.register(auditRoutes);
  await app.register(workspaceRoutes);
  await app.register(previewRoutes);
  await app.register(artifactsRoutes);
  await app.register(aiRoutes);

  // Audit C4 (F-428): debugRoutes is a pure debug plugin — entirely
  // dev-only. Other plugins (hippocampus, governance, skills) contain a
  // MIX of read-only and debug endpoints; those are filtered path-by-path
  // by the `isDebugPath` preHandler above so the non-debug routes keep
  // working in prod.
  if (!shouldDisableDebugRoutes()) {
    await app.register(debugRoutes);
  } else {
    console.log("[ARCEUS] Skipping pure-debug routes in production (NODE_ENV=production)");
  }
  await app.register(hippocampusRoutes);
  await app.register(inspectorRoutes);
  await app.register(skillsRoutes);
  await app.register(internalMcpRoutes);
  await app.register(internalTelemetryRoutes);
  await app.register(internalEventsRoutes);
}
