/**
 * Audit subsystem configuration.
 * Reads from environment variables with JSON-file defaults.
 */
import { readOptionalEnv, readNumberEnv } from "./env";
import defaultsRaw from "./audit.json" with { type: "json" };

interface AuditDefaults {
  memoryBufferSize: number;
  dbFlushIntervalMs: number;
  dbFlushBatchSize: number;
  dbEnabled: boolean;
  sseKeepAliveMs: number;
  logViewerEnabled: boolean;
  logViewerMaxEvents: number;
  severityFilter: "debug" | "info" | "warn" | "error";
  categories: string[];
}
const defaults = defaultsRaw as AuditDefaults;

export const auditConfig = {
  /** Max events to keep in the in-memory ring buffer. */
  memoryBufferSize: readNumberEnv("ARCEUS_AUDIT_MEMORY_BUFFER_SIZE", defaults.memoryBufferSize),

  /** How often (ms) to flush buffered events to Postgres. 0 = disabled. */
  dbFlushIntervalMs: readNumberEnv("ARCEUS_AUDIT_DB_FLUSH_INTERVAL_MS", defaults.dbFlushIntervalMs),

  /** Max events per DB insert batch. */
  dbFlushBatchSize: readNumberEnv("ARCEUS_AUDIT_DB_FLUSH_BATCH_SIZE", defaults.dbFlushBatchSize),

  /** Whether to persist events to Postgres at all. Falls back to memory-only if DB is down. */
  dbEnabled: readOptionalEnv("ARCEUS_AUDIT_DB_ENABLED", String(defaults.dbEnabled)) === "true",

  /** SSE keep-alive ping interval (ms). */
  sseKeepAliveMs: readNumberEnv("ARCEUS_AUDIT_SSE_KEEPALIVE_MS", defaults.sseKeepAliveMs),

  /** Serve the /logs viewer UI. */
  logViewerEnabled: readOptionalEnv("ARCEUS_AUDIT_LOG_VIEWER_ENABLED", String(defaults.logViewerEnabled)) === "true",

  /** Max events the /logs viewer requests on initial load. */
  logViewerMaxEvents: readNumberEnv("ARCEUS_AUDIT_LOG_VIEWER_MAX_EVENTS", defaults.logViewerMaxEvents),

  /** Minimum severity to record. Events below this are dropped. */
  severityFilter: readOptionalEnv("ARCEUS_AUDIT_SEVERITY_FILTER", defaults.severityFilter) as "debug" | "info" | "warn" | "error",

  /** Which categories to record. Empty = all. */
  categories: defaults.categories,
};
