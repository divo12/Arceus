---
name: developer-fullstack-data
description: How to add data persistence + HTTP APIs in the full-stack scaffold — SQLite dialect via server/db.ts (local file or Turso), /api routes via server/index.ts (Hono) + api/index.ts (Vercel), and the typed client in src/lib/api.ts. Load when a task needs data that persists (across reloads/users/devices), a backend endpoint, or server-side logic/secrets. The scaffold is full-stack: never use localStorage for real data and never scaffold a separate backend.
role: developer
trigger: task involves saving/loading data, "persist", accounts, lists that survive refresh, multi-user/shared state, an API, a webhook, or any server-side secret/logic — before reaching for localStorage or a new backend.
---

# Full-stack data + APIs

The scaffold has a real backend already. **Frontend = `src/` (browser). Backend = `server/` (Node).** One `npm run dev` runs both on one port: `/api/*` → the Hono server, everything else → the React app. Production ships the same Hono app via `api/index.ts` on Vercel.

## The three files

**`server/db.ts` — persistence (SQLite dialect).**
- Local / preview: Node `node:sqlite` → `data/app.db`
- Production (Vercel): Turso / libSQL when `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) is set — Arceus provisions the DB and injects env vars. Do not assume a durable local file on Vercel.

Helpers are **async**. Define your data model in `migrate()` and export typed helpers:
```ts
async function migrate() {
  const db = await getDriver(); // keep the existing dual-driver setup
  await db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );`);
}
export async function listTasks(): Promise<Task[]> {
  const db = await ensureMigrated();
  return db.all<Task>("SELECT * FROM tasks ORDER BY id DESC");
}
export async function addTask(title: string): Promise<Task> {
  const db = await ensureMigrated();
  const created_at = new Date().toISOString();
  const r = await db.run("INSERT INTO tasks (title, created_at) VALUES (?, ?)", [title, created_at]);
  return { id: r.lastInsertRowid, title, done: 0, created_at };
}
```
Always use parameterized queries (`?`), never string-concatenate SQL. Keep the dual-driver pattern — do not delete Turso support or hardcode only `node:sqlite`.

**`server/index.ts` — HTTP API (Hono).** One route per operation, under `/api/*`:
```ts
app.get("/api/tasks", async (c) => c.json(await listTasks()));
app.post("/api/tasks", async (c) => {
  const { title } = await c.req.json().catch(() => ({}));
  if (typeof title !== "string" || !title.trim()) return c.json({ error: "title required" }, 400);
  return c.json(await addTask(title.trim()), 201);
});
```
Validate input at the boundary; return JSON + a correct status code. Await async db helpers.

**`api/index.ts` — Vercel entry.** Do not remove. It mounts the same Hono app for production. Locally Vite uses `@hono/vite-dev-server` instead.

**`src/lib/api.ts` — typed client.** Mirror each route so components never hand-roll fetch:
```ts
export const api = {
  listTasks: () => fetch("/api/tasks").then(json<Task[]>),
  addTask: (title: string) =>
    fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }) }).then(json<Task>),
};
```
Components: `import { api } from "@/lib/api"` and call it from async handlers / effects.

## Rules

- **Real data → `server/db.ts`, NOT localStorage.** localStorage is per-browser and lost on another device; the spec almost always means real persistence.
- **Secrets + privileged logic live in `server/`.** `process.env` is readable there and never ships to the browser. Arceus injects per-company secrets (`TURSO_*`, `ARCEUS_COMPANY_ID`) into the server env. NEVER read a secret in `src/` client code.
- **Don't add a second backend** (Express/Next/a DB server) — extend `server/`. Turso is already the production database for this scaffold.
- Keep all SQL in `server/db.ts`; keep routes thin in `server/index.ts`.

## Acceptance bar

- [ ] Data persists across a reload (verified: add → refresh → still there).
- [ ] Table defined in `migrate()`, queries parameterized + typed + async.
- [ ] API validates input, returns proper status codes; client wrapper in `src/lib/api.ts`.
- [ ] `api/index.ts` still present; dual db driver intact.
- [ ] No secret in client code; no separate backend introduced.
