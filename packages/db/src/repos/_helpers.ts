/**
 * Shared helpers for the repo layer (spec 31 Phase 2).
 *
 * Every repo function takes `db: DbClient` as the first argument so callers
 * can pass a transaction-scoped client when they need atomicity. Module-level
 * state is forbidden — repos are pure functions over drizzle queries.
 */
import { getDb, type DbClient } from "../client.js";

export type { DbClient };

/** Default client accessor for callers that don't need transaction control. */
export const db = (): DbClient => getDb();
