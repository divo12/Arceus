/**
 * @module db/context
 * Dependency-injection context that bundles a DatabaseAdapter with table definitions.
 */
import { arceusTableDefinitions } from "./schema";
import { createNoopDatabaseAdapter } from "./client";
import type { DatabaseAdapter } from "./types";

/** Bundles a DatabaseAdapter with the schema for dependency injection. */
export type DbContext = {
  adapter: DatabaseAdapter;
  schema: typeof arceusTableDefinitions;
};

/** Creates a DbContext, defaulting to the in-memory NoopDatabaseAdapter. */
export function createDbContext(adapter: DatabaseAdapter = createNoopDatabaseAdapter()): DbContext {
  return {
    adapter,
    schema: arceusTableDefinitions
  };
}