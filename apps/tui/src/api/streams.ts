/**
 * SSE stream wrapper that emits parsed JSON events.
 * Works with the Arceus /api/activity/stream and /api/audit/stream endpoints.
 */
import { EventSource } from "eventsource";
import { getBaseUrl } from "./client.js";

export type SSECallback = (event: Record<string, unknown>) => void;

export interface SSEHandle {
  close(): void;
}

export function connectSSE(
  path: string,
  onEvent: SSECallback,
  onError?: (err: unknown) => void,
): SSEHandle {
  const url = `${getBaseUrl()}${path}`;
  const es = new EventSource(url);

  es.onmessage = (msg: MessageEvent) => {
    // Skip keep-alive pings
    if (!msg.data || msg.data === ":ping" || msg.data.startsWith(":")) return;
    try {
      const parsed = JSON.parse(msg.data);
      onEvent(parsed);
    } catch {
      // Non-JSON SSE data — ignore
    }
  };

  es.onerror = (_err: Event) => {
    onError?.(_err);
  };

  return {
    close() {
      es.close();
    },
  };
}

/**
 * Connect to an SSE endpoint that uses named events (event: <name>).
 * Calls onEvent with { event: string, data: parsed JSON }.
 */
export function connectNamedSSE(
  path: string,
  eventNames: string[],
  onEvent: (event: string, data: Record<string, unknown>) => void,
  onError?: (err: unknown) => void,
): SSEHandle {
  const url = `${getBaseUrl()}${path}`;
  const es = new EventSource(url);

  for (const name of eventNames) {
    es.addEventListener(name, (msg: MessageEvent) => {
      try {
        const parsed = JSON.parse(msg.data);
        onEvent(name, parsed);
      } catch {
        // Non-JSON — ignore
      }
    });
  }

  es.onerror = (_err: Event) => {
    onError?.(_err);
  };

  return {
    close() {
      es.close();
    },
  };
}
