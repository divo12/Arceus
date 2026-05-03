/**
 * pgvector backend — factory.
 * Spec 34 v3 PR 7.
 */
import { isDatabaseConfigured } from "@arceus/db";
import { PgVectorStaticStore } from "./static-store.js";
import { PgVectorDynamicStore } from "./dynamic-store.js";
import { PgVectorProceduralStore } from "./procedural-store.js";
import { PgVectorPrimingStore } from "./priming-store.js";

/**
 * Factory: create pgvector-backed stores for all four tiers.
 * Returns null if DATABASE_URL is not configured, allowing callers
 * to fall back to in-memory stores.
 */
export function createPgVectorStores() {
  if (!isDatabaseConfigured()) {
    return null;
  }

  return {
    staticStore: new PgVectorStaticStore(),
    dynamicStore: new PgVectorDynamicStore(),
    proceduralStore: new PgVectorProceduralStore(),
    primingStore: new PgVectorPrimingStore(),
  };
}
