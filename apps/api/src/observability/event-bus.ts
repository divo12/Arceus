/**
 * Spec 32 — In-process event bus for the inspector portal.
 *
 * Sits as one branch of the multi-sink in `server.ts` and exposes:
 *   - a bounded ring buffer (default 5000 events) for snapshot/history queries
 *   - a pub/sub fan-out for SSE subscribers (the `/api/inspector/events/stream` route)
 *
 * Replaces the bespoke graph-store + activity-stream plumbing for the new
 * unified debug portal. Keeps the old surfaces working for now; deletion is
 * a follow-up once nothing reads them.
 */
import type { observability } from "@arceus/contracts";

type ArceusEvent = Parameters<typeof observability.logEvent>[0];

type EventListener = (event: ArceusEvent) => void;

const CAPACITY = Number(process.env.ARCEUS_INSPECTOR_BUFFER ?? "5000");

let buffer: ArceusEvent[] = [];
let nextSeq = 1;
const seqs = new WeakMap<object, number>();
const listeners = new Set<EventListener>();

function tag(event: ArceusEvent): ArceusEvent & { seq: number } {
  const seq = nextSeq++;
  const tagged = { ...event, seq };
  seqs.set(tagged, seq);
  return tagged;
}

export const eventBusSink = {
  write(event: ArceusEvent): void {
    const tagged = tag(event);
    buffer.push(tagged);
    if (buffer.length > CAPACITY) {
      buffer = buffer.slice(buffer.length - CAPACITY);
    }
    for (const listener of listeners) {
      try {
        listener(tagged);
      } catch {
        // never let a broken subscriber take down the hot path
      }
    }
  },
};

export interface SnapshotFilter {
  event?: string;
  beatId?: string;
  sprintId?: string;
  companyId?: string;
  role?: string;
  sinceSeq?: number;
  sinceTs?: number;
  limit?: number;
}

export function snapshot(filter: SnapshotFilter = {}): (ArceusEvent & { seq: number })[] {
  const limit = Math.min(filter.limit ?? 1000, CAPACITY);
  const out: (ArceusEvent & { seq: number })[] = [];
  // walk newest → oldest until we hit limit, then reverse
  for (let i = buffer.length - 1; i >= 0 && out.length < limit; i--) {
    const ev = buffer[i] as ArceusEvent & { seq: number; [k: string]: unknown };
    if (filter.event && ev.event !== filter.event) continue;
    if (filter.beatId && ev.beatId !== filter.beatId) continue;
    if (filter.sprintId && ev.sprintId !== filter.sprintId) continue;
    if (filter.companyId && ev.companyId !== filter.companyId) continue;
    if (filter.role && ev.role !== filter.role) continue;
    if (filter.sinceSeq !== undefined && ev.seq <= filter.sinceSeq) break;
    if (filter.sinceTs !== undefined && (ev.ts) < filter.sinceTs) continue;
    out.push(ev);
  }
  out.reverse();
  return out;
}

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bufferStats() {
  return { size: buffer.length, capacity: CAPACITY, nextSeq };
}

/** Test helper — clears the ring and resets the seq counter. */
function _resetEventBus(): void {
  buffer = [];
  nextSeq = 1;
  listeners.clear();
}
