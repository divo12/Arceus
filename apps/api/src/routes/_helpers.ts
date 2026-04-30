/**
 * Shared route helpers — currently small and focused; grow with care.
 *
 * Audit C13 (F-434, F-432 partial): centralized number-from-querystring
 * parsing replaces a scatter of `Number(query.X)` / `parseInt(query.X, 10)`
 * calls that silently produced `NaN` from non-numeric input. `NaN`
 * propagated through `Math.min(NaN, 500) = NaN` and ended up in LIMIT
 * clauses where Postgres rejected it (heartbeat history) or treated it
 * as "no limit" (inspector, governance).
 *
 * The helpers below return `undefined` on any invalid input so callers
 * can treat "missing" and "garbage" identically — both fall back to the
 * caller's default. No exceptions are thrown; querystring values are
 * caller-controlled but not security-critical.
 */

/**
 * Hard upper bound applied by `parseListLimit`. Matches the cap proposed
 * for the broader F-432 list-route migration.
 */
export const HARD_LIST_CAP = 500;

/**
 * Parse an optional non-negative integer from a querystring value.
 *
 * Returns `undefined` for: missing, empty string, non-numeric, fractional,
 * or out-of-range values. The caller decides whether `undefined` means
 * "use default" or "no filter".
 *
 * @param raw    The raw query value (Fastify gives us `unknown`).
 * @param opts   Optional clamps. `min` defaults to 0 (allows zero seqs).
 *               `max` defaults to `Number.MAX_SAFE_INTEGER`.
 */
export function parseOptionalInt(
  raw: unknown,
  opts?: { min?: number; max?: number },
): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  const min = opts?.min ?? 0;
  const max = opts?.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min || n > max) return undefined;
  return n;
}

/**
 * Parse a list-route `limit` query parameter, clamping to `HARD_LIST_CAP`
 * and falling back to a caller-supplied default on missing/invalid input.
 *
 * Always returns a finite positive integer suitable for a SQL LIMIT clause.
 *
 * Audit C13 (F-434) + C10 (F-432 carve-out).
 */
export function parseListLimit(
  raw: unknown,
  opts?: { default?: number },
): number {
  const n = parseOptionalInt(raw, { min: 1, max: HARD_LIST_CAP });
  return n ?? opts?.default ?? 100;
}
