/**
 * Typed client for the product's own server API (server/index.ts).
 * Same-origin fetch — no base URL, no keys. Mirror your server routes here
 * with small typed wrappers so components never hand-roll fetch calls.
 */
export interface Note {
  id: number;
  text: string;
  created_at: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listNotes: () => fetch("/api/notes").then(json<Note[]>),
  createNote: (text: string) =>
    fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<Note>),
  deleteNote: (id: number) =>
    fetch(`/api/notes/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
};
