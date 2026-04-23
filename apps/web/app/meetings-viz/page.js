"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState, useMemo } from "react";
import { apiUrl } from "../../lib/api";
/* ── Role → color map (matches globals.css role vars) ── */
const ROLE_COLORS = {
    ceo: "#eab308",
    cto: "#3b82f6",
    pm: "#8b5cf6",
    developer: "#22c55e",
    tester: "#f97316",
    ui_designer: "#ec4899",
    marketing: "#06b6d4",
    skills_lead: "#a78bfa",
};
const ROLE_EMOJI = {
    ceo: "👔",
    cto: "🧠",
    pm: "📋",
    developer: "💻",
    tester: "🧪",
    ui_designer: "🎨",
    marketing: "📢",
    skills_lead: "⚡",
};
const STATUS_LABELS = {
    scheduled: { label: "Scheduled", color: "#71717a" },
    collecting: { label: "Collecting Updates", color: "#3b82f6" },
    synthesizing: { label: "Synthesizing", color: "#8b5cf6" },
    resolving: { label: "Resolving", color: "#f59e0b" },
    executing: { label: "Executing Decisions", color: "#f97316" },
    learning: { label: "Extracting Learnings", color: "#06b6d4" },
    completed: { label: "Completed", color: "#22c55e" },
    skipped: { label: "Skipped", color: "#71717a" },
};
function computeAttendees(meeting, agentsById) {
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
const PHASES = ["scheduled", "collecting", "synthesizing", "resolving", "executing", "learning", "completed"];
function PhaseProgress({ status }) {
    const currentIdx = PHASES.indexOf(status);
    return (_jsx("div", { className: "flex items-center gap-1", children: PHASES.map((phase, i) => {
            const done = i <= currentIdx;
            const active = i === currentIdx;
            const info = STATUS_LABELS[phase] ?? { label: phase, color: "#71717a" };
            return (_jsx("div", { className: "flex items-center gap-1", children: _jsx("div", { className: `h-2 rounded-full transition-all ${active ? "w-8" : "w-4"}`, style: {
                        background: done ? info.color : "rgba(255,255,255,0.1)",
                        boxShadow: active ? `0 0 8px ${info.color}80` : "none",
                    }, title: info.label }) }, phase));
        }) }));
}
/* ── Contribution Bubble (speech bubble from attendee) ── */
function ContributionBubble({ attendee, selected, onSelect }) {
    const c = attendee.contribution?.contribution;
    if (!c)
        return null;
    const color = ROLE_COLORS[attendee.role] ?? "#888";
    const hasBlocker = c.blockers && c.blockers.trim().length > 0;
    return (_jsxs("div", { className: `absolute z-30 max-w-[220px] rounded-lg border px-3 py-2 text-xs transition-all cursor-pointer
        ${selected ? "scale-105 shadow-lg" : "opacity-80 hover:opacity-100 hover:scale-[1.02]"}
      `, style: {
            left: `${attendee.x}%`,
            top: `${attendee.y}%`,
            transform: "translate(-50%, -140%)",
            borderColor: selected ? color : "rgba(255,255,255,0.1)",
            background: selected ? `${color}18` : "rgba(30,33,41,0.95)",
        }, onClick: onSelect, children: [hasBlocker && (_jsxs("div", { className: "mb-1 flex items-center gap-1 text-[10px] font-semibold text-red-400", children: [_jsx("span", { children: "\uD83D\uDEA8" }), " BLOCKER"] })), _jsx("p", { className: "line-clamp-3 leading-relaxed", style: { color: "var(--text-secondary)" }, children: c.whatImDoing || c.whatIDid || "No update" })] }));
}
/* ── Avatar at table ── */
function SeatAvatar({ attendee, selected, onSelect }) {
    const color = ROLE_COLORS[attendee.role] ?? "#888";
    const emoji = ROLE_EMOJI[attendee.role] ?? "👤";
    const hasContribution = !!attendee.contribution;
    return (_jsxs("button", { type: "button", className: "absolute z-20 flex flex-col items-center gap-1 transition-transform", style: {
            left: `${attendee.x}%`,
            top: `${attendee.y}%`,
            transform: `translate(-50%, -50%) ${selected ? "scale(1.15)" : "scale(1)"}`,
        }, onClick: onSelect, children: [_jsxs("div", { className: "relative flex h-12 w-12 items-center justify-center rounded-full border-2 text-lg transition-shadow", style: {
                    borderColor: color,
                    background: `${color}20`,
                    boxShadow: selected
                        ? `0 0 20px ${color}60, 0 0 40px ${color}20`
                        : hasContribution
                            ? `0 0 8px ${color}30`
                            : "none",
                }, children: [_jsx("span", { children: emoji }), attendee.isFacilitator && (_jsx("span", { className: "absolute -top-3 text-xs", children: "\uD83D\uDC51" })), hasContribution && (_jsx("span", { className: "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2", style: { borderColor: "var(--bg-primary)", background: "#22c55e" } })), !hasContribution && (_jsx("span", { className: "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2", style: { borderColor: "var(--bg-primary)", background: "#71717a" } }))] }), _jsx("span", { className: "whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider", style: { color }, children: attendee.name }), _jsx("span", { className: "text-[9px] capitalize", style: { color: "var(--text-muted)" }, children: attendee.role.replace(/_/g, " ") })] }));
}
/* ── Synthesis Panel ── */
function SynthesisPanel({ meeting }) {
    const s = meeting.synthesis;
    if (!s)
        return _jsx("p", { className: "text-xs text-[var(--text-muted)]", children: "No synthesis data." });
    return (_jsxs("div", { className: "space-y-3", children: [s.conflicts.length > 0 && (_jsxs("div", { children: [_jsxs("h4", { className: "mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-400", children: ["Conflicts (", s.conflicts.length, ")"] }), s.conflicts.map((c) => (_jsxs("div", { className: "mb-1 rounded border border-red-500/20 bg-red-500/5 px-2 py-1 text-xs text-red-300", children: [_jsxs("span", { className: "mr-1 text-[10px] font-bold uppercase", children: ["[", c.severity, "]"] }), c.description] }, c.id)))] })), s.blockers.length > 0 && (_jsxs("div", { children: [_jsxs("h4", { className: "mb-1 text-[10px] font-semibold uppercase tracking-wider text-orange-400", children: ["Blockers (", s.blockers.length, ")"] }), s.blockers.map((b) => (_jsx("div", { className: "mb-1 rounded border border-orange-500/20 bg-orange-500/5 px-2 py-1 text-xs text-orange-300", children: b.description }, b.id)))] })), s.highlights.length > 0 && (_jsxs("div", { children: [_jsxs("h4", { className: "mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400", children: ["Highlights (", s.highlights.length, ")"] }), s.highlights.map((h, i) => (_jsx("div", { className: "mb-1 rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-xs text-emerald-300", children: h.description }, i)))] })), s.alignmentIssues.length > 0 && (_jsxs("div", { children: [_jsxs("h4", { className: "mb-1 text-[10px] font-semibold uppercase tracking-wider text-yellow-400", children: ["Alignment Issues (", s.alignmentIssues.length, ")"] }), s.alignmentIssues.map((a) => (_jsx("div", { className: "mb-1 rounded border border-yellow-500/20 bg-yellow-500/5 px-2 py-1 text-xs text-yellow-300", children: a.description }, a.id)))] }))] }));
}
/* ── Resolution Panel ── */
function ResolutionPanel({ meeting }) {
    const r = meeting.resolutions;
    if (!r || r.decisions.length === 0)
        return _jsx("p", { className: "text-xs text-[var(--text-muted)]", children: "No decisions \u2014 clean sync." });
    const actionColors = {
        create_task: "#22c55e",
        modify_task: "#3b82f6",
        escalate_to_board: "#ef4444",
        note: "#eab308",
        no_action: "#71717a",
    };
    return (_jsx("div", { className: "space-y-1", children: r.decisions.map((d, i) => (_jsxs("div", { className: "rounded border px-2 py-1.5 text-xs", style: {
                borderColor: `${actionColors[d.action] ?? "#888"}40`,
                background: `${actionColors[d.action] ?? "#888"}10`,
            }, children: [_jsx("span", { className: "mr-1.5 inline-block rounded px-1 py-0.5 text-[9px] font-bold uppercase", style: { background: `${actionColors[d.action] ?? "#888"}30`, color: actionColors[d.action] ?? "#888" }, children: d.action.replace(/_/g, " ") }), _jsx("span", { style: { color: "var(--text-secondary)" }, children: d.decision })] }, i))) }));
}
/* ── Brief Panel ── */
function BriefPanel({ meeting }) {
    const b = meeting.brief;
    if (!b)
        return _jsx("p", { className: "text-xs text-[var(--text-muted)]", children: "No brief generated." });
    return (_jsxs("div", { className: "space-y-2 text-xs", children: [_jsx("p", { style: { color: "var(--text-primary)" }, children: b.companyStatus }), b.teamUpdates.length > 0 && (_jsx("div", { className: "space-y-1", children: b.teamUpdates.map((u, i) => (_jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full", style: { background: ROLE_COLORS[u.agentRole] ?? "#888" } }), _jsxs("div", { children: [_jsx("span", { className: "font-semibold capitalize", style: { color: ROLE_COLORS[u.agentRole] ?? "#888" }, children: u.agentRole.replace(/_/g, " ") }), _jsx("span", { className: "ml-1", style: { color: "var(--text-secondary)" }, children: u.summary })] })] }, i))) })), b.activeBlockers.length > 0 && (_jsxs("div", { children: [_jsx("span", { className: "text-[10px] font-semibold uppercase text-red-400", children: "Active Blockers: " }), _jsx("span", { className: "text-red-300", children: b.activeBlockers.join("; ") })] })), b.decisionsFromMeeting.length > 0 && (_jsxs("div", { children: [_jsx("span", { className: "text-[10px] font-semibold uppercase text-yellow-400", children: "Decisions: " }), _jsx("span", { className: "text-yellow-300", children: b.decisionsFromMeeting.join("; ") })] }))] }));
}
/* ── Health Stats ── */
function HealthStats({ meeting }) {
    const h = meeting.healthSnapshot;
    if (!h)
        return null;
    const dur = h.pipelineDurationMs;
    const durStr = dur > 60000 ? `${(dur / 60000).toFixed(1)}m` : `${(dur / 1000).toFixed(0)}s`;
    return (_jsxs("div", { className: "flex flex-wrap gap-3 text-[10px]", children: [_jsx(Stat, { label: "Duration", value: durStr }), _jsx(Stat, { label: "Tokens", value: h.totalTokensUsed.toLocaleString() }), _jsx(Stat, { label: "Contributions", value: String(h.contributionCount) }), _jsx(Stat, { label: "Conflicts", value: String(h.conflictCount), color: h.conflictCount > 0 ? "#ef4444" : undefined }), _jsx(Stat, { label: "Blockers", value: String(h.blockerCount), color: h.blockerCount > 0 ? "#f97316" : undefined }), _jsx(Stat, { label: "Tasks Created", value: String(h.tasksCreated), color: h.tasksCreated > 0 ? "#22c55e" : undefined }), _jsx(Stat, { label: "Escalations", value: String(h.escalationsCreated), color: h.escalationsCreated > 0 ? "#ef4444" : undefined }), _jsx(Stat, { label: "Skipped Before", value: String(h.skippedBefore) })] }));
}
function Stat({ label, value, color }) {
    return (_jsxs("div", { className: "flex flex-col items-center", children: [_jsx("span", { className: "font-mono font-bold", style: { color: color ?? "var(--text-primary)" }, children: value }), _jsx("span", { style: { color: "var(--text-muted)" }, children: label })] }));
}
/* ── Selected Attendee Detail Panel ── */
function AttendeeDetail({ attendee, meeting }) {
    const c = attendee.contribution?.contribution;
    const color = ROLE_COLORS[attendee.role] ?? "#888";
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "flex h-10 w-10 items-center justify-center rounded-full border-2 text-lg", style: { borderColor: color, background: `${color}20` }, children: ROLE_EMOJI[attendee.role] ?? "👤" }), _jsxs("div", { children: [_jsx("div", { className: "font-semibold", style: { color }, children: attendee.name }), _jsxs("div", { className: "text-xs capitalize", style: { color: "var(--text-muted)" }, children: [attendee.role.replace(/_/g, " "), attendee.isFacilitator && " · 👑 Facilitator"] })] })] }), c ? (_jsxs("div", { className: "space-y-2 text-xs", children: [c.whatIDid && (_jsx(Field, { label: "\u2705 What I Did", value: c.whatIDid })), c.whatImDoing && (_jsx(Field, { label: "\uD83D\uDD04 What I'm Doing", value: c.whatImDoing })), c.blockers && c.blockers.trim() && (_jsx(Field, { label: "\uD83D\uDEA8 Blockers", value: c.blockers, color: "#ef4444" })), c.learnings && (_jsx(Field, { label: "\uD83D\uDCA1 Learnings", value: c.learnings })), c.questionsForTeam && c.questionsForTeam.trim() && (_jsx(Field, { label: "\u2753 Questions", value: c.questionsForTeam })), _jsxs("div", { className: "text-[10px]", style: { color: "var(--text-muted)" }, children: ["Submitted ", new Date(attendee.contribution.submittedAt).toLocaleTimeString()] })] })) : (_jsx("p", { className: "text-xs italic", style: { color: "var(--text-muted)" }, children: meeting.healthSnapshot
                    ? "No contribution submitted — agent may have been unreachable."
                    : "Contribution pending — agent has not yet responded." }))] }));
}
function Field({ label, value, color }) {
    return (_jsxs("div", { children: [_jsx("div", { className: "mb-0.5 text-[10px] font-semibold uppercase tracking-wider", style: { color: color ?? "var(--text-muted)" }, children: label }), _jsx("p", { style: { color: "var(--text-secondary)" }, children: value })] }));
}
/* ═══════════════════════════════════════════════════════
   ██  MAIN PAGE
   ═══════════════════════════════════════════════════════ */
export default function MeetingsVizPage() {
    const [snapshot, setSnapshot] = useState(null);
    const [selectedMeetingIdx, setSelectedMeetingIdx] = useState(0);
    const [selectedAttendeeId, setSelectedAttendeeId] = useState(null);
    const [detailTab, setDetailTab] = useState("attendee");
    useEffect(() => {
        async function load() {
            try {
                const r = await fetch(apiUrl("/company"), { cache: "no-store" });
                if (r.ok)
                    setSnapshot(await r.json());
            }
            catch { /* ignore */ }
        }
        void load();
        const id = setInterval(() => void load(), 3000);
        return () => clearInterval(id);
    }, []);
    const agentsById = useMemo(() => new Map((snapshot?.agents ?? []).map((a) => [a.id, a])), [snapshot?.agents]);
    const meetings = useMemo(() => [...(snapshot?.meetings ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [snapshot?.meetings]);
    const meeting = meetings[selectedMeetingIdx] ?? null;
    const attendees = useMemo(() => meeting ? computeAttendees(meeting, agentsById) : [], [meeting, agentsById]);
    const selectedAttendee = attendees.find((a) => a.id === selectedAttendeeId) ?? null;
    // Auto-select facilitator when meeting changes
    useEffect(() => {
        if (meeting)
            setSelectedAttendeeId(meeting.facilitatorAgentId);
    }, [meeting?.id]);
    if (!snapshot) {
        return (_jsx("div", { className: "flex h-screen items-center justify-center", style: { background: "var(--bg-primary)" }, children: _jsxs("div", { className: "text-center", children: [_jsx("div", { className: "mb-2 h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent mx-auto" }), _jsx("p", { className: "text-sm", style: { color: "var(--text-muted)" }, children: "Connecting to Arceus\u2026" })] }) }));
    }
    if (meetings.length === 0) {
        return (_jsx("div", { className: "flex h-screen items-center justify-center", style: { background: "var(--bg-primary)" }, children: _jsx("p", { style: { color: "var(--text-muted)" }, children: "No meetings recorded yet." }) }));
    }
    const statusInfo = STATUS_LABELS[meeting?.status ?? ""] ?? { label: meeting?.status ?? "", color: "#71717a" };
    return (_jsxs("div", { className: "flex h-screen flex-col overflow-hidden", style: { background: "var(--bg-primary)", color: "var(--text-primary)" }, children: [_jsxs("header", { className: "flex shrink-0 items-center justify-between border-b px-6 py-3", style: { borderColor: "var(--border)" }, children: [_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("h1", { className: "text-lg font-bold tracking-tight", children: "Meeting Room" }), _jsx("span", { className: "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", style: { background: `${statusInfo.color}25`, color: statusInfo.color }, children: statusInfo.label }), meeting && _jsx(PhaseProgress, { status: meeting.status })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { type: "button", disabled: selectedMeetingIdx >= meetings.length - 1, className: "rounded px-2 py-1 text-xs disabled:opacity-30", style: { background: "var(--bg-tertiary)" }, onClick: () => setSelectedMeetingIdx((i) => Math.min(i + 1, meetings.length - 1)), children: "\u2190 Older" }), _jsxs("span", { className: "text-xs font-mono", style: { color: "var(--text-muted)" }, children: [selectedMeetingIdx + 1, " / ", meetings.length] }), _jsx("button", { type: "button", disabled: selectedMeetingIdx <= 0, className: "rounded px-2 py-1 text-xs disabled:opacity-30", style: { background: "var(--bg-tertiary)" }, onClick: () => setSelectedMeetingIdx((i) => Math.max(i - 1, 0)), children: "Newer \u2192" })] })] }), _jsxs("div", { className: "flex min-h-0 flex-1", children: [_jsxs("div", { className: "relative flex flex-1 items-center justify-center overflow-hidden", children: [_jsx("div", { className: "absolute rounded-full blur-3xl", style: {
                                    width: "50%",
                                    height: "50%",
                                    left: "25%",
                                    top: "25%",
                                    background: `radial-gradient(circle, ${statusInfo.color}10 0%, transparent 70%)`,
                                } }), _jsxs("div", { className: "relative", style: { width: "min(80vw, 600px)", height: "min(80vw, 600px)" }, children: [_jsx("div", { className: "absolute inset-[20%] rounded-full border-2", style: {
                                            borderColor: "var(--border)",
                                            background: `radial-gradient(circle at 40% 40%, var(--bg-tertiary), var(--bg-secondary))`,
                                            boxShadow: "0 4px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
                                        }, children: _jsxs("div", { className: "flex h-full flex-col items-center justify-center gap-1 px-6 text-center", children: [_jsx("div", { className: "text-2xl", children: meeting.type === "daily_sync" ? "☀️" : meeting.type === "escalation" ? "🚨" : "📊" }), _jsx("div", { className: "text-xs font-bold uppercase tracking-widest", style: { color: "var(--text-muted)" }, children: meeting.type.replace(/_/g, " ") }), _jsx("div", { className: "mt-1 text-sm font-semibold line-clamp-2", children: meeting.title }), _jsx("div", { className: "text-[10px]", style: { color: "var(--text-muted)" }, children: new Date(meeting.createdAt).toLocaleString() }), meeting.completedAt && (_jsxs("div", { className: "text-[10px]", style: { color: "var(--text-muted)" }, children: ["Duration: ", ((new Date(meeting.completedAt).getTime() - new Date(meeting.createdAt).getTime()) / 60000).toFixed(1), "m"] }))] }) }), _jsx("svg", { className: "absolute inset-0 h-full w-full", viewBox: "0 0 100 100", xmlns: "http://www.w3.org/2000/svg", children: attendees.map((a) => (_jsx("line", { x1: a.x, y1: a.y, x2: 50, y2: 50, stroke: ROLE_COLORS[a.role] ?? "#888", strokeOpacity: a.id === selectedAttendeeId ? 0.4 : 0.1, strokeWidth: a.id === selectedAttendeeId ? 0.5 : 0.2, strokeDasharray: a.contribution ? "none" : "1,1" }, a.id))) }), attendees.map((a) => (_jsx(ContributionBubble, { attendee: a, selected: a.id === selectedAttendeeId, onSelect: () => { setSelectedAttendeeId(a.id); setDetailTab("attendee"); } }, `bubble-${a.id}`))), attendees.map((a) => (_jsx(SeatAvatar, { attendee: a, selected: a.id === selectedAttendeeId, onSelect: () => { setSelectedAttendeeId(a.id); setDetailTab("attendee"); } }, a.id)))] })] }), _jsxs("aside", { className: "flex w-[360px] shrink-0 flex-col border-l overflow-y-auto", style: { borderColor: "var(--border)", background: "var(--bg-secondary)" }, children: [_jsx("div", { className: "flex shrink-0 border-b", style: { borderColor: "var(--border)" }, children: ["attendee", "synthesis", "resolutions", "brief"].map((tab) => (_jsx("button", { type: "button", className: "flex-1 px-2 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition-colors", style: {
                                        color: detailTab === tab ? "var(--text-primary)" : "var(--text-muted)",
                                        borderBottom: detailTab === tab ? "2px solid var(--text-primary)" : "2px solid transparent",
                                    }, onClick: () => setDetailTab(tab), children: tab === "attendee" ? "👤 Agent" : tab === "synthesis" ? "🔍 Synthesis" : tab === "resolutions" ? "⚖️ Resolve" : "📋 Brief" }, tab))) }), _jsxs("div", { className: "flex-1 overflow-y-auto p-4", children: [detailTab === "attendee" && selectedAttendee && (_jsx(AttendeeDetail, { attendee: selectedAttendee, meeting: meeting })), detailTab === "attendee" && !selectedAttendee && (_jsx("p", { className: "text-xs", style: { color: "var(--text-muted)" }, children: "Click an attendee to see their update." })), detailTab === "synthesis" && meeting && _jsx(SynthesisPanel, { meeting: meeting }), detailTab === "resolutions" && meeting && _jsx(ResolutionPanel, { meeting: meeting }), detailTab === "brief" && meeting && _jsx(BriefPanel, { meeting: meeting })] }), meeting?.healthSnapshot && (_jsx("div", { className: "shrink-0 border-t p-3", style: { borderColor: "var(--border)", background: "var(--bg-primary)" }, children: _jsx(HealthStats, { meeting: meeting }) }))] })] })] }));
}
