// Spec 34 v3 PR 12 — server.ts is the slim entry point.
// All boot logic lives in `./bootstrap/index.ts`.

// Prevent unhandled rejections/exceptions from killing the process.
process.on("unhandledRejection", (reason) => {
  console.error("[ARCEUS] Unhandled rejection (process kept alive):", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[ARCEUS] Uncaught exception (process kept alive):", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
});

import Fastify from "fastify";
import { startServer } from "./bootstrap/index.js";

/** Arceus API server — bootstraps Fastify, hydrates state, wires heartbeat/meeting engines, and registers all route plugins. */
const app = Fastify({
  logger: { level: "warn" },
  disableRequestLogging: true,
});

// Allow requests with Content-Type: application/json but empty body (e.g. DELETE from TUI)
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  if (!body || (typeof body === "string" && body.trim() === "")) {
    done(null, undefined);
    return;
  }
  try { done(null, JSON.parse(body as string)); } catch (err) { done(err as Error, undefined); }
});

await startServer(app);
