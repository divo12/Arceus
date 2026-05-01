/**
 * Environment variable helpers.
 * Loads `.env.local` from the repo root and exposes typed readers.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoEnvPath = resolve(currentDir, "../../../../.env.local");

loadEnv({ path: repoEnvPath, override: true });

/** Read a required environment variable, throwing if missing. */
export function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Read an optional environment variable with a fallback. */
export function readOptionalEnv(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

/** Read an optional env var, checking a list of alias names before falling back. */
export function readAliasedOptionalEnv(name: string, aliases: string[], fallback = "") {
  const names = [name, ...aliases];

  for (const candidate of names) {
    const value = process.env[candidate]?.trim();
    if (value) {
      return value;
    }
  }

  return fallback;
}

/** Read a numeric environment variable with a fallback default. */
export function readNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read a comma-separated list environment variable with a fallback. */
export function readListEnv(name: string, fallback: string[]) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [...fallback];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}