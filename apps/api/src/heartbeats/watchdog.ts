/**
 * In-memory beat-watchdog tracker. Tools (arceus_* via MCP middleware,
 * built-ins via the plugin's /watchdog-reset POST) bump `lastActivityAt`
 * so multi-tool beats don't trip the stall guard during legitimate work.
 *
 * Pure in-memory — no DB, no persistence. Lives for the API process lifetime.
 *
 * Also exposes the snapshot via `getBeatActivity` so the live-status
 * endpoint can answer "is this beat thinking or stalled?" without
 * round-tripping the DB.
 */

interface BeatActivity {
  lastActivityAt: number;
  startedAt: number;
  lastTool: string | null;
  role: string | null;
}

const lastActivity = new Map<string, BeatActivity>();

/**
 * Bump `lastActivityAt` for a beat. Optional `tool`/`role` are stored on
 * first sight and overwritten on every subsequent call so the status
 * endpoint always reflects the most recent tool. Returns the new
 * timestamp so callers can echo it back as the response payload.
 */
export const recordBeatActivity = (
  beatId: string,
  tool?: string,
  role?: string,
): number => {
  const ts = Date.now();
  const existing = lastActivity.get(beatId);
  lastActivity.set(beatId, {
    lastActivityAt: ts,
    startedAt: existing?.startedAt ?? ts,
    lastTool: tool ?? existing?.lastTool ?? null,
    role: role ?? existing?.role ?? null,
  });
  return ts;
};

/** Read the current activity snapshot for a beat (null if unknown). */
export function getBeatActivity(beatId: string): BeatActivity | null {
  return lastActivity.get(beatId) ?? null;
}

/** Drop a beat's tracker. Call from runBeat finally to avoid leaks. */
export function forgetBeatActivity(beatId: string): void {
  lastActivity.delete(beatId);
}
