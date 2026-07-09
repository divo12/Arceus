/**
 * Vercel deploy configuration for company production sites.
 */
import { readOptionalEnv } from "./env";

export const vercelConfig = {
  /** Bearer token with deploy + domain permissions. */
  token: readOptionalEnv("ARCEUS_VERCEL_TOKEN", ""),
  /** Optional team id for team-scoped deploys. */
  teamId: readOptionalEnv("ARCEUS_VERCEL_TEAM_ID", ""),
  /**
   * Public origin of the Arceus API (Railway) that product sites rewrite
   * `/api/ai/*` to. Example: `https://api.arceus.sh`.
   */
  apiPublicOrigin: (
    readOptionalEnv("ARCEUS_API_PUBLIC_ORIGIN") ||
    readOptionalEnv("ARCEUS_PUBLIC_API_URL") ||
    ""
  ).replace(/\/+$/, ""),
};

export function vercelConfigured(): boolean {
  return vercelConfig.token.length > 0 && vercelConfig.apiPublicOrigin.length > 0;
}
