/**
 * Provision a Turso database per company for product persistence on Vercel.
 *
 * Credentials are written to `<productDir>/.arceus/turso.json` (gitignored)
 * and injected into the Vercel project env at deploy time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tursoConfig, tursoConfigured } from "../config/turso.js";
import { companyHash } from "./site-url.js";

const TURSO_API = "https://api.turso.tech";

export interface TursoCredentials {
  databaseName: string;
  databaseUrl: string;
  authToken: string;
}

function credsPath(productDir: string): string {
  return join(productDir, ".arceus", "turso.json");
}

export function readTursoCredentials(productDir: string): TursoCredentials | null {
  const path = credsPath(productDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TursoCredentials>;
    if (raw.databaseName && raw.databaseUrl && raw.authToken) {
      return {
        databaseName: raw.databaseName,
        databaseUrl: raw.databaseUrl,
        authToken: raw.authToken,
      };
    }
  } catch {
    // ignore corrupt file
  }
  return null;
}

function writeTursoCredentials(productDir: string, creds: TursoCredentials): void {
  const dir = join(productDir, ".arceus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(credsPath(productDir), JSON.stringify(creds, null, 2), "utf8");
}

function dbNameForCompany(companyId: string): string {
  // Turso: lowercase letters, numbers, dashes; max 64.
  return `arceus-${companyHash(companyId)}`.slice(0, 64);
}

async function tursoFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tursoConfig.token}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${TURSO_API}${path}`, {
    method: init.method,
    headers,
    body: init.body,
  });
  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text.slice(0, 500) };
    }
  }
  return { status: res.status, json };
}

async function ensureDatabase(name: string): Promise<{ hostname: string; name: string }> {
  const org = encodeURIComponent(tursoConfig.org);
  const create = await tursoFetch(`/v1/organizations/${org}/databases`, {
    method: "POST",
    body: JSON.stringify({ name, group: tursoConfig.group }),
  });

  if (create.status === 200 || create.status === 201) {
    const db = (create.json as { database?: { Hostname?: string; Name?: string } })?.database;
    if (db?.Hostname && db?.Name) return { hostname: db.Hostname, name: db.Name };
  }

  // Already exists — retrieve.
  if (create.status === 409) {
    const get = await tursoFetch(`/v1/organizations/${org}/databases/${encodeURIComponent(name)}`);
    const db = (get.json as { database?: { Hostname?: string; Name?: string } })?.database;
    if (get.status === 200 && db?.Hostname && db?.Name) {
      return { hostname: db.Hostname, name: db.Name };
    }
  }

  throw new Error(
    `Turso create database "${name}" failed HTTP ${create.status}: ${JSON.stringify(create.json).slice(0, 300)}`,
  );
}

async function createAuthToken(databaseName: string): Promise<string> {
  const org = encodeURIComponent(tursoConfig.org);
  const db = encodeURIComponent(databaseName);
  const res = await tursoFetch(
    `/v1/organizations/${org}/databases/${db}/auth/tokens?expiration=never&authorization=full-access`,
    { method: "POST" },
  );
  const jwt = (res.json as { jwt?: string })?.jwt;
  if (res.status !== 200 || !jwt) {
    throw new Error(
      `Turso create token failed HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`,
    );
  }
  return jwt;
}

/**
 * Ensure the company has a Turso DB + auth token. Idempotent when
 * `.arceus/turso.json` already exists.
 */
export async function ensureCompanyTursoDb(args: {
  companyId: string;
  productDir: string;
}): Promise<{ ok: true; creds: TursoCredentials } | { ok: false; error: string }> {
  if (!tursoConfigured()) {
    return {
      ok: false,
      error: "Set ARCEUS_TURSO_TOKEN + ARCEUS_TURSO_ORG to provision product databases.",
    };
  }

  const existing = readTursoCredentials(args.productDir);
  if (existing) return { ok: true, creds: existing };

  try {
    const name = dbNameForCompany(args.companyId);
    const db = await ensureDatabase(name);
    const authToken = await createAuthToken(db.name);
    const creds: TursoCredentials = {
      databaseName: db.name,
      databaseUrl: `libsql://${db.hostname}`,
      authToken,
    };
    writeTursoCredentials(args.productDir, creds);
    return { ok: true, creds };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
