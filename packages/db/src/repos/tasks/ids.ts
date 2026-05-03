/**
 * Tasks repo — id-boundary helpers and shared row types.
 * Spec 34 v3 PR 6.
 *
 * The application layer uses prefixed friendly IDs (`tsk_xxx`, `co_xxx`,
 * `beat_xxx`, etc.) but the DB schema columns are uuid. Rather than widen
 * every PK + FK column to text (~75 columns across 25 tables), the repo
 * converts at its boundary:
 *
 *   write: friendly  → toDbId() → uuidv5 deterministic uuid → DB column
 *   read:  uuid      → restored from body.friendlyIds       → friendly
 *
 * uuidv5 is deterministic, so a round-trip "tsk_abc" → uuid → "tsk_abc"
 * always lands on the same uuid. Looking up by friendly id never needs a
 * reverse lookup — we hash the friendly to compute the uuid and query
 * directly. Friendly strings are also stashed in `body.friendlyIds` so
 * hydration can return them verbatim instead of leaking uuid format
 * to API consumers.
 */
import { tasks } from "../../schema/tasks.js";
import { friendlyToUuid } from "../_uuid.js";

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStatus = Task["status"];

/** Map a friendly id (`tsk_abc`) to a deterministic uuid; valid uuids pass through.
 *  Single source of truth lives in `_uuid.ts` — DO NOT change the namespace
 *  after data exists, would invalidate every PK derived from a friendly string. */
export const toDbId = friendlyToUuid;

/** Restore the friendly id from body if it was stashed; otherwise fall back to the uuid. */
export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}
