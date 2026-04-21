import { useState, useCallback } from "react";
import { api, apiPost } from "../api/client.js";
import { usePoll } from "./use-poll.js";

export interface HeartbeatStatus {
  running: boolean;
  schedulerIntervalMs?: number;
  beatCount?: number;
  lastBeatAt?: string;
  totalTokens?: number;
  totalCostCents?: number;
}

/**
 * Heartbeat engine status + controls (start, stop, trigger).
 */
export function useHeartbeat() {
  const { data, error } = usePoll<HeartbeatStatus>("/api/heartbeat/status", 3000);
  const [actionError, setActionError] = useState<string | null>(null);

  const start = useCallback(async () => {
    try {
      await apiPost("/api/heartbeat/start");
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await apiPost("/api/heartbeat/stop");
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const trigger = useCallback(async (role?: string) => {
    try {
      await apiPost("/api/heartbeat/trigger", role ? { role } : undefined);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return {
    status: data,
    error: error ?? actionError,
    start,
    stop,
    trigger,
  };
}
