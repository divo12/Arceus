/**
 * Board-directive extraction — Arceus's standing "owner preferences" memory.
 *
 * The board (the human owner) issues durable instructions in chat ("always use
 * a dark theme", "never add a signup wall", "the checkout must work on mobile").
 * These otherwise scroll out of the bounded recent-chat window, so the CEO
 * forgets them a few sprints later. This module distills board messages into a
 * compact list of standing directives that gets re-injected into the CEO's
 * context every beat — so the CEO honors them across sprints and is told to
 * FLAG conflicts rather than silently override.
 *
 * Pure + deterministic (no LLM, no DB). A future component can layer an LLM
 * extractor + true topic-supersession on top; this heuristic covers the common
 * imperative/preference phrasings reliably and testably.
 */

export type DirectiveKind = "always" | "avoid" | "constraint" | "prefer";

export interface BoardDirective {
  /** Normalized dedup key (so a re-stated directive supersedes the old one). */
  key: string;
  /** The directive text as the board phrased it (cleaned). */
  statement: string;
  kind: DirectiveKind;
  sourceMessageId: string;
  createdAt: string;
}

interface BoardMessageLike {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

// Trigger → kind, in PRIORITY order (first match wins). A negative directive
// ("never/don't/avoid") outranks "always"/"use" so "don't use X" classifies as
// avoid, not prefer.
const TRIGGERS: readonly { kind: DirectiveKind; re: RegExp }[] = [
  { kind: "avoid", re: /\b(never|don['’]?t|do not|avoid|stop|no longer)\b/i },
  { kind: "always", re: /\balways\b/i },
  { kind: "constraint", re: /\b(must|need(?:s)? to|has to|have to|required|cannot|can['’]?t)\b/i },
  { kind: "prefer", re: /\b(prefer|i want|i['’]d like|make sure|ensure|keep it|should|use)\b/i },
];

/** Leading words to strip when deriving a dedup key, so phrasings collapse. */
const KEY_STOP_PREFIX = /^(?:always|never|please|just|maybe|kindly|i\s+(?:want|prefer|would like|'d like)|make sure (?:to|that)?|ensure (?:that)?|keep it|don['’]?t|do not|avoid|the|a|an|use|we should|you should|it should)\s+/i;

function classify(sentence: string): DirectiveKind | null {
  for (const t of TRIGGERS) {
    if (t.re.test(sentence)) return t.kind;
  }
  return null;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
}

function deriveKey(statement: string): string {
  let k = statement.toLowerCase();
  // Strip a leading directive trigger / filler so "always use a dark theme" and
  // "use a dark theme" map to the same topic.
  let prev: string;
  do {
    prev = k;
    k = k.replace(KEY_STOP_PREFIX, "");
  } while (k !== prev);
  return k.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** Extract directives from board-role messages. Pure. */
export function extractBoardDirectives(
  messages: readonly BoardMessageLike[],
): BoardDirective[] {
  const out: BoardDirective[] = [];
  for (const m of messages) {
    if (m.role !== "board") continue;
    const sentences = m.content.split(/[.!?\n]+/).map(clean).filter(Boolean);
    for (const sentence of sentences) {
      const kind = classify(sentence);
      if (!kind) continue;
      const key = deriveKey(sentence);
      if (!key) continue;
      out.push({ key, statement: sentence, kind, sourceMessageId: m.id, createdAt: m.createdAt });
    }
  }
  return out;
}

/** Collapse to one directive per key, keeping the most recent restatement. */
export function dedupeDirectivesToLatest(directives: readonly BoardDirective[]): BoardDirective[] {
  const latest = new Map<string, BoardDirective>();
  for (const d of directives) {
    const existing = latest.get(d.key);
    if (!existing || d.createdAt >= existing.createdAt) latest.set(d.key, d);
  }
  return [...latest.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const KIND_LABEL: Record<DirectiveKind, string> = {
  always: "ALWAYS",
  avoid: "AVOID",
  constraint: "MUST",
  prefer: "PREFER",
};

/** Render the standing-directives block for the CEO prompt. Empty when none. */
export function renderBoardDirectivesBlock(directives: readonly BoardDirective[], max = 10): string {
  const deduped = dedupeDirectivesToLatest(directives).slice(0, max);
  if (deduped.length === 0) return "";
  const lines = deduped.map((d) => `- [${KIND_LABEL[d.kind]}] ${d.statement}`);
  return [
    "## Standing board directives (honor these across ALL sprints)",
    "The board gave these durable instructions. Treat them as hard constraints on every sprint you plan.",
    ...lines,
    "",
    "If a new request CONFLICTS with one of these, do NOT silently override it — flag the conflict to the board and ask which wins.",
  ].join("\n");
}

/** Convenience: extract + render in one call from a chat-message list. */
export function buildBoardDirectivesBlock(messages: readonly BoardMessageLike[]): string {
  return renderBoardDirectivesBlock(extractBoardDirectives(messages));
}
