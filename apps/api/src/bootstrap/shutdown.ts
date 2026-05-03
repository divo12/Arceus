/**
 * Bootstrap — graceful shutdown.
 * Spec 34 v3 PR 12.
 */
import type { FastifyInstance } from "fastify";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";
import { stopStrandedRunSweeper } from "../orchestration/stranded-run-sweeper.js";
import { stopSkillScheduler } from "../skills/scheduler.js";
import { teardown } from "../persistence/mutations/index.js";
import { resetOpencodeConnection } from "../infra/opencode.js";

interface ShutdownDeps {
  app: FastifyInstance;
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export function registerShutdownHandlers(deps: ShutdownDeps): void {
  const handler = (signal: string) => { void shutdown(signal, deps); };
  process.on("SIGTERM", () => { handler("SIGTERM"); });
  process.on("SIGINT", () => { handler("SIGINT"); });
}

async function shutdown(signal: string, { app, heartbeatEngine, meetingScheduler }: ShutdownDeps): Promise<void> {
  console.log(`[ARCEUS] ${signal} received — shutting down gracefully…`);
  try {
    heartbeatEngine.stop();
    meetingScheduler.stop();
    stopStrandedRunSweeper();
    await stopSkillScheduler();
    await teardown();
    await app.close();
    // Kill the spawned OpenCode child so it releases port 4096. Without
    // this, container restart-in-place finds the port held by a zombie
    // process and falls back to a random port — operationally fine but
    // breaks "boot exactly once" expectations and pollutes logs.
    await resetOpencodeConnection();
    console.log("[ARCEUS] Server closed cleanly.");
    process.exit(0);
  } catch (err) {
    console.error("[ARCEUS] Error during shutdown:", err);
    process.exit(1);
  }
}
