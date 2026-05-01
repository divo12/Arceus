/**
 * pgvector backend barrel — Spec 34 v3 PR 7.
 *
 * The original 629-LoC `pgvector.ts` is decomposed into:
 *
 *   ./canonical-codec.ts   row ↔ domain converters + extractUuid
 *   ./embedding.ts         upsertEmbedding / setMemoryEmbedding /
 *                          logEmbedFailure
 *   ./base-store.ts        BasePgVectorMemoryStore<"static" | "dynamic">
 *                          shared list / add / update / softDelete
 *   ./static-store.ts      PgVectorStaticStore (raw similarity search)
 *   ./dynamic-store.ts     PgVectorDynamicStore (decayed search + gc)
 *   ./procedural-store.ts  PgVectorProceduralStore (habits, separate shape)
 *   ./priming-store.ts     PgVectorPrimingStore (priming_states upsert)
 *   ./factory.ts           createPgVectorStores
 *
 * The shared base eliminates the 4× CRUD duplication flagged by the
 * audit (F-409 cluster) — Static + Dynamic now share ~60 LoC instead
 * of duplicating it twice.
 */
export { PgVectorStaticStore } from "./static-store.js";
export { PgVectorDynamicStore } from "./dynamic-store.js";
export { PgVectorProceduralStore } from "./procedural-store.js";
export { PgVectorPrimingStore } from "./priming-store.js";
export { createPgVectorStores } from "./factory.js";
export { setMemoryEmbedding } from "./embedding.js";
