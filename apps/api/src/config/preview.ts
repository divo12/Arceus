/**
 * Local preview server configuration.
 * Host, port, probe intervals, timeouts, and workspace-scanning settings.
 */
import { readListEnv, readNumberEnv, readOptionalEnv } from "./env";

const defaultIgnoredDirectories = ["node_modules", ".git", ".next", "dist", "build", "coverage"];

export const previewConfig = {
  host: readOptionalEnv("ARCEUS_PREVIEW_HOST", "127.0.0.1"),
  publicHost: readOptionalEnv("ARCEUS_PREVIEW_PUBLIC_HOST", "127.0.0.1"),
  port: readNumberEnv("ARCEUS_PREVIEW_PORT", 3210),

  /**
   * Public apex domain for preview URLs. The preview-proxy hook routes
   * any `<slug>.<publicDomain>` host (excluding reserved subdomains
   * like `app`, `api`, `www`, `admin`) to the local preview server.
   * URL construction in `preview.ts` builds
   * `https://<companySlug>.<publicDomain>` so each company gets its
   * own vanity subdomain. Empty string disables the proxy entirely.
   */
  publicDomain: readOptionalEnv("ARCEUS_PREVIEW_PUBLIC_DOMAIN", ""),

  /**
   * Optional fixed base URL for preview links — overrides the
   * per-company-slug pattern. Useful when you want a single
   * `https://preview.arceus.sh` URL instead of `<slug>.arceus.sh`.
   * If both this and publicDomain are set, publicBaseUrl wins.
   */
  publicBaseUrl: readOptionalEnv("ARCEUS_PREVIEW_PUBLIC_BASE_URL", ""),
  probeIntervalMs: readNumberEnv("ARCEUS_PREVIEW_PROBE_INTERVAL_MS", 1000),
  launchTimeoutMs: readNumberEnv("ARCEUS_PREVIEW_LAUNCH_TIMEOUT_MS", 45000),
  reportedCandidateTimeoutMs: readNumberEnv("ARCEUS_PREVIEW_REPORTED_TIMEOUT_MS", 5000),
  maxWorkspaceDepth: readNumberEnv("ARCEUS_PREVIEW_MAX_WORKSPACE_DEPTH", 4),
  exactPathPreferenceScore: readNumberEnv("ARCEUS_PREVIEW_EXACT_PATH_SCORE", 1000),
  relatedPathPreferenceScore: readNumberEnv("ARCEUS_PREVIEW_RELATED_PATH_SCORE", 500),
  ignoredDirectories: readListEnv("ARCEUS_PREVIEW_IGNORED_DIRECTORIES", defaultIgnoredDirectories),

  /**
   * Timeout for `npm/pnpm install` invoked from `scaffold.ts` (initial
   * workspace bootstrap) and `preview.ts` (lazy install during launch).
   * Both sites share this so a single env var changes both.
   */
  installTimeoutMs: readNumberEnv("ARCEUS_PREVIEW_INSTALL_TIMEOUT_MS", 120_000),
};