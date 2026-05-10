"use client";

/**
 * Spec 32 — Inspector portal.
 *
 * Single live view over the ArceusEvent stream. Replaces /debug (graph UI)
 * and /logs (employee-activity feed). Backed by /api/inspector/events +
 * SSE stream from the in-process ring buffer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../../lib/api";

type AnyEvent = {
  seq: number;
  event: string;
  ts: number;
  beatId?: string;
  sprintId?: string | null;
  companyId?: string;
  role?: string;
  [k: string]: unknown;
};

const COLORS: Record<string, string> = {
  "beat.started": "text-blue-400",
  "beat.completed": "text-green-400",
  "beat.idle": "text-gray-500",
  "role.handoff": "text-emerald-400",
  "sprint.created": "text-amber-400",
  "sprint.completed": "text-amber-300",
  "tool.invoked": "text-cyan-400",
  "tool.result": "text-cyan-300",
  "tool.denied": "text-red-400",
  "idempotency.replay": "text-purple-300",
  "task.created": "text-yellow-300",
  "task.updated": "text-yellow-200",
  "task.artifact_attached": "text-yellow-400",
  "artifact.created": "text-orange-400",
  "approval.requested": "text-pink-300",
  "approval.resolved": "text-pink-400",
  "meeting.recorded": "text-teal-400",
  "meeting.contribution": "text-teal-300",
  "memory.written": "text-fuchsia-400",
  "permission.asked": "text-purple-400",
  "permission.replied": "text-purple-300",
  "agent.reasoning": "text-indigo-300",
  "error": "text-red-500 font-bold",
};

const CATEGORIES: Record<string, string> = {
  "beat.started": "beat",
  "beat.completed": "beat",
  "beat.idle": "beat",
  "role.handoff": "beat",
  "sprint.created": "sprint",
  "sprint.completed": "sprint",
  "tool.invoked": "tool",
  "tool.result": "tool",
  "tool.denied": "tool",
  "idempotency.replay": "tool",
  "task.created": "task",
  "task.updated": "task",
  "task.artifact_attached": "task",
  "artifact.created": "artifact",
  "approval.requested": "approval",
  "approval.resolved": "approval",
  "meeting.recorded": "meeting",
  "meeting.contribution": "meeting",
  "memory.written": "memory",
  "permission.asked": "permission",
  "permission.replied": "permission",
  "agent.reasoning": "reasoning",
  "error": "error",
};

const ALL_CATEGORIES = Array.from(new Set(Object.values(CATEGORIES))).sort();

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

/**
 * Pull the most informative single field out of a tool-call args object so
 * the inspector line can show it inline. Built-in OpenCode tools don't
 * carry args through the MCP middleware (they go through the watchdog-
 * reset back-channel from the plugin); the plugin sends them in the
 * BEFORE-hook stash so `ev.args` is the raw call-args object.
 *
 * Examples after rendering:
 *   pm        → skill {ui-theme-catalog}
 *   developer → read {/workspace/src/App.tsx}
 *   developer → bash {npm run typecheck}
 *   ui_designer → glob {**\/*.tsx}
 *   developer → webfetch {https://example.com}
 */
function summarizeToolArgs(tool: unknown, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const truncate = (s: string, n = 60): string =>
    s.length > n ? `${s.slice(0, n)}…` : s;
  const t = String(tool ?? "");
  // Built-in OpenCode tools — pick the most useful single field
  if (t === "skill" && typeof a.name === "string") return ` {${a.name}}`;
  if ((t === "read" || t === "edit" || t === "write" || t === "create")
      && typeof a.filePath === "string") {
    return ` {${truncate(a.filePath, 70)}}`;
  }
  if (t === "bash" && typeof a.command === "string") {
    return ` {${truncate(a.command, 70)}}`;
  }
  if (t === "glob" && typeof a.pattern === "string") {
    return ` {${truncate(a.pattern, 60)}}`;
  }
  if (t === "grep" && typeof a.pattern === "string") {
    return ` {${truncate(a.pattern, 60)}}`;
  }
  if (t === "webfetch" && typeof a.url === "string") {
    return ` {${truncate(a.url, 60)}}`;
  }
  // Arceus_* tools: surface the most-common id-ish keys when present.
  for (const key of ["taskId", "artifactId", "sprintId", "skillId", "name", "title"]) {
    const v = a[key];
    if (typeof v === "string" && v.length > 0) {
      return ` {${key}=${truncate(v, 40)}}`;
    }
  }
  return "";
}

function summary(ev: AnyEvent): string {
  switch (ev.event) {
    case "beat.started":
      return `${ev.role} · trust=${ev.trustBand} · sprint=${ev.sprintId ?? "—"}`;
    case "beat.completed": {
      const score = ev.verdictScore as number | undefined;
      return `${ev.role} · ${ev.verdictOutcome} (${score?.toFixed?.(2) ?? "?"}) · ${ev.durationMs}ms`;
    }
    case "beat.idle":
      return `stalled ${ev.stalledMs}ms`;
    case "role.handoff":
      return `${ev.from} → ${ev.to} · ${ev.reason}`;
    case "sprint.created":
      return `${ev.goal}`;
    case "sprint.completed":
      return `sprint ${ev.sprintId} done`;
    case "tool.invoked":
      return `${ev.role} → ${ev.tool}${summarizeToolArgs(ev.tool, ev.args)}${ev.idempotencyKey ? ` [idem:${String(ev.idempotencyKey).slice(0, 8)}]` : ""}`;
    case "tool.result":
      return `${ev.tool} · ${ev.ok ? "ok" : "FAIL"}${ev.cause ? ` (${ev.cause})` : ""} · ${ev.durationMs}ms`;
    case "tool.denied":
      return `${ev.role} → ${ev.tool} · ${ev.reason}`;
    case "idempotency.replay":
      return `${ev.tool} · key=${String(ev.key).slice(0, 12)}`;
    case "task.created":
      return `→ ${ev.assignedRole} · task=${String(ev.taskId).slice(0, 8)}`;
    case "task.updated":
      return `task=${String(ev.taskId).slice(0, 8)} · ${(ev.patch as string[])?.join(",")}`;
    case "task.artifact_attached":
      return `task=${String(ev.taskId).slice(0, 8)} ⇐ artifact=${String(ev.artifactId).slice(0, 8)}`;
    case "artifact.created":
      return `${ev.kind} · attached=${(ev.attachedTaskIds as string[])?.length ?? 0}`;
    case "approval.requested":
      return `${ev.kind} · approval=${String(ev.approvalId).slice(0, 8)}`;
    case "approval.resolved":
      return `${ev.outcome} · approval=${String(ev.approvalId).slice(0, 8)}`;
    case "meeting.recorded":
      return `${(ev.participants as string[])?.join(", ")}`;
    case "meeting.contribution":
      return `pos=${ev.position}${ev.artifactId ? ` · artifact=${String(ev.artifactId).slice(0, 8)}` : ""}`;
    case "memory.written":
      return `scope=${ev.scope} · ${ev.sizeBytes}B`;
    case "permission.asked":
      return `tool=${ev.tool}`;
    case "permission.replied":
      return `tool=${ev.tool} · ${ev.granted ? "granted" : "denied"}`;
    case "agent.reasoning":
      return `${ev.role}: ${String(ev.text).slice(0, 100)}`;
    case "error":
      return `${ev.where}: ${ev.message}`;
    default:
      return JSON.stringify(ev).slice(0, 120);
  }
}

/**
 * Track all beats currently mid-flight by walking the event stream.
 * A beat is "live" if its beat.started has no matching beat.completed
 * (or beat.failed). Used to drive the live-status pills so we don't
 * poll the status endpoint for already-finished beats.
 */
function deriveLiveBeats(events: AnyEvent[]): Array<{ beatId: string; role?: string }> {
  const seen = new Map<string, { role?: string; done: boolean }>();
  for (const ev of events) {
    if (typeof ev.beatId !== "string") continue;
    if (ev.event === "beat.started") {
      seen.set(ev.beatId, { role: typeof ev.role === "string" ? ev.role : undefined, done: false });
    } else if (ev.event === "beat.completed" || ev.event === "beat.failed") {
      const existing = seen.get(ev.beatId);
      if (existing) existing.done = true;
    }
  }
  const live: Array<{ beatId: string; role?: string }> = [];
  for (const [beatId, info] of seen) {
    if (!info.done) live.push({ beatId, role: info.role });
  }
  // Cap at the 8 most recently started so the polling loop stays cheap;
  // older "live" beats are almost certainly stranded and will be reaped.
  return live.slice(-8);
}

interface BeatStatus {
  phase: "active" | "idle_short" | "idle_long" | "stalled" | "unknown";
  lastTool: string | null;
  role: string | null;
  secondsSinceActivity: number | null;
  secondsRunning: number | null;
}

const PHASE_STYLE: Record<BeatStatus["phase"], string> = {
  active: "bg-green-900 text-green-200 border-green-600",
  idle_short: "bg-yellow-900 text-yellow-200 border-yellow-600",
  idle_long: "bg-orange-900 text-orange-200 border-orange-600",
  stalled: "bg-red-900 text-red-200 border-red-600",
  unknown: "bg-gray-900 text-gray-400 border-gray-700",
};

const PHASE_LABEL: Record<BeatStatus["phase"], string> = {
  active: "active",
  idle_short: "thinking",
  idle_long: "idle",
  stalled: "STALLED",
  unknown: "—",
};

export default function InspectorPage() {
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterRole, setFilterRole] = useState<string>("all");
  const [filterBeat, setFilterBeat] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [beatStatuses, setBeatStatuses] = useState<Record<string, BeatStatus>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // SSE stream (with built-in history replay)
  useEffect(() => {
    const es = new EventSource(apiUrl("/inspector/events/stream?limit=500"));
    es.addEventListener("arceus", (e) => {
      if (pausedRef.current) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as AnyEvent;
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > 5000 ? next.slice(-5000) : next;
        });
      } catch {}
    });
    es.onerror = () => {
      // browser will auto-reconnect; nothing to do
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "auto" });
    }
  }, [events, autoScroll]);

  // Live-status poller — poll /beats/:beatId/status for every beat the
  // event stream says is mid-flight. 5s tick is the sweet spot between
  // freshness ("am I still alive?") and not hammering the API. The
  // endpoint is in-memory only so per-call cost is microseconds.
  const liveBeats = useMemo(() => deriveLiveBeats(events), [events]);
  useEffect(() => {
    if (liveBeats.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const next: Record<string, BeatStatus> = {};
      await Promise.all(
        liveBeats.map(async ({ beatId }) => {
          try {
            const res = await fetch(apiUrl(`/internal/v1/beats/${beatId}/status`));
            if (!res.ok) return;
            const env = (await res.json()) as { data?: BeatStatus };
            if (env.data) next[beatId] = env.data;
          } catch {
            // network hiccup — leave the previous state for this beat in place
          }
        }),
      );
      if (!cancelled) {
        setBeatStatuses((prev) => ({ ...prev, ...next }));
      }
    };
    void tick();
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [liveBeats]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  };

  const allRoles = useMemo(
    () => Array.from(new Set(events.map((e) => e.role).filter(Boolean) as string[])).sort(),
    [events],
  );

  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (filterCategory !== "all" && CATEGORIES[ev.event] !== filterCategory) return false;
      if (filterRole !== "all" && ev.role !== filterRole) return false;
      if (filterBeat && ev.beatId !== filterBeat) return false;
      if (search) {
        const blob = JSON.stringify(ev).toLowerCase();
        if (!blob.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [events, filterCategory, filterRole, filterBeat, search]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const ev of events) {
      const cat = CATEGORIES[ev.event] ?? "other";
      m[cat] = (m[cat] ?? 0) + 1;
    }
    return m;
  }, [events]);

  const toggle = (seq: number) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(seq)) n.delete(seq);
      else n.add(seq);
      return n;
    });

  return (
    <div className="flex flex-col h-screen bg-black text-gray-100">
      {/* Header */}
      <header className="shrink-0 border-b border-gray-800 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-bold tracking-tight">Inspector</h1>
          <span className="text-[0.7rem] text-gray-500">
            Spec 32 event stream · {filtered.length} / {events.length} events
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1 text-[0.65rem] text-gray-500">
          {ALL_CATEGORIES.map((c) => (
            <span key={c} className="rounded bg-gray-900 px-1.5 py-0.5">
              {c}: {counts[c] ?? 0}
            </span>
          ))}
        </div>

        {/* Live beat-status pills — answers "is this beat thinking or stalled?" */}
        {liveBeats.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[0.65rem]">
            {liveBeats.map(({ beatId, role }) => {
              const s = beatStatuses[beatId];
              const phase = s?.phase ?? "unknown";
              const tool = s?.lastTool ?? "—";
              const since = s?.secondsSinceActivity;
              const running = s?.secondsRunning;
              return (
                <button
                  key={beatId}
                  onClick={() => setFilterBeat(beatId)}
                  title={`beat=${beatId}\nlast tool: ${tool}\nrunning: ${running ?? "?"}s`}
                  className={`rounded border px-1.5 py-0.5 font-mono ${PHASE_STYLE[phase]}`}
                >
                  <span className="opacity-80">{role ?? s?.role ?? "?"}</span>
                  {" · "}
                  <span className="font-bold">{PHASE_LABEL[phase]}</span>
                  {since !== null && since !== undefined ? (
                    <span className="opacity-80"> · {since}s</span>
                  ) : null}
                  {tool !== "—" ? (
                    <span className="opacity-60"> · {tool}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Toolbar */}
      <div className="shrink-0 border-b border-gray-800 px-4 py-2 flex flex-wrap items-center gap-2 text-xs">
        <select
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1"
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
        >
          <option value="all">All categories</option>
          {ALL_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1"
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value)}
        >
          <option value="all">All roles</option>
          {allRoles.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="beatId filter"
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 w-44 font-mono"
          value={filterBeat}
          onChange={(e) => setFilterBeat(e.target.value.trim())}
        />

        <input
          type="text"
          placeholder="search (any field)…"
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 w-56"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <button
          className={`rounded px-2 py-1 ${paused ? "bg-yellow-700 text-white" : "bg-gray-900 border border-gray-700"}`}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>

        <button
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-400 hover:text-white"
          onClick={() => setEvents([])}
        >
          Clear
        </button>

        <span className={`ml-auto ${autoScroll ? "text-green-400" : "text-gray-500"}`}>
          {autoScroll ? "↓ tail" : "scroll paused"}
        </span>
      </div>

      {/* Stream */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[0.72rem] leading-5"
      >
        {filtered.map((ev) => {
          const isOpen = expanded.has(ev.seq);
          const colorClass = COLORS[ev.event] ?? "text-gray-300";
          return (
            <div key={ev.seq} className="border-b border-gray-900/60">
              <button
                className="w-full text-left px-4 py-0.5 hover:bg-gray-900/60 flex gap-3"
                onClick={() => toggle(ev.seq)}
              >
                <span className="text-gray-600 shrink-0">{fmtTime(ev.ts)}</span>
                <span className={`${colorClass} shrink-0 w-44`}>{ev.event}</span>
                {ev.role ? (
                  <span className="text-gray-500 shrink-0 w-20">{ev.role}</span>
                ) : (
                  <span className="shrink-0 w-20" />
                )}
                {ev.beatId ? (
                  <span
                    className="text-gray-700 shrink-0 w-24 hover:text-cyan-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilterBeat(ev.beatId!);
                    }}
                    title="filter by this beat"
                  >
                    {ev.beatId.slice(0, 8)}
                  </span>
                ) : (
                  <span className="shrink-0 w-24" />
                )}
                <span className="text-gray-300 truncate">{summary(ev)}</span>
              </button>
              {isOpen && (
                <pre className="bg-gray-950 px-4 py-2 overflow-x-auto text-[0.7rem] text-gray-400">
                  {JSON.stringify(ev, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
