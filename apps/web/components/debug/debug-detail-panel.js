"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Badge } from "../ui/badge";
const DECISION_COLORS = {
    gate_verdict: "bg-blue-100 text-blue-700",
    router_transition: "bg-purple-100 text-purple-700",
    escalation: "bg-red-100 text-red-700",
    cto_review: "bg-indigo-100 text-indigo-700",
    task_completion: "bg-green-100 text-green-700",
    prune_decision: "bg-yellow-100 text-yellow-700",
    preview_validation: "bg-cyan-100 text-cyan-700",
    rework_decision: "bg-orange-100 text-orange-700",
    auto_approve: "bg-gray-100 text-gray-700",
    sprint_planning: "bg-amber-100 text-amber-700",
};
/** Dynamic = LLM decides at runtime; Hardcoded = deterministic code path. */
const DYNAMIC_DECISIONS = new Set([
    "router_transition", // LLM proposes task transitions
    "cto_review", // LLM evaluates code quality
    "preview_validation", // LLM validates rendered output vs spec
    "prune_decision", // LLM decides which tasks are already satisfied
    "task_completion", // LLM checks sprint completion criteria
    "sprint_planning", // LLM proposes sprint tasks (Sprint N+1)
]);
function isLlmDecision(type) {
    return DYNAMIC_DECISIONS.has(type);
}
const FILE_ACTION_COLORS = {
    created: "text-emerald-600",
    modified: "text-blue-600",
    deleted: "text-red-600",
};
function formatTime(iso) {
    if (!iso)
        return "—";
    return new Date(iso).toLocaleTimeString();
}
function formatDuration(ms) {
    if (ms == null)
        return "—";
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}
export function DebugDetailPanel({ node, onClose }) {
    const [tab, setTab] = useState("overview");
    const meetings = node.meetings ?? [];
    const memoryWrites = node.memoryWrites ?? [];
    const tabs = [
        { key: "overview", label: "Overview" },
        { key: "beats", label: "Beats", count: node.beats.length },
        { key: "decisions", label: "Decisions", count: node.decisions.length },
        { key: "files", label: "Files", count: node.fileChanges.length },
    ];
    return (_jsxs("div", { className: "border-t border-gray-200 bg-white", children: [_jsxs("div", { className: "flex items-center justify-between px-6 py-3 border-b border-gray-100", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-base font-semibold text-gray-900", children: node.title }), _jsx(Badge, { variant: "secondary", className: "text-xs uppercase tracking-wide", children: node.kind.replace(/_/g, " ") }), _jsx(Badge, { variant: "outline", className: "text-xs uppercase tracking-wide", children: node.assignedRole })] }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-lg px-1", children: "\u2715" })] }), _jsx("div", { className: "flex border-b border-gray-100 px-2", children: tabs.map((t) => (_jsxs("button", { onClick: () => setTab(t.key), className: `px-5 py-2.5 text-sm font-medium transition-colors ${tab === t.key
                        ? "border-b-2 border-blue-500 text-blue-600"
                        : "text-gray-500 hover:text-gray-700"}`, children: [t.label, t.count != null && t.count > 0 && (_jsxs("span", { className: "ml-1.5 text-xs text-gray-400", children: ["(", t.count, ")"] }))] }, t.key))) }), _jsxs("div", { className: "p-6 max-h-[340px] overflow-y-auto text-sm", children: [tab === "overview" && _jsx(OverviewTab, { node: node }), tab === "beats" && _jsx(BeatsTab, { beats: node.beats }), tab === "decisions" && _jsx(DecisionsTab, { decisions: node.decisions }), tab === "files" && _jsx(FilesTab, { files: node.fileChanges })] }), (meetings.length > 0 || memoryWrites.length > 0) && (_jsxs("div", { className: "border-t border-gray-100 p-6 max-h-[260px] overflow-y-auto space-y-4", children: [meetings.length > 0 && (_jsx(MeetingsBlock, { meetings: meetings, memoryWrites: memoryWrites })), memoryWrites.filter((w) => !w.meetingId).length > 0 && (_jsx(MemoryWritesBlock, { label: "Task", entries: memoryWrites.filter((w) => !w.meetingId) }))] }))] }));
}
function OverviewTab({ node }) {
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "grid grid-cols-2 gap-x-8 gap-y-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5", children: "Status" }), _jsx("div", { className: "text-sm font-semibold text-gray-800 capitalize", children: node.status.replace(/_/g, " ") })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5", children: "Role" }), _jsx("div", { className: "text-sm font-semibold text-gray-800 capitalize", children: node.assignedRole.replace(/_/g, " ") })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5", children: "Started" }), _jsx("div", { className: "text-sm text-gray-700", children: formatTime(node.startedAt) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5", children: "Completed" }), _jsx("div", { className: "text-sm text-gray-700", children: formatTime(node.completedAt) })] })] }), node.inputArtifactIds.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5", children: "Input Artifacts" }), _jsx("ul", { className: "space-y-1", children: node.inputArtifactIds.map((id) => (_jsxs("li", { className: "text-sm text-gray-600 font-mono", children: ["\u2022 ", id] }, id))) })] })), node.outputArtifactIds.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5", children: "Output Artifacts" }), _jsx("ul", { className: "space-y-1", children: node.outputArtifactIds.map((id) => (_jsxs("li", { className: "text-sm text-gray-600 font-mono", children: ["\u2022 ", id] }, id))) })] })), node.statusHistory.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5", children: "Status History" }), _jsx("div", { className: "space-y-1.5", children: node.statusHistory.map((t, i) => (_jsxs("div", { className: "flex items-center gap-2.5 text-sm", children: [_jsx("span", { className: "text-gray-400 tabular-nums", children: formatTime(t.timestamp) }), _jsx("span", { className: "text-gray-500", children: t.from }), _jsx("span", { className: "text-gray-400", children: "\u2192" }), _jsx("span", { className: "font-medium text-gray-800", children: t.to }), _jsxs("span", { className: "text-gray-400", children: ["by ", t.triggeredBy] })] }, i))) })] })), node.stateDiff && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5", children: "State Diff" }), node.stateDiff.taskChanges.map((c, i) => (_jsxs("div", { className: "text-sm font-mono", children: [_jsxs("span", { className: "text-gray-400", children: [c.field, ":"] }), " ", c.before ?? "null", " \u2192 ", c.after ?? "null"] }, i))), node.stateDiff.sprintChanges.map((c, i) => (_jsxs("div", { className: "text-sm font-mono", children: [_jsxs("span", { className: "text-gray-400", children: ["sprint.", c.field, ":"] }), " ", c.before ?? "null", " \u2192 ", c.after ?? "null"] }, i)))] })), node.reworkGroup && (_jsxs("div", { children: [_jsxs("div", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5", children: ["Rework (", node.reworkGroup.iterations.length, "/", node.reworkGroup.maxCycles, " cycles)", node.reworkGroup.escalated && _jsx("span", { className: "text-red-500 font-bold ml-2", children: "ESCALATED" })] }), _jsx("div", { className: "space-y-1.5", children: node.reworkGroup.iterations.map((it, i) => (_jsxs("div", { className: "flex items-center gap-2.5 text-sm", children: [_jsxs("span", { className: "font-medium text-gray-700", children: ["Cycle ", it.cycle] }), _jsx("span", { className: it.verdict === "pass" ? "text-emerald-600 font-semibold" : it.verdict === "fail" ? "text-red-600 font-semibold" : "text-gray-600", children: it.verdict }), _jsx("span", { className: "text-gray-400 truncate", children: it.reason })] }, i))) })] }))] }));
}
function BeatsTab({ beats }) {
    const [expanded, setExpanded] = useState(null);
    if (beats.length === 0)
        return _jsx("div", { className: "text-gray-400 text-sm", children: "No beats recorded." });
    return (_jsx("div", { className: "space-y-2.5", children: beats.map((beat) => (_jsxs("div", { className: "border border-gray-200 rounded-lg p-3", children: [_jsxs("button", { className: "w-full flex items-center justify-between text-left", onClick: () => setExpanded(expanded === beat.beatId ? null : beat.beatId), children: [_jsxs("div", { className: "flex items-center gap-2.5", children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${beat.status === "completed" ? "bg-emerald-500" : beat.status === "failed" ? "bg-red-500" : "bg-blue-500 animate-pulse"}` }), _jsx("span", { className: "font-semibold text-sm text-gray-800", children: beat.action }), _jsx("span", { className: "text-sm text-gray-400", children: beat.agentRole })] }), _jsxs("div", { className: "flex items-center gap-3 text-sm text-gray-400", children: [_jsx("span", { children: formatDuration(beat.durationMs) }), beat.toolCalls.length > 0 && _jsxs("span", { children: [beat.toolCalls.length, " tools"] }), _jsx("span", { className: "text-xs", children: expanded === beat.beatId ? "▲" : "▼" })] })] }), expanded === beat.beatId && (_jsxs("div", { className: "mt-3 pl-4 border-l-2 border-gray-200 space-y-3", children: [beat.outputSummary && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-1", children: "Output" }), _jsx("div", { className: "text-sm text-gray-600 whitespace-pre-wrap", children: beat.outputSummary })] })), beat.toolCalls.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-1", children: "Tool Calls" }), _jsx("div", { className: "space-y-1", children: beat.toolCalls.map((tc, i) => (_jsxs("div", { className: "flex items-center gap-2.5 text-sm", children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${tc.status === "completed" ? "bg-emerald-500" : tc.status === "error" ? "bg-red-500" : "bg-blue-500"}` }), _jsx("span", { className: "font-mono text-gray-700", children: tc.name }), tc.durationMs != null && _jsx("span", { className: "text-gray-400", children: formatDuration(tc.durationMs) }), tc.summary && _jsx("span", { className: "text-gray-400 truncate", children: tc.summary })] }, i))) })] }))] }))] }, beat.beatId))) }));
}
function DecisionsTab({ decisions }) {
    if (decisions.length === 0)
        return _jsx("div", { className: "text-gray-400 text-sm", children: "No decisions recorded." });
    return (_jsx("div", { className: "space-y-3", children: decisions.map((d) => {
            const dynamic = isLlmDecision(d.type);
            return (_jsxs("div", { className: `border rounded-lg p-3 ${dynamic ? "border-l-4 border-l-violet-400 border-gray-200" : "border-l-4 border-l-gray-300 border-gray-200"}`, children: [_jsxs("div", { className: "flex items-center gap-2.5 mb-1.5", children: [_jsx("span", { className: `text-xs font-semibold px-2 py-0.5 rounded-full ${DECISION_COLORS[d.type] ?? "bg-gray-100 text-gray-700"}`, children: d.type.replace(/_/g, " ") }), _jsx("span", { className: `text-[0.65rem] font-bold px-1.5 py-0.5 rounded ${dynamic ? "bg-violet-100 text-violet-700" : "bg-gray-100 text-gray-500"}`, children: dynamic ? "LLM" : "CODE" }), _jsx("span", { className: "text-xs text-gray-400", children: formatTime(d.timestamp) }), _jsxs("span", { className: "text-xs text-gray-400", children: ["by ", d.sourceRole] })] }), _jsx("div", { className: "text-sm font-medium text-gray-800 mb-1", children: d.decision }), _jsx("div", { className: "text-sm text-gray-500", children: d.reasoning }), d.confidence != null && (_jsxs("div", { className: "mt-2 flex items-center gap-2", children: [_jsx("span", { className: "text-xs text-gray-400", children: "Confidence:" }), _jsx("div", { className: "w-20 h-2 bg-gray-100 rounded-full", children: _jsx("div", { className: "h-full bg-blue-500 rounded-full", style: { width: `${Math.round(d.confidence * 100)}%` } }) }), _jsxs("span", { className: "text-xs text-gray-500 font-medium", children: [Math.round(d.confidence * 100), "%"] })] })), d.alternatives && d.alternatives.length > 0 && (_jsxs("div", { className: "mt-1.5 text-xs text-gray-400", children: ["Alternatives: ", d.alternatives.join(", ")] }))] }, d.id));
        }) }));
}
function FilesTab({ files }) {
    if (files.length === 0)
        return _jsx("div", { className: "text-gray-400 text-sm", children: "No file changes recorded." });
    return (_jsx("div", { className: "space-y-1", children: files.map((f, i) => (_jsxs("div", { className: "flex items-center gap-3 text-sm font-mono py-0.5", children: [_jsx("span", { className: `font-bold w-4 text-center shrink-0 ${FILE_ACTION_COLORS[f.action] ?? "text-gray-600"}`, children: f.action === "created" ? "A" : f.action === "modified" ? "M" : "D" }), _jsx("span", { className: "truncate text-gray-700", children: f.path }), f.linesChanged != null && _jsxs("span", { className: "text-gray-400 shrink-0", children: ["\u00B1", f.linesChanged] })] }, i))) }));
}
const CEREMONY_COLORS = {
    kickoff: "bg-green-100 text-green-700",
    handoff: "bg-blue-100 text-blue-700",
    cto_approval: "bg-indigo-100 text-indigo-700",
    board_approval: "bg-purple-100 text-purple-700",
    retrospective: "bg-amber-100 text-amber-700",
};
const TIER_COLORS = {
    static: "bg-gray-100 text-gray-700",
    dynamic: "bg-blue-100 text-blue-700",
    procedural: "bg-green-100 text-green-700",
    priming: "bg-purple-100 text-purple-700",
};
/** Compact memory-write list with a down-arrow connector from the source block. */
function MemoryWritesBlock({ label, entries }) {
    if (entries.length === 0)
        return null;
    return (_jsxs("div", { className: "relative pl-6", children: [_jsxs("div", { className: "absolute left-2 top-0 bottom-0 flex flex-col items-center", children: [_jsx("div", { className: "w-px flex-1 bg-purple-300" }), _jsx("span", { className: "text-purple-400 text-xs leading-none", children: "\u25BC" })] }), _jsxs("div", { className: "text-xs font-semibold text-purple-600 uppercase tracking-wide mb-1.5", children: ["\uD83E\uDDE0 Memory writes from ", label] }), _jsx("div", { className: "space-y-1.5", children: entries.map((e) => (_jsxs("div", { className: "flex items-start gap-2 text-sm", children: [_jsx("span", { className: `shrink-0 text-[0.65rem] font-bold px-1.5 py-0.5 rounded ${TIER_COLORS[e.memoryTier] ?? "bg-gray-100 text-gray-700"}`, children: e.memoryTier }), _jsx("span", { className: "text-gray-700", children: e.summary }), e.outcome && (_jsx("span", { className: `shrink-0 text-xs ${e.outcome === "success" ? "text-emerald-600" : "text-red-600"}`, children: e.outcome }))] }, e.id))) })] }));
}
/** Meetings shown as blocks with participants, decisions, and related memory writes. */
function MeetingsBlock({ meetings, memoryWrites }) {
    return (_jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "\uD83E\uDD1D Meetings" }), meetings.map((m) => {
                const relatedMemoryWrites = memoryWrites.filter((w) => w.meetingId === m.id);
                return (_jsxs("div", { className: "space-y-0", children: [_jsxs("div", { className: `border rounded-lg p-3 ${m.isKeyCeremony ? "border-l-4 border-l-amber-400 border-gray-200" : "border-gray-200"}`, children: [_jsxs("div", { className: "flex items-center gap-2 mb-1.5 flex-wrap", children: [m.isKeyCeremony && m.ceremonyKind && (_jsx("span", { className: `text-xs font-semibold px-2 py-0.5 rounded-full ${CEREMONY_COLORS[m.ceremonyKind] ?? "bg-gray-100 text-gray-700"}`, children: m.ceremonyKind.replace(/_/g, " ") })), _jsx("span", { className: "text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600", children: m.type.replace(/_/g, " ") }), _jsx("span", { className: "text-xs text-gray-400", children: formatTime(m.timestamp) })] }), _jsx("div", { className: "text-sm font-medium text-gray-800 mb-1", children: m.title }), m.trigger && (_jsxs("div", { className: "text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mb-1.5", children: [_jsx("span", { className: "font-semibold", children: "Trigger:" }), " ", m.trigger] })), _jsx("div", { className: "text-sm text-gray-500 mb-2", children: m.summary }), _jsxs("div", { className: "flex items-center gap-1.5 mb-1.5 flex-wrap", children: [_jsx("span", { className: "text-xs text-gray-400 shrink-0", children: "Who joined:" }), m.participantRoles.map((r) => (_jsx("span", { className: "text-xs font-medium px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200", children: r.replace(/_/g, " ") }, r))), _jsx("span", { className: "text-xs text-gray-300 mx-1", children: "\u2022" }), _jsxs("span", { className: "text-xs text-gray-400", children: ["Facilitator: ", m.facilitatorRole.replace(/_/g, " ")] })] }), m.decisions.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium text-gray-400 uppercase tracking-wide mb-1", children: "Decisions" }), _jsx("ul", { className: "space-y-0.5", children: m.decisions.map((d, i) => (_jsxs("li", { className: "text-sm text-gray-600", children: ["\u2022 ", d] }, i))) })] }))] }), relatedMemoryWrites.length > 0 && (_jsx(MemoryWritesBlock, { label: m.title || "meeting", entries: relatedMemoryWrites }))] }, m.id));
            })] }));
}
