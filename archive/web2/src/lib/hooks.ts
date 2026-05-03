/**
 * useView — fetches raw API endpoints in parallel, runs a derive
 * function, returns a typed view. Auto-refreshes on heartbeat tick.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, sse } from "./api.js";

export interface ViewState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useView<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): ViewState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await fetcher();
      if (my === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}

/** Subscribe to /api/audit/stream for live invalidation hints. */
export function useAuditStream(onTick: () => void) {
  useEffect(() => {
    const close = sse("/api/audit/stream", () => { onTick(); });
    return () => { close(); };
  }, [onTick]);
}

/** Poll heartbeat status; lighter than wiring SSE for now. */
export function useHeartbeat(intervalMs = 4000) {
  const [hb, setHb] = useState<{ running: boolean; beatCount: number; lastBeatAt: string | null }>({
    running: false,
    beatCount: 0,
    lastBeatAt: null,
  });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const v = await api.get<{ running: boolean; beatCount: number; lastBeatAt?: string | null }>(
          "/api/heartbeat/status",
        );
        if (alive) setHb({
          running: !!v.running,
          beatCount: v.beatCount ?? 0,
          lastBeatAt: v.lastBeatAt ?? null,
        });
      } catch { /* noop */ }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);
  return hb;
}
