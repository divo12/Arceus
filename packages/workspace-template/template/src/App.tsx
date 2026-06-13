import { useEffect, useState } from "react";
import { api, type Note } from "@/lib/api";
import { aiPrompt, AiCompleteError } from "@/lib/aiComplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

/**
 * Starter demo — proves the full stack works end to end:
 *   • the React UI (this file)
 *   • the server API + SQLite persistence (server/, via @/lib/api)
 *   • the Arceus AI gateway (via @/lib/aiComplete) — no API key needed
 *
 * Replace this with your product. The pieces above are the scaffold's
 * building blocks; keep using the design-system primitives in @/components/ui.
 */
export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listNotes().then(setNotes).catch((e) => { setError(String(e.message ?? e)); });
  }, []);

  async function addNote() {
    const value = text.trim();
    if (!value) return;
    setText("");
    try {
      const note = await api.createNote(value);
      setNotes((prev) => [note, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save note");
    }
  }

  async function removeNote(id: number) {
    await api.deleteNote(id).catch(() => {});
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  async function summarize() {
    if (notes.length === 0) return;
    setBusy(true);
    setSummary("");
    setError("");
    try {
      const result = await aiPrompt(
        `Summarise these notes in one short sentence:\n${notes.map((n) => `- ${n.text}`).join("\n")}`,
        { maxTokens: 80 },
      );
      setSummary(result);
    } catch (e) {
      setError(e instanceof AiCompleteError ? e.message : "AI is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-xl px-4 py-12 space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
          <p className="text-sm text-muted-foreground">
            Full-stack starter — notes persist on the server (SQLite), and the ✨ button summarises them with AI.
          </p>
        </header>

        <div className="flex gap-2">
          <Input
            value={text}
            placeholder="Write a note…"
            onChange={(e) => { setText(e.target.value); }}
            onKeyDown={(e) => e.key === "Enter" && addNote()}
          />
          <Button onClick={addNote}>Add</Button>
          <Button variant="secondary" onClick={summarize} disabled={busy || notes.length === 0}>
            {busy ? "…" : "✨ Summarise"}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {summary && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">AI summary</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{summary}</CardContent>
          </Card>
        )}

        <ul className="space-y-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <span>{note.text}</span>
              <button
                onClick={() => removeNote(note.id)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete note"
              >
                ×
              </button>
            </li>
          ))}
          {notes.length === 0 && (
            <li className="text-sm text-muted-foreground">No notes yet — add one above.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
