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
  probeIntervalMs: readNumberEnv("ARCEUS_PREVIEW_PROBE_INTERVAL_MS", 1000),
  launchTimeoutMs: readNumberEnv("ARCEUS_PREVIEW_LAUNCH_TIMEOUT_MS", 45000),
  reportedCandidateTimeoutMs: readNumberEnv("ARCEUS_PREVIEW_REPORTED_TIMEOUT_MS", 5000),
  maxWorkspaceDepth: readNumberEnv("ARCEUS_PREVIEW_MAX_WORKSPACE_DEPTH", 4),
  exactPathPreferenceScore: readNumberEnv("ARCEUS_PREVIEW_EXACT_PATH_SCORE", 1000),
  relatedPathPreferenceScore: readNumberEnv("ARCEUS_PREVIEW_RELATED_PATH_SCORE", 500),
  ignoredDirectories: readListEnv("ARCEUS_PREVIEW_IGNORED_DIRECTORIES", defaultIgnoredDirectories),
};