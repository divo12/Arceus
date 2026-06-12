/**
 * F7 — beat session resume per (companyId, role, task).
 *
 * Paperclip's Part E pattern adapted to Arceus: instead of destroying the
 * OpenCode session after every beat (cold start → the model re-derives
 * all context → the over-read pathology), a beat that leaves its task
 * UNFINISHED parks its session here, and the role's next beat resumes the
 * same conversation — files already read stay read, design decisions stay
 * in working memory.
 *
 * Deliberate properties:
 *
 * - IN-MEMORY ONLY. OpenCode sessions live inside the opencode
 *   subprocess; an API/opencode restart destroys them regardless of what
 *   we persist. The liveness probe below is the source of truth — a
 *   stale entry simply fails the probe and the beat falls back to a
 *   fresh session.
 * - RESUME CAP. Conversation context accumulates across resumes (every
 *   prior read and tool result rides along). SESSION_RESUME_LIMIT bounds
 *   the growth: after N resumes the session is retired and the next beat
 *   starts fresh from the plan-step trail — the trail is the compaction.
 * - take() semantics: an entry is REMOVED when read. The beat that took
 *   it re-stores the session at its end if the task is still unfinished;
 *   a crash between take and store simply costs one cold start.
 */
import { getOpencode } from "../infra/opencode.js";
import { swallowAndReport } from "../observability/swallow.js";

export interface ResumableSession {
  sessionId: string;
  /** The unfinished task this session was working when parked. */
  taskId: string;
  /** How many times this session has already been resumed. */
  resumeCount: number;
  storedAt: number;
}

/** Max resumes of one session before retiring it (context-growth bound). */
export const SESSION_RESUME_LIMIT = 4;

const store = new Map<string, ResumableSession>();

const keyOf = (companyId: string, role: string): string => `${companyId}::${role}`;

/** Park a session for the role's next beat. Replaces any prior entry. */
export function storeResumableSession(
  companyId: string,
  role: string,
  entry: { sessionId: string; taskId: string; resumeCount: number },
): void {
  store.set(keyOf(companyId, role), { ...entry, storedAt: Date.now() });
}

/**
 * Remove and return the parked session for this role, if any. The caller
 * owns the entry from here: re-store it at beat end or destroy the
 * session.
 */
export function takeResumableSession(companyId: string, role: string): ResumableSession | null {
  const key = keyOf(companyId, role);
  const entry = store.get(key);
  if (entry) store.delete(key);
  return entry ?? null;
}

/**
 * Bounded liveness probe — does OpenCode still hold this session?
 * False on any transport failure (wedged/respawned opencode) or missing
 * session; the caller falls back to a fresh session.
 */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  const result = await swallowAndReport(
    "session_resume.probe",
    async () => {
      const opencode = await getOpencode();
      return opencode.client.session.get({
        path: { id: sessionId },
        signal: AbortSignal.timeout(5_000),
      });
    },
    { detail: { sessionId } },
  );
  if (result === undefined) return false;
  const data = (result as { data?: { id?: string } }).data;
  return data?.id === sessionId;
}
