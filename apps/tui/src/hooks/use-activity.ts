import { useState, useEffect, useRef } from "react";
import { connectSSE, type SSEHandle } from "../api/streams.js";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  employee: string; // role
  type: string;
  content: string;
  beatId?: string;
  taskId?: string;
  detail?: string;
}

const MAX_EVENTS = 200;

/**
 * Subscribe to /api/activity/stream and keep the last N events.
 */
export function useActivity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const handleRef = useRef<SSEHandle | null>(null);

  useEffect(() => {
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
        setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), evt]);
      },
      () => setConnected(false),
    );
    setConnected(true);

    return () => {
      handleRef.current?.close();
    };
  }, []);

  const clear = () => setEvents([]);

  return { events, connected, clear };
}
