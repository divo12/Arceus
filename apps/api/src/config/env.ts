import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoEnvPath = resolve(currentDir, "../../../../.env.local");

loadEnv({ path: repoEnvPath, override: true });

export function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readOptionalEnv(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

export function readNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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