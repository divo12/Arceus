import { useState, useEffect, useRef, useCallback } from "react";
import { connectSSE, type SSEHandle } from "../api/streams.js";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  employee: string;
  type: string;
  content: string;
  beatId?: string;
  taskId?: string;
  detail?: string;
}

const MAX_EVENTS = 200;
const THROTTLE_MS = 500;

/**
 * Throttled activity SSE hook — batches events and flushes at most every 500ms.
 */
export function useThrottledActivity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const handleRef = useRef<SSEHandle | null>(null);
  const bufferRef = useRef<ActivityEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Flush buffer into state on interval
    timerRef.current = setInterval(() => {
      if (bufferRef.current.length > 0) {
        const batch = bufferRef.current;
        bufferRef.current = [];
        setEvents((prev) => [...prev, ...batch].slice(-MAX_EVENTS));
      }
    }, THROTTLE_MS);

    handleRef.current = connectSSE(
      "/api/activity/stream",
      (raw) => {
        const evt: ActivityEvent = {
          id: (raw.id as string) ?? crypto.randomUUID(),
          timestamp: (raw.timestamp as string) ?? new Date().toISOString(),
          employee: (raw.employee as string) ?? (raw.role as string) ?? "system",
          type: (raw.type as string) ?? "info",
          content: (raw.content as string) ?? "",
          beatId: raw.beatId as string | undefined,
          taskId: raw.taskId as string | undefined,
          detail: raw.detail as string | undefined,
        };
        bufferRef.current.push(evt);
      },
      () => setConnected(false),
    );
    setConnected(true);

    return () => {
      handleRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const clear = useCallback(() => {
    bufferRef.current = [];
    setEvents([]);
  }, []);

  return { events, connected, clear };
}
