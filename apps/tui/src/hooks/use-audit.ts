import { useState, useEffect, useRef } from "react";
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

/**
 * Subscribe to /api/audit/stream and keep tool-call related events.
 */
export function useAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const handleRef = useRef<SSEHandle | null>(null);

  useEffect(() => {
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
        setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), evt]);
      },
      () => { setConnected(false); },
    );
    setConnected(true);

    return () => {
      handleRef.current?.close();
    };
  }, []);

  const clear = () => { setEvents([]); };

  return { events, connected, clear };
}
