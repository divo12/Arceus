/**
 * Surface the real Postgres error code/detail hidden under Drizzle's generic
 * "Failed query:" wrapper. Without this, logs drop SQLSTATE (e.g. 42P01 /
 * "relation does not exist", 23502 / "not_null_violation") and we can only
 * see the SQL text, which makes cross-layer debugging guesswork.
 *
 * Kept in its own file to avoid circular imports — any module that does DB
 * work (orchestrator, artifact-persistence, workspace-manager, …) can pull
 * this in without dragging orchestrator.ts with it.
 */
export function describePgError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err ?? "Unknown error");
  if (!err || typeof err !== "object") return base;
  const anyErr = err as { code?: string; detail?: string; hint?: string; cause?: unknown };
  const parts: string[] = [];
  if (anyErr.code) parts.push(`[${anyErr.code}]`);
  if (anyErr.detail) parts.push(`detail="${anyErr.detail}"`);
  if (anyErr.hint) parts.push(`hint="${anyErr.hint}"`);
  if (anyErr.cause && typeof anyErr.cause === "object") {
    const cause = anyErr.cause as { code?: string; message?: string };
    if (cause.code && cause.code !== anyErr.code) parts.push(`causeCode=[${cause.code}]`);
    if (cause.message && cause.message !== base) parts.push(`cause="${cause.message}"`);
  }
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}
