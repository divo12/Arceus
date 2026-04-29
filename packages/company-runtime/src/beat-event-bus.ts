/**
 * Beat Event Bus — Spec 12 Phase 3
 *
 * Lightweight pub/sub for beat lifecycle events. The heartbeat engine
 * emits events through BeatDependencies.emitBeatEvent(), and the API
 * layer subscribes for SSE streaming, audit logging, and reactive
 * triggers (e.g. task assignment → wake agent).
 */

export interface BeatEvent {
  type: string;
  beatId: string;
  agentId: string;
  role: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type BeatEventHandler = (event: BeatEvent) => void;

const subscribers = new Set<BeatEventHandler>();

/**
 * Emit a beat event to all subscribers.
 * Called from BeatDependencies.emitBeatEvent().
 */
export function emitBeatEvent(raw: { type: string; beatId: string; agentId: string; role: string; data?: Record<string, unknown> }): void {
  const event: BeatEvent = {
    ...raw,
    timestamp: new Date().toISOString(),
  };

  for (const handler of subscribers) {
    try {
      handler(event);
    // eslint-disable-next-line no-restricted-syntax -- intentional: listener-safety boundary; if a subscriber throws, recursing into the bus would re-enter the broken subscriber.
    } catch {
      /* broken subscriber — ignore */
    }
  }
}

/** Subscribe to beat events. Returns an unsubscribe function. */
export function onBeatEvent(handler: BeatEventHandler): () => void {
  subscribers.add(handler);
  return () => { subscribers.delete(handler); };
}

/** Number of active subscribers (diagnostic). */
export function getBeatEventSubscriberCount(): number {
  return subscribers.size;
}
