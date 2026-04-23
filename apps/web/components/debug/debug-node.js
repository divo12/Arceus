"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
const STATUS_STYLES = {
    completed: "border-emerald-500 bg-white",
    in_progress: "border-blue-500 bg-white ring-2 ring-blue-200 animate-pulse",
    failed: "border-red-500 bg-red-50",
    cancelled: "border-gray-400 bg-gray-50",
    blocked: "border-amber-500 bg-amber-50",
    planned: "border-gray-300 border-dashed bg-gray-50/80",
    created: "border-gray-300 border-dashed bg-gray-50/80",
};
const STATUS_DOT = {
    completed: "bg-emerald-500",
    in_progress: "bg-blue-500 animate-pulse",
    failed: "bg-red-500",
    cancelled: "bg-gray-400",
    blocked: "bg-amber-500",
    planned: "bg-gray-300",
    created: "bg-gray-300",
};
const ROLE_COLORS = {
    cto: "bg-purple-100 text-purple-700 border border-purple-200",
    developer: "bg-blue-100 text-blue-700 border border-blue-200",
    tester: "bg-orange-100 text-orange-700 border border-orange-200",
    ui_designer: "bg-pink-100 text-pink-700 border border-pink-200",
    pm: "bg-green-100 text-green-700 border border-green-200",
    ceo: "bg-yellow-100 text-yellow-700 border border-yellow-200",
    marketing: "bg-teal-100 text-teal-700 border border-teal-200",
};
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}
function formatKind(kind) {
    return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function DebugNodeComponent({ data, selected }) {
    const d = data;
    const statusStyle = STATUS_STYLES[d.status] ?? STATUS_STYLES.planned;
    const dot = STATUS_DOT[d.status] ?? STATUS_DOT.planned;
    const roleColor = ROLE_COLORS[d.assignedRole] ?? "bg-gray-100 text-gray-600 border border-gray-200";
    // ── Special rendering for CEO sprint planning node ──
    if (d.kind === "sprint_planning") {
        return (_jsxs("div", { className: `rounded-xl border-2 border-yellow-400 bg-gradient-to-br from-yellow-50 to-amber-50 px-5 py-4 min-w-[260px] max-w-[300px] shadow-md transition-all duration-200 ${selected ? "ring-2 ring-yellow-400 shadow-lg scale-[1.02]" : "hover:shadow-lg"}`, children: [_jsx(Handle, { type: "target", position: Position.Left, id: "left", className: "!bg-yellow-500 !w-2.5 !h-2.5 !border-2 !border-white" }), _jsx(Handle, { type: "target", position: Position.Top, id: "top", className: "!bg-blue-400 !w-2 !h-2 !border-2 !border-white" }), _jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx("span", { className: "text-lg", children: "\uD83E\uDDE0" }), _jsx("span", { className: "text-xs font-bold text-yellow-700 uppercase tracking-wider", children: "CEO Planning" })] }), _jsx("div", { className: "text-sm font-semibold text-gray-800 leading-snug mb-2 line-clamp-2", title: d.title, children: d.title }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${dot}` }), _jsx("span", { className: "text-xs text-gray-600 capitalize", children: d.status.replace(/_/g, " ") })] }), _jsx(Handle, { type: "source", position: Position.Right, id: "right", className: "!bg-yellow-500 !w-2.5 !h-2.5 !border-2 !border-white" }), _jsx(Handle, { type: "source", position: Position.Bottom, id: "bottom", className: "!bg-blue-400 !w-2 !h-2 !border-2 !border-white" })] }));
    }
    // ── Special rendering for key ceremony meeting nodes ──
    if (d.kind === "meeting") {
        return (_jsxs("div", { className: `rounded-xl border-2 border-teal-400 bg-gradient-to-br from-teal-50 to-cyan-50 px-5 py-4 min-w-[240px] max-w-[280px] shadow-md transition-all duration-200 ${selected ? "ring-2 ring-teal-400 shadow-lg scale-[1.02]" : "hover:shadow-lg"}`, children: [_jsx(Handle, { type: "target", position: Position.Left, id: "left", className: "!bg-teal-500 !w-2.5 !h-2.5 !border-2 !border-white" }), _jsx(Handle, { type: "target", position: Position.Top, id: "top", className: "!bg-blue-400 !w-2 !h-2 !border-2 !border-white" }), _jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx("span", { className: "text-lg", children: "\uD83E\uDD1D" }), _jsx("span", { className: "text-xs font-bold text-teal-700 uppercase tracking-wider", children: "Ceremony" })] }), _jsx("div", { className: "text-sm font-semibold text-gray-800 leading-snug mb-2 line-clamp-2", title: d.title, children: d.title }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${dot}` }), _jsx("span", { className: "text-xs text-gray-600 capitalize", children: d.status.replace(/_/g, " ") })] }), _jsx(Handle, { type: "source", position: Position.Right, id: "right", className: "!bg-teal-500 !w-2.5 !h-2.5 !border-2 !border-white" }), _jsx(Handle, { type: "source", position: Position.Bottom, id: "bottom", className: "!bg-blue-400 !w-2 !h-2 !border-2 !border-white" })] }));
    }
    return (_jsxs("div", { className: `rounded-lg border-2 px-4 py-3 min-w-[240px] max-w-[280px] shadow-sm transition-all duration-200 ${statusStyle} ${selected ? "ring-2 ring-blue-400 shadow-lg scale-[1.02]" : "hover:shadow-md"}`, children: [_jsx(Handle, { type: "target", position: Position.Left, id: "left", className: "!bg-gray-400 !w-2.5 !h-2.5 !border-2 !border-white" }), _jsx(Handle, { type: "target", position: Position.Top, id: "top", className: "!bg-blue-400 !w-2 !h-2 !border-2 !border-white" }), _jsxs("div", { className: "flex items-center justify-between gap-2 mb-2", children: [_jsx("span", { className: `text-[0.65rem] font-semibold px-2 py-0.5 rounded-full ${roleColor}`, children: formatKind(d.kind) }), _jsx("span", { className: "text-[0.6rem] font-medium text-gray-400 uppercase tracking-wide", children: d.assignedRole.replace(/_/g, " ") })] }), _jsx("div", { className: "text-sm font-semibold text-gray-800 leading-snug mb-2 line-clamp-2", title: d.title, children: d.title }), _jsxs("div", { className: "flex items-center gap-1.5 mb-2", children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${dot}` }), _jsx("span", { className: "text-xs text-gray-600 capitalize", children: d.status.replace(/_/g, " ") })] }), _jsxs("div", { className: "flex items-center gap-3 text-[0.65rem] text-gray-400", children: [d.beatCount > 0 && (_jsxs("span", { className: "flex items-center gap-0.5", children: [_jsx("span", { className: "text-gray-500", children: "\u26A1" }), " ", d.beatCount] })), d.fileCount > 0 && (_jsxs("span", { className: "flex items-center gap-0.5", children: [_jsx("span", { className: "text-gray-500", children: "\uD83D\uDCC4" }), " ", d.fileCount] })), d.meetingCount > 0 && (_jsxs("span", { className: "flex items-center gap-0.5", children: [_jsx("span", { className: "text-gray-500", children: "\uD83E\uDD1D" }), " ", d.meetingCount] })), d.memoryWriteCount > 0 && (_jsxs("span", { className: "flex items-center gap-0.5", children: [_jsx("span", { className: "text-purple-500", children: "\uD83E\uDDE0" }), " ", d.memoryWriteCount] })), d.durationMs != null && (_jsxs("span", { className: "flex items-center gap-0.5", children: [_jsx("span", { className: "text-gray-500", children: "\u23F1" }), " ", formatDuration(d.durationMs)] }))] }), d.reworkCycles != null && d.reworkCycles > 0 && (_jsxs("div", { className: "text-[0.65rem] text-orange-600 font-medium mt-1.5", children: ["\uD83D\uDD01 ", d.reworkCycles, " rework cycle", d.reworkCycles > 1 ? "s" : ""] })), _jsx(Handle, { type: "source", position: Position.Right, id: "right", className: "!bg-gray-400 !w-2.5 !h-2.5 !border-2 !border-white" }), _jsx(Handle, { type: "source", position: Position.Bottom, id: "bottom", className: "!bg-blue-400 !w-2 !h-2 !border-2 !border-white" })] }));
}
export const DebugNode = memo(DebugNodeComponent);
