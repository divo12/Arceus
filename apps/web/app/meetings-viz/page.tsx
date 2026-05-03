"use client";

import { useEffect, useState, useMemo } from "react";
import type { CompanySnapshot, Meeting } from "@arceus/contracts";
import { apiUrl } from "../../lib/api";

/* ── Role → color map (matches globals.css role vars) ── */
const ROLE_COLORS: Record<string, string> = {
  ceo: "#eab308",
  cto: "#3b82f6",
  pm: "#8b5cf6",
  developer: "#22c55e",
  tester: "#f97316",
  ui_designer: "#ec4899",
  marketing: "#06b6d4",
  skills_lead: "#a78bfa",
};

const ROLE_EMOJI: Record<string, string> = {
  ceo: "👔",
  cto: "🧠",
  pm: "📋",
  developer: "💻",
  tester: "🧪",
  ui_designer: "🎨",
  marketing: "📢",
  skills_lead: "⚡",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  scheduled: { label: "Scheduled", color: "#71717a" },
  collecting: { label: "Collecting Updates", color: "#3b82f6" },
  synthesizing: { label: "Synthesizing", color: "#8b5cf6" },
  resolving: { label: "Resolving", color: "#f59e0b" },
  executing: { label: "Executing Decisions", color: "#f97316" },
  learning: { label: "Extracting Learnings", color: "#06b6d4" },
  completed: { label: "Completed", color: "#22c55e" },
  skipped: { label: "Skipped", color: "#71717a" },
};

/* ── Attendee positioned around the table ── */
interface Attendee {
  id: string;
  name: string;
  role: string;
  isFacilitator: boolean;
  contribution: Meeting["contributions"][number] | null;
  angle: number;
  x: number;
  y: number;
}

function computeAttendees(meeting: Meeting, agentsById: Map<string, { id: string; name: string; role: string }>): Attendee[] {
  const ids = meeting.participantAgentIds;
  const count = ids.length;
  // Place facilitator at top (angle = -90°), others evenly around
  const facilitatorIdx = ids.indexOf(meeting.facilitatorAgentId);
  return ids.map((id, i) => {
    const agent = agentsById.get(id);
    const isFac = id === meeting.facilitatorAgentId;
    // Offset so facilitator sits at top center
    const offset = facilitatorIdx >= 0 ? facilitatorIdx : 0;
    const angle = ((i - offset) / count) * 360 - 90;
    const rad = (angle * Math.PI) / 180;
    const radius = 42; // % from center
    const contribution = meeting.contributions.find((c) => c.agentId === id) ?? null;
    return {
      id,
      name: agent?.name ?? id.split("_").slice(1, 2).join(""),
      role: agent?.role ?? "unknown",
      isFacilitator: isFac,
      contribution,
      angle,
      x: 50 + radius * Math.cos(rad),
      y: 50 + radius * Math.sin(rad),
    };
  });
}

/* ── Phase Progress Bar ── */
const PHASES = ["scheduled", "collecting", "synthesizing", "resolving", "executing", "learning", "completed"] as const;

function PhaseProgress({ status }: { status: string }) {
  const currentIdx = PHASES.indexOf(status as (typeof PHASES)[number]);
  return (
    <div className="flex items-center gap-1">
      {PHASES.map((phase, i) => {
        const done = i <= currentIdx;
        const active = i === currentIdx;
        const info = STATUS_LABELS[phase] ?? { label: phase, color: "#71717a" };
        return (
          <div key={phase} className="flex items-center gap-1">
            <div
              className={`h-2 rounded-full transition-all ${active ? "w-8" : "w-4"}`}
              style={{
                background: done ? info.color : "rgba(255,255,255,0.1)",
                boxShadow: active ? `0 0 8px ${info.color}80` : "none",
              }}
              title={info.label}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ── Contribution Bubble (speech bubble from attendee) ── */
function ContributionBubble({ attendee, selected, onSelect }: { attendee: Attendee; selected: boolean; onSelect: () => void }) {
  const c = attendee.contribution?.contribution;
  if (!c) return null;
  const color = ROLE_COLORS[attendee.role] ?? "#888";
  const hasBlocker = c.blockers && c.blockers.trim().length > 0;

  return (
    <div
      className={`absolute z-30 max-w-[220px] rounded-lg border px-3 py-2 text-xs transition-all cursor-pointer
        ${selected ? "scale-105 shadow-lg" : "opacity-80 hover:opacity-100 hover:scale-[1.02]"}
      `}
      style={{
        left: `${attendee.x}%`,
        top: `${attendee.y}%`,
        transform: "translate(-50%, -140%)",
        borderColor: selected ? color : "rgba(255,255,255,0.1)",
        background: selected ? `${color}18` : "rgba(30,33,41,0.95)",
      }}
      onClick={onSelect}
    >
      {hasBlocker && (
        <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-red-400">
          <span>🚨</span> BLOCKER
        </div>
      )}
      <p className="line-clamp-3 leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {c.whatImDoing || c.whatIDid || "No update"}
      </p>
    </div>
  );
}

/* ── Avatar at table ── */
function SeatAvatar({ attendee, selected, onSelect }: { attendee: Attendee; selected: boolean; onSelect: () => void }) {
  const color = ROLE_COLORS[attendee.role] ?? "#888";
  const emoji = ROLE_EMOJI[attendee.role] ?? "👤";
  const hasContribution = !!attendee.contribution;

  return (
    <button
      type="button"
      className="absolute z-20 flex flex-col items-center gap-1 transition-transform"
      style={{
        left: `${attendee.x}%`,
        top: `${attendee.y}%`,
        transform: `translate(-50%, -50%) ${selected ? "scale(1.15)" : "scale(1)"}`,
      }}
      onClick={onSelect}
    >
      {/* Avatar circle */}
      <div
        className="relative flex h-12 w-12 items-center justify-center rounded-full border-2 text-lg transition-shadow"
        style={{
          borderColor: color,
          background: `${color}20`,
          boxShadow: selected
            ? `0 0 20px ${color}60, 0 0 40px ${color}20`
            : hasContribution
              ? `0 0 8px ${color}30`
              : "none",
        }}
      >
        <span>{emoji}</span>
        {/* Facilitator crown */}
        {attendee.isFacilitator && (
          <span className="absolute -top-3 text-xs">👑</span>
        )}
        {/* Contribution indicator */}
        {hasContribution && (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2"
            style={{ borderColor: "var(--bg-primary)", background: "#22c55e" }}
          />
        )}
        {!hasContribution && (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2"
            style={{ borderColor: "var(--bg-primary)", background: "#71717a" }}
          />
        )}
      </div>
      {/* Name label */}
      <span
        className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider"
        style={{ color }}
      >
        {attendee.name}
      </span>
      <span className="text-[9px] capitalize" style={{ color: "var(--text-muted)" }}>
        {attendee.role.replace(/_/g, " ")}
      </span>
    </button>
  );
}

/* ── Synthesis Panel ── */
function SynthesisPanel({ meeting }: { meeting: Meeting }) {
  const s = meeting.synthesis;
  if (!s) return <p className="text-xs text-[var(--text-muted)]">No synthesis data.</p>;

  return (
    <div className="space-y-3">
      {s.conflicts.length > 0 && (
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-400">
            Conflicts ({s.conflicts.length})
          </h4>
          {s.conflicts.map((c) => (
            <div key={c.id} className="mb-1 rounded border border-red-500/20 bg-red-500/5 px-2 py-1 text-xs text-red-300">
              <span className="mr-1 text-[10px] font-bold uppercase">
                [{c.severity}]
              </span>
              {c.description}
            </div>
          ))}
        </div>
      )}
      {s.blockers.length > 0 && (
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-orange-400">
            Blockers ({s.blockers.length})
          </h4>
          {s.blockers.map((b) => (
            <div key={b.id} className="mb-1 rounded border border-orange-500/20 bg-orange-500/5 px-2 py-1 text-xs text-orange-300">
              {b.description}
            </div>
          ))}
        </div>
      )}
      {s.highlights.length > 0 && (
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            Highlights ({s.highlights.length})
          </h4>
          {s.highlights.map((h, i) => (
            <div key={i} className="mb-1 rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-xs text-emerald-300">
              {h.description}
            </div>
          ))}
        </div>
      )}
      {s.alignmentIssues.length > 0 && (
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-yellow-400">
            Alignment Issues ({s.alignmentIssues.length})
          </h4>
          {s.alignmentIssues.map((a) => (
            <div key={a.id} className="mb-1 rounded border border-yellow-500/20 bg-yellow-500/5 px-2 py-1 text-xs text-yellow-300">
              {a.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Resolution Panel ── */
function ResolutionPanel({ meeting }: { meeting: Meeting }) {
  const r = meeting.resolutions;
  if (!r || r.decisions.length === 0) return <p className="text-xs text-[var(--text-muted)]">No decisions — clean sync.</p>;

  const actionColors: Record<string, string> = {
    create_task: "#22c55e",
    modify_task: "#3b82f6",
    escalate_to_board: "#ef4444",
    note: "#eab308",
    no_action: "#71717a",
  };

  return (
    <div className="space-y-1">
      {r.decisions.map((d, i) => (
        <div
          key={i}
          className="rounded border px-2 py-1.5 text-xs"
          style={{
            borderColor: `${actionColors[d.action] ?? "#888"}40`,
            background: `${actionColors[d.action] ?? "#888"}10`,
          }}
        >
          <span
            className="mr-1.5 inline-block rounded px-1 py-0.5 text-[9px] font-bold uppercase"
            style={{ background: `${actionColors[d.action] ?? "#888"}30`, color: actionColors[d.action] ?? "#888" }}
          >
            {d.action.replace(/_/g, " ")}
          </span>
          <span style={{ color: "var(--text-secondary)" }}>{d.decision}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Brief Panel ── */
function BriefPanel({ meeting }: { meeting: Meeting }) {
  const b = meeting.brief;
  if (!b) return <p className="text-xs text-[var(--text-muted)]">No brief generated.</p>;

  return (
    <div className="space-y-2 text-xs">
      <p style={{ color: "var(--text-primary)" }}>{b.companyStatus}</p>
      {b.teamUpdates.length > 0 && (
        <div className="space-y-1">
          {b.teamUpdates.map((u, i) => (
            <div key={i} className="flex gap-2">
              <span
                className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: ROLE_COLORS[u.agentRole] ?? "#888" }}
              />
              <div>
                <span className="font-semibold capitalize" style={{ color: ROLE_COLORS[u.agentRole] ?? "#888" }}>
                  {u.agentRole.replace(/_/g, " ")}
                </span>
                <span className="ml-1" style={{ color: "var(--text-secondary)" }}>{u.summary}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {b.activeBlockers.length > 0 && (
        <div>
          <span className="text-[10px] font-semibold uppercase text-red-400">Active Blockers: </span>
          <span className="text-red-300">{b.activeBlockers.join("; ")}</span>
        </div>
      )}
      {b.decisionsFromMeeting.length > 0 && (
        <div>
          <span className="text-[10px] font-semibold uppercase text-yellow-400">Decisions: </span>
          <span className="text-yellow-300">{b.decisionsFromMeeting.join("; ")}</span>
        </div>
      )}
    </div>
  );
}

/* ── Health Stats ── */
function HealthStats({ meeting }: { meeting: Meeting }) {
  const h = meeting.healthSnapshot;
  if (!h) return null;
  const dur = h.pipelineDurationMs;
  const durStr = dur > 60000 ? `${(dur / 60000).toFixed(1)}m` : `${(dur / 1000).toFixed(0)}s`;

  return (
    <div className="flex flex-wrap gap-3 text-[10px]">
      <Stat label="Duration" value={durStr} />
      <Stat label="Tokens" value={h.totalTokensUsed.toLocaleString()} />
      <Stat label="Contributions" value={String(h.contributionCount)} />
      <Stat label="Conflicts" value={String(h.conflictCount)} color={h.conflictCount > 0 ? "#ef4444" : undefined} />
      <Stat label="Blockers" value={String(h.blockerCount)} color={h.blockerCount > 0 ? "#f97316" : undefined} />
      <Stat label="Tasks Created" value={String(h.tasksCreated)} color={h.tasksCreated > 0 ? "#22c55e" : undefined} />
      <Stat label="Escalations" value={String(h.escalationsCreated)} color={h.escalationsCreated > 0 ? "#ef4444" : undefined} />
      <Stat label="Skipped Before" value={String(h.skippedBefore)} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="font-mono font-bold" style={{ color: color ?? "var(--text-primary)" }}>{value}</span>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

/* ── Selected Attendee Detail Panel ── */
function AttendeeDetail({ attendee, meeting }: { attendee: Attendee; meeting: Meeting }) {
  const c = attendee.contribution?.contribution;
  const color = ROLE_COLORS[attendee.role] ?? "#888";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full border-2 text-lg"
          style={{ borderColor: color, background: `${color}20` }}
        >
          {ROLE_EMOJI[attendee.role] ?? "👤"}
        </div>
        <div>
          <div className="font-semibold" style={{ color }}>{attendee.name}</div>
          <div className="text-xs capitalize" style={{ color: "var(--text-muted)" }}>
            {attendee.role.replace(/_/g, " ")}
            {attendee.isFacilitator && " · 👑 Facilitator"}
          </div>
        </div>
      </div>
      {c ? (
        <div className="space-y-2 text-xs">
          {c.whatIDid && (
            <Field label="✅ What I Did" value={c.whatIDid} />
          )}
          {c.whatImDoing && (
            <Field label="🔄 What I'm Doing" value={c.whatImDoing} />
          )}
          {c.blockers && c.blockers.trim() && (
            <Field label="🚨 Blockers" value={c.blockers} color="#ef4444" />
          )}
          {c.learnings && (
            <Field label="💡 Learnings" value={c.learnings} />
          )}
          {c.questionsForTeam && c.questionsForTeam.trim() && (
            <Field label="❓ Questions" value={c.questionsForTeam} />
          )}
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Submitted {new Date(attendee.contribution!.submittedAt).toLocaleTimeString()}
          </div>
        </div>
      ) : (
        <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
          {meeting.healthSnapshot
            ? "No contribution submitted — agent may have been unreachable."
            : "Contribution pending — agent has not yet responded."}
        </p>
      )}
    </div>
  );
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: color ?? "var(--text-muted)" }}>
        {label}
      </div>
      <p style={{ color: "var(--text-secondary)" }}>{value}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   ██  MAIN PAGE
   ═══════════════════════════════════════════════════════ */

export default function MeetingsVizPage() {
  const [snapshot, setSnapshot] = useState<CompanySnapshot | null>(null);
  const [selectedMeetingIdx, setSelectedMeetingIdx] = useState(0);
  const [selectedAttendeeId, setSelectedAttendeeId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"attendee" | "synthesis" | "resolutions" | "brief">("attendee");

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch(apiUrl("/company"), { cache: "no-store" });
        if (r.ok) setSnapshot(await r.json());
      } catch { /* ignore */ }
    }
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, []);

  const agentsById = useMemo(
    () => new Map((snapshot?.agents ?? []).map((a) => [a.id, a])),
    [snapshot?.agents],
  );

  const meetings = useMemo(
    () => [...(snapshot?.meetings ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [snapshot?.meetings],
  );

  const meeting = meetings[selectedMeetingIdx] ?? null;
  const attendees = useMemo(() => meeting ? computeAttendees(meeting, agentsById) : [], [meeting, agentsById]);
  const selectedAttendee = attendees.find((a) => a.id === selectedAttendeeId) ?? null;

  // Auto-select facilitator when meeting changes
  useEffect(() => {
    if (meeting) setSelectedAttendeeId(meeting.facilitatorAgentId);
  }, [meeting?.id]);

  if (!snapshot) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: "var(--bg-primary)" }}>
        <div className="text-center">
          <div className="mb-2 h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent mx-auto" />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Connecting to Arceus…</p>
        </div>
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: "var(--bg-primary)" }}>
        <p style={{ color: "var(--text-muted)" }}>No meetings recorded yet.</p>
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[meeting?.status ?? ""] ?? { label: meeting?.status ?? "", color: "#71717a" };

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      {/* ── Top Bar ── */}
      <header className="flex shrink-0 items-center justify-between border-b px-6 py-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-tight">Meeting Room</h1>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: `${statusInfo.color}25`, color: statusInfo.color }}
          >
            {statusInfo.label}
          </span>
          {meeting && <PhaseProgress status={meeting.status} />}
        </div>
        {/* Meeting selector */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={selectedMeetingIdx >= meetings.length - 1}
            className="rounded px-2 py-1 text-xs disabled:opacity-30"
            style={{ background: "var(--bg-tertiary)" }}
            onClick={() => setSelectedMeetingIdx((i) => Math.min(i + 1, meetings.length - 1))}
          >
            ← Older
          </button>
          <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
            {selectedMeetingIdx + 1} / {meetings.length}
          </span>
          <button
            type="button"
            disabled={selectedMeetingIdx <= 0}
            className="rounded px-2 py-1 text-xs disabled:opacity-30"
            style={{ background: "var(--bg-tertiary)" }}
            onClick={() => setSelectedMeetingIdx((i) => Math.max(i - 1, 0))}
          >
            Newer →
          </button>
        </div>
      </header>

      {/* ── Main Content ── */}
      <div className="flex min-h-0 flex-1">
        {/* ── Left: Round Table ── */}
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          {/* Ambient glow under table */}
          <div
            className="absolute rounded-full blur-3xl"
            style={{
              width: "50%",
              height: "50%",
              left: "25%",
              top: "25%",
              background: `radial-gradient(circle, ${statusInfo.color}10 0%, transparent 70%)`,
            }}
          />

          {/* The Table */}
          <div className="relative" style={{ width: "min(80vw, 600px)", height: "min(80vw, 600px)" }}>
            {/* Table surface */}
            <div
              className="absolute inset-[20%] rounded-full border-2"
              style={{
                borderColor: "var(--border)",
                background: `radial-gradient(circle at 40% 40%, var(--bg-tertiary), var(--bg-secondary))`,
                boxShadow: "0 4px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
              }}
            >
              {/* Center of table — meeting info */}
              <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
                <div className="text-2xl">
                  {meeting.type === "daily_sync" ? "☀️" : meeting.type === "escalation" ? "🚨" : "📊"}
                </div>
                <div className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
                  {meeting.type.replace(/_/g, " ")}
                </div>
                <div className="mt-1 text-sm font-semibold line-clamp-2">
                  {meeting.title}
                </div>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {new Date(meeting.createdAt).toLocaleString()}
                </div>
                {meeting.completedAt && (
                  <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    Duration: {((new Date(meeting.completedAt).getTime() - new Date(meeting.createdAt).getTime()) / 60000).toFixed(1)}m
                  </div>
                )}
              </div>
            </div>

            {/* Connection lines from attendees to table center */}
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              {attendees.map((a) => (
                <line
                  key={a.id}
                  x1={a.x}
                  y1={a.y}
                  x2={50}
                  y2={50}
                  stroke={ROLE_COLORS[a.role] ?? "#888"}
                  strokeOpacity={a.id === selectedAttendeeId ? 0.4 : 0.1}
                  strokeWidth={a.id === selectedAttendeeId ? 0.5 : 0.2}
                  strokeDasharray={a.contribution ? "none" : "1,1"}
                />
              ))}
            </svg>

            {/* Speech bubbles */}
            {attendees.map((a) => (
              <ContributionBubble
                key={`bubble-${a.id}`}
                attendee={a}
                selected={a.id === selectedAttendeeId}
                onSelect={() => { setSelectedAttendeeId(a.id); setDetailTab("attendee"); }}
              />
            ))}

            {/* Seat avatars */}
            {attendees.map((a) => (
              <SeatAvatar
                key={a.id}
                attendee={a}
                selected={a.id === selectedAttendeeId}
                onSelect={() => { setSelectedAttendeeId(a.id); setDetailTab("attendee"); }}
              />
            ))}
          </div>
        </div>

        {/* ── Right Panel ── */}
        <aside
          className="flex w-[360px] shrink-0 flex-col border-l overflow-y-auto"
          style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}
        >
          {/* Tabs */}
          <div className="flex shrink-0 border-b" style={{ borderColor: "var(--border)" }}>
            {(["attendee", "synthesis", "resolutions", "brief"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className="flex-1 px-2 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition-colors"
                style={{
                  color: detailTab === tab ? "var(--text-primary)" : "var(--text-muted)",
                  borderBottom: detailTab === tab ? "2px solid var(--text-primary)" : "2px solid transparent",
                }}
                onClick={() => setDetailTab(tab)}
              >
                {tab === "attendee" ? "👤 Agent" : tab === "synthesis" ? "🔍 Synthesis" : tab === "resolutions" ? "⚖️ Resolve" : "📋 Brief"}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-4">
            {detailTab === "attendee" && selectedAttendee && (
              <AttendeeDetail attendee={selectedAttendee} meeting={meeting} />
            )}
            {detailTab === "attendee" && !selectedAttendee && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Click an attendee to see their update.</p>
            )}
            {detailTab === "synthesis" && meeting && <SynthesisPanel meeting={meeting} />}
            {detailTab === "resolutions" && meeting && <ResolutionPanel meeting={meeting} />}
            {detailTab === "brief" && meeting && <BriefPanel meeting={meeting} />}
          </div>

          {/* Health stats at bottom */}
          {meeting?.healthSnapshot && (
            <div className="shrink-0 border-t p-3" style={{ borderColor: "var(--border)", background: "var(--bg-primary)" }}>
              <HealthStats meeting={meeting} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
