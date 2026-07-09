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
   * Multi-tenant port range. Each company gets its own port from
   * [portMin, portMax] inclusive so two users running their products
   * don't fight over a single host port. Allocation is keyed on
   * companyId in preview.ts and stable for the process lifetime, so
   * the proxy can route `<slug>.<domain>` to the right local port
   * consistently. If only one tenant ever runs (single-host dev),
   * the range still works — the first company picks one slot and
   * stays there. Production deployments with more than ~90 concurrent
   * tenants should widen the range.
   */
  portMin: readNumberEnv("ARCEUS_PREVIEW_PORT_MIN", 3210),
  portMax: readNumberEnv("ARCEUS_PREVIEW_PORT_MAX", 3299),

  /**
   * Public apex domain for product URLs. The preview-proxy hook routes
   * `<name>-<company_hash>.<publicDomain>` (and legacy forms) to the local
   * preview/static server. URL construction builds
   * `https://<name>-<hash>.arceus.sh` (single DNS label — Railway wildcards
   * cannot match nested `*.*.domain`). Empty string disables the proxy.
   */
  publicDomain: readOptionalEnv("ARCEUS_PREVIEW_PUBLIC_DOMAIN", ""),

  /**
   * Optional fixed base URL for preview links — overrides the
   * per-company host pattern. Useful for a single shared preview host.
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