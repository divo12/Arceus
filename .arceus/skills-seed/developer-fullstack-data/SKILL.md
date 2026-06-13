---
name: developer-fullstack-data
description: How to add data persistence + HTTP APIs in the full-stack scaffold — SQLite via server/db.ts, /api routes via server/index.ts (Hono), and the typed client in src/lib/api.ts. Load when a task needs data that persists (across reloads/users/devices), a backend endpoint, or server-side logic/secrets. The scaffold is full-stack: never use localStorage for real data and never scaffold a separate backend.
role: developer
trigger: task involves saving/loading data, "persist", accounts, lists that survive refresh, multi-user/shared state, an API, a webhook, or any server-side secret/logic — before reaching for localStorage or a new backend.
---

# Full-stack data + APIs

The scaffold has a real backend already. **Frontend = `src/` (browser). Backend = `server/` (Node).** One `npm run dev` runs both on one port: `/api/*` → the Hono server, everything else → the React app.

## The three files

**`server/db.ts` — persistence (SQLite via `node:sqlite`, file at `data/app.db`, survives restarts).**
Define your data model in `migrate()` and export typed helpers:
```ts
function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );`);
}
export function listTasks(): Task[] {
  return db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as unknown as Task[];
}
export function addTask(title: string): Task {
  const created_at = new Date().toISOString();
  const r = db.prepare("INSERT INTO tasks (title, created_at) VALUES (?, ?)").run(title, created_at);
  return { id: Number(r.lastInsertRowid), title, done: 0, created_at };
}
```
Always use parameterized queries (`?`), never string-concatenate SQL. `.all()` needs `as unknown as T[]`.

**`server/index.ts` — HTTP API (Hono).** One route per operation, under `/api/*`:
```ts
app.get("/api/tasks", (c) => c.json(listTasks()));
app.post("/api/tasks", async (c) => {
  const { title } = await c.req.json().catch(() => ({}));
  if (typeof title !== "string" || !title.trim()) return c.json({ error: "title required" }, 400);
  return c.json(addTask(title.trim()), 201);
});
```
Validate input at the boundary; return JSON + a correct status code.

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

- **Real data → SQLite (server), NOT localStorage.** localStorage is per-browser and lost on another device; the spec almost always means real persistence.
- **Secrets + privileged logic live in `server/`.** `process.env` is readable there and never ships to the browser. Arceus injects per-company secrets (and `ARCEUS_COMPANY_ID`) into the server env. NEVER read a secret in `src/` client code.
- **Don't add a second backend** (Express/Next/a DB server) — extend `server/`.
- Keep all SQL in `server/db.ts`; keep routes thin in `server/index.ts`.

## Acceptance bar

- [ ] Data persists across a reload (verified: add → refresh → still there).
- [ ] Table defined in `migrate()`, queries parameterized + typed.
- [ ] API validates input, returns proper status codes; client wrapper in `src/lib/api.ts`.
- [ ] No secret in client code; no separate backend introduced.
