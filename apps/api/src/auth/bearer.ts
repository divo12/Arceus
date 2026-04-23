/**
 * Transport-token resolution — spec 25 §3.5.
 *
 * Fail-loud in production when no token is set.
 * Fall back to "arceus-dev-token" in development with a warning.
 */

let resolved: string | null = null;

/** @internal — reset cached token for tests */
export function __resetBearerToken(): void { resolved = null; }

export function resolveBearerToken(): string {
  if (resolved) return resolved;

  const token = process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN;

  if (token && token.length >= 16) {
    resolved = token;
    return resolved;
  }

  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[auth] Using development default ARCEUS_TOKEN. Set ARCEUS_TOKEN (≥16 chars) before deploying."
    );
    resolved = "arceus-dev-token";
    return resolved;
  }

  throw new Error(
    "ARCEUS_TOKEN (or ARCEUS_INTERNAL_TOKEN) must be set in production (≥16 chars). " +
    "Refusing to start with a known-public default."
  );
}
