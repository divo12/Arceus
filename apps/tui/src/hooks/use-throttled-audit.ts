import { useState, useEffect, useRef, useCallback } from "react";
import { connectSSE, type SSEHandle } from "../api/streams.js";

export interface AuditEvent {
  id: string;
  occurredAt: string;
  category: string;
  severity: string;
  eventType: string;
  agentRole?: string;
  summary: string;
  detail?: string;
  beatId?: string;
}

const MAX_EVENTS = 200;
const THROTTLE_MS = 500;

/**
 * Throttled audit SSE hook — batches events and flushes at most every 500ms.
 */
export function useThrottledAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const handleRef = useRef<SSEHandle | null>(null);
  const bufferRef = useRef<AuditEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (bufferRef.current.length > 0) {
        const batch = bufferRef.current;
        bufferRef.current = [];
        setEvents((prev) => [...prev, ...batch].slice(-MAX_EVENTS));
      }
    }, THROTTLE_MS);

    handleRef.current = connectSSE(
      "/api/audit/stream",
      (raw) => {
        const evt: AuditEvent = {
          id: (raw.id as string) ?? crypto.randomUUID(),
          occurredAt: (raw.occurredAt as string) ?? new Date().toISOString(),
          category: (raw.category as string) ?? "system",
          severity: (raw.severity as string) ?? "info",
          eventType: (raw.eventType as string) ?? "",
          agentRole: raw.agentRole as string | undefined,
          summary: (raw.summary as string) ?? "",
          detail: raw.detail as string | undefined,
          beatId: raw.beatId as string | undefined,
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
