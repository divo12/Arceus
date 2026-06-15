/**
 * Canonical content key for memory equality.
 *
 * Lowercase, strip punctuation, collapse whitespace. Used by BOTH retrieval-time
 * dedup and the write-path upsert so they agree on what "the same fact" means —
 * if these diverged, a write could decline to upsert content that recall would
 * then collapse (or vice-versa).
 */
export function normalizeContentKey(content: string): string {
  return (content ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
