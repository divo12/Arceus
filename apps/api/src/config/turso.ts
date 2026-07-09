/**
 * Turso Platform API credentials for per-company product databases.
 */
import { readOptionalEnv } from "./env";

export const tursoConfig = {
  /** Platform API token (org-scoped). */
  token: readOptionalEnv("ARCEUS_TURSO_TOKEN", ""),
  /** Organization slug (from Turso dashboard). */
  org: readOptionalEnv("ARCEUS_TURSO_ORG", ""),
  /** Group that new DBs are created in (must already exist). */
  group: readOptionalEnv("ARCEUS_TURSO_GROUP", "default"),
};

export function tursoConfigured(): boolean {
  return tursoConfig.token.length > 0 && tursoConfig.org.length > 0;
}
