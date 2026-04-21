const requireEnv = (key: string): string => {
  const raw = process.env[key];
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
};

const optionalEnv = (key: string): string =>
  process.env[key] ?? "";

export interface McpContext {
  /** Per-beat — set by env or resolved via session-context at runtime. */
  beatId: string;
  companyId: string;
  role: string;
  /** Always required — set in opencode.json MCP env block. */
  arceusApiBase: string;
  arceusToken: string;
}

/**
 * Load context from environment.
 *
 * ARCEUS_API and ARCEUS_TOKEN are always required (set at boot via
 * writeSharedOpencodeConfig). BEAT_ID, COMPANY_ID, ROLE are optional —
 * when absent the http-client resolves them per-request via the
 * session-context API (Phase 6.5).
 */
export const loadMcpContext = (): McpContext => ({
  beatId: optionalEnv("BEAT_ID"),
  companyId: optionalEnv("COMPANY_ID"),
  role: optionalEnv("ROLE"),
  arceusApiBase: requireEnv("ARCEUS_API"),
  arceusToken: optionalEnv("ARCEUS_TOKEN") || "arceus-dev-token",
});
