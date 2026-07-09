/**
 * Per-tenant persistence — SQLite dialect in both environments:
 *
 *   Local / preview:  Node built-in `node:sqlite` → file at `data/app.db`
 *   Production (Vercel): Turso / libSQL when `TURSO_DATABASE_URL` is set
 *
 * Keep ALL SQL in this module. Helpers are async so both drivers share one API.
 * This file runs ONLY on the server (imported by the Hono app), never in the browser.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Note {
  id: number;
  text: string;
  created_at: string;
}

type SqlArgs = (string | number | null | bigint)[];

interface DbDriver {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, args?: SqlArgs): Promise<T[]>;
  run(
    sql: string,
    args?: SqlArgs,
  ): Promise<{ lastInsertRowid: number; changes: number }>;
}

function tursoConfigured(): boolean {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  return Boolean(url && (url.startsWith("libsql://") || url.startsWith("https://")));
}

async function createTursoDriver(): Promise<DbDriver> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return {
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    async all<T>(sql, args = []) {
      const result = await client.execute({ sql, args });
      return result.rows;
    },
    async run(sql, args = []) {
      const result = await client.execute({ sql, args });
      return {
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        changes: result.rowsAffected,
      };
    },
  };
}

async function createLocalDriver(): Promise<DbDriver> {
  const { DatabaseSync } = await import("node:sqlite");
  // Preview/local: workspace data/. On Vercel without Turso (misconfig),
  // fall back to /tmp so the function can at least start.
  const dataDir = process.env.VERCEL
    ? join("/tmp", "arceus-data")
    : join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "app.db"));
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async all<T>(sql, args = []) {
      return db.prepare(sql).all(...args) as unknown as T[];
    },
    async run(sql, args = []) {
      const result = db.prepare(sql).run(...args);
      return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    },
  };
}

let driverPromise: Promise<DbDriver> | null = null;

function getDriver(): Promise<DbDriver> {
  if (!driverPromise) {
    driverPromise = tursoConfigured() ? createTursoDriver() : createLocalDriver();
  }
  return driverPromise;
}

async function migrate(): Promise<void> {
  const db = await getDriver();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

let migrated = false;
async function ensureMigrated(): Promise<DbDriver> {
  const db = await getDriver();
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  return db;
}

export async function listNotes(): Promise<Note[]> {
  const db = await ensureMigrated();
  return db.all<Note>("SELECT id, text, created_at FROM notes ORDER BY id DESC");
}

export async function createNote(text: string): Promise<Note> {
  const db = await ensureMigrated();
  const created_at = new Date().toISOString();
  const result = await db.run("INSERT INTO notes (text, created_at) VALUES (?, ?)", [
    text,
    created_at,
  ]);
  return { id: result.lastInsertRowid, text, created_at };
}

export async function deleteNote(id: number): Promise<void> {
  const db = await ensureMigrated();
  await db.run("DELETE FROM notes WHERE id = ?", [id]);
}
