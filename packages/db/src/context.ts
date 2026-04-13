import { arceusTableDefinitions } from "./schema";
import { createNoopDatabaseAdapter } from "./client";
import type { DatabaseAdapter } from "./types";

export type DbContext = {
  adapter: DatabaseAdapter;
  schema: typeof arceusTableDefinitions;
};

export function createDbContext(adapter: DatabaseAdapter = createNoopDatabaseAdapter()): DbContext {
  return {
    adapter,
    schema: arceusTableDefinitions
  };
}