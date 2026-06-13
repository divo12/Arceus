/**
 * Per-tenant persistence — real SQLite via Node's built-in `node:sqlite`
 * (no native module to compile, no external service). The database file
 * lives at `data/app.db` in the workspace and survives restarts. This file
 * runs ONLY on the server (imported by the Hono app), never in the browser.
 *
 * Design your data model here: add `CREATE TABLE` statements to `migrate()`
 * and export typed query helpers. Keep ALL SQL in this module so the rest of
 * the server just calls functions.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
migrate();

export interface Note {
  id: number;
  text: string;
  created_at: string;
}

export function listNotes(): Note[] {
  return db.prepare("SELECT id, text, created_at FROM notes ORDER BY id DESC").all() as unknown as Note[];
}

export function createNote(text: string): Note {
  const created_at = new Date().toISOString();
  const result = db.prepare("INSERT INTO notes (text, created_at) VALUES (?, ?)").run(text, created_at);
  return { id: Number(result.lastInsertRowid), text, created_at };
}

export function deleteNote(id: number): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}
