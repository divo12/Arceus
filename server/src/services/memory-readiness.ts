import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryPrimingState } from "@paperclipai/db";
import { getHippocampusBridge } from "./hippocampus-bridge.js";
import { getRedisClient } from "./redis.js";

type ReadinessResult = { ready: boolean; reason?: string };

export function memoryReadinessService(db: Db) {
  async function checkDataPlaneReady(): Promise<ReadinessResult> {
    try {
      await db.select({ count: sql<number>`count(*)` }).from(memoryPrimingState);
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `Memory tables not accessible: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function checkIntelligenceEngineReady(): Promise<ReadinessResult> {
    try {
      const bridge = getHippocampusBridge();
      await bridge.health();
      return { ready: true };
    } catch {
      return { ready: false, reason: "Python runtime unavailable" };
    }
  }

  async function checkCacheReady(): Promise<ReadinessResult> {
    try {
      const redis = getRedisClient();
      await redis.ping();
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `Redis unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function getMemoryHealth() {
    const [dataPlane, intelligence, cache] = await Promise.all([
      checkDataPlaneReady(),
      checkIntelligenceEngineReady(),
      checkCacheReady(),
    ]);
    const allReady = dataPlane.ready && cache.ready;
    return {
      status: allReady ? (intelligence.ready ? "healthy" : "degraded") : "down",
      dataPlane,
      intelligence,
      cache,
    } as const;
  }

  return {
    checkDataPlaneReady,
    checkIntelligenceEngineReady,
    checkCacheReady,
    getMemoryHealth,
  };
}
