/**
 * Shared utility helpers: argument sanitization, telemetry truncation,
 * and preview URL extraction.
 */
import { uniqueStrings } from "@arceus/task-engine";

/** Sanitize tool arguments for audit logging — scrub potential secrets. */
export function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const SECRET_KEYS = /key|secret|token|password|auth|credential|api.?key/i;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_KEYS.test(k)) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "string" && v.length > 500) {
      result[k] = v.slice(0, 500) + `…[${v.length} chars]`;
    } else {
      result[k] = v;
    }
  }
  return result;
}

/** Collapse whitespace and truncate a telemetry string to `limit` characters. */
export function truncateTelemetry(value: string | null | undefined, limit = 220) {
  if (!value) return null;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

/** Extract localhost/127.0.0.1 preview URLs from free-form text. */
export function extractPreviewUrls(text: string) {
  return uniqueStrings(
    Array.from(text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+(?:\/[^\s"'`)]*)?/gi)).map((match) => match[0]),
    4,
  );
}
