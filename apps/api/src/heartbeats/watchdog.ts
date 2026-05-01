/**
 * In-memory beat-watchdog tracker. Tools (via plugin PostToolUse) bump a
 * beat's `lastActivityAt`; long-running beats use this to suppress false
 * watchdog timeouts during multi-tool sequences.
 *
 * Pure in-memory — no DB, no persistence. Lives for the API process lifetime.
 */

const lastActivity = new Map<string, number>();

/** Bump `lastActivityAt` for a beat. Returns the new timestamp. */
export const recordBeatActivity = (beatId: string): number => {
  const ts = Date.now();
  lastActivity.set(beatId, ts);
  return ts;
};

