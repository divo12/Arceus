/**
 * Embedding model identity.
 *
 * Written verbatim into `memory_embeddings.model_version` on every
 * insert so a future model rollout (e.g. swap to `text-embedding-3`)
 * can key off the version string without changing the column type.
 *
 * The default matches the runtime embedder loaded by
 * `packages/hippocampus/src/backends/embedding.ts` — `all-MiniLM-L6-v2`
 * at 384 dimensions. The `@384` suffix is the dimension contract
 * documented in spec 31 §3.
 */
export const EMBEDDING_MODEL_VERSION = "all-MiniLM-L6-v2@384";
