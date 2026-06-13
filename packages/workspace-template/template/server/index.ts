/**
 * Server tier — the product's backend, built with Hono. Runs ONLY on the
 * server (mounted into Vite in dev via @hono/vite-dev-server). This is where
 * you:
 *   - define your HTTP API under `/api/*`
 *   - read/write the database (server/db.ts)
 *   - use SERVER-ONLY secrets via `process.env` (they never reach the browser
 *     bundle — Arceus injects per-company secrets into the server process)
 *
 * The React app (src/) calls these routes with `fetch("/api/...")` — see
 * src/lib/api.ts for the typed client.
 */
import { Hono } from "hono";
import { listNotes, createNote, deleteNote } from "./db";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

// Example resource — a notes table persisted in SQLite. Replace with your
// product's real data model + endpoints.
app.get("/api/notes", (c) => c.json(listNotes()));

app.post("/api/notes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  return c.json(createNote(text), 201);
});

app.delete("/api/notes/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  deleteNote(id);
  return c.json({ ok: true });
});

export default app;
