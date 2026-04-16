"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { PageShell } from "../../components/page-shell";
import { apiUrl } from "../../lib/api";
const TYPE_COLORS = {
    beat_started: "text-blue-400",
    beat_completed: "text-green-400",
    beat_failed: "text-red-400",
    beat_idle: "text-gray-500",
    working: "text-yellow-300",
    error: "text-red-400",
    prompt: "text-purple-400",
    tool_call: "text-cyan-400",
    memory: "text-pink-400",
    preview: "text-teal-400",
    context: "text-gray-400",
    decision: "text-orange-400",
    transition: "text-emerald-400",
    info: "text-gray-400",
    idle: "text-gray-600",
    file_edit: "text-yellow-500",
    shell: "text-cyan-300",
};
const TYPE_LABELS = {
    beat_started: "BEAT▸",
    beat_completed: "BEAT✓",
    beat_failed: "BEAT✗",
    beat_idle: "IDLE",
    working: "WORK",
    error: "ERR",
    prompt: "LLM",
    tool_call: "TOOL",
    memory: "MEM",
    preview: "PREV",
    context: "CTX",
    decision: "DEC",
    transition: "TRANS",
    info: "INFO",
    idle: "IDLE",
    file_edit: "FILE",
    shell: "SHELL",
};
const ALL_EMPLOYEES = ["system", "ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"];
export default function LogsPage() {
    const [logs, setLogs] = useState([]);
    const [autoScroll, setAutoScroll] = useState(true);
    const [filterEmployee, setFilterEmployee] = useState("all");
    const [filterType, setFilterType] = useState("all");
    const [expandedIds, setExpandedIds] = useState(new Set());
    const [search, setSearch] = useState("");
    const [paused, setPaused] = useState(false);
    const bottomRef = useRef(null);
    const containerRef = useRef(null);
    // SSE stream
    useEffect(() => {
        const es = new EventSource(apiUrl("/employee-activity/stream"));
        es.onmessage = (event) => {
            if (paused)
                return;
            try {
                const entry = JSON.parse(event.data);
                setLogs((prev) => {
                    const next = [...prev, entry];
                    return next.length > 5000 ? next.slice(-5000) : next;
                });
            }
            catch { }
        };
        return () => es.close();
    }, [paused]);
    // Fetch history on mount
    useEffect(() => {
        fetch(apiUrl("/employee-activity"))
            .then((r) => r.json())
            .then((data) => {
            if (Array.isArray(data))
                setLogs(data);
        })
            .catch(() => { });
    }, []);
    // Auto-scroll
    useEffect(() => {
        if (autoScroll && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs, autoScroll]);
    // Detect manual scroll-up
    const handleScroll = () => {
        if (!containerRef.current)
            return;
        const el = containerRef.current;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        setAutoScroll(atBottom);
    };
    const toggleExpand = (id) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    };
    // Filter logs
    const filtered = logs.filter((log) => {
        if (filterEmployee !== "all" && log.employee !== filterEmployee)
            return false;
        if (filterType !== "all" && log.type !== filterType)
            return false;
        if (search && !log.content.toLowerCase().includes(search.toLowerCase()))
            return false;
        return true;
    });
    const activeTypes = Array.from(new Set(logs.map((l) => l.type))).sort();
    return (_jsxs(PageShell, { title: "System Logs", description: `${filtered.length} / ${logs.length} entries`, children: [_jsxs("div", { className: "mb-2 flex flex-wrap items-center gap-2 text-xs", children: [_jsxs("select", { className: "rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[var(--text-primary)]", value: filterEmployee, onChange: (e) => setFilterEmployee(e.target.value), children: [_jsx("option", { value: "all", children: "All Agents" }), ALL_EMPLOYEES.map((e) => (_jsx("option", { value: e, children: e }, e)))] }), _jsxs("select", { className: "rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[var(--text-primary)]", value: filterType, onChange: (e) => setFilterType(e.target.value), children: [_jsx("option", { value: "all", children: "All Types" }), activeTypes.map((t) => (_jsx("option", { value: t, children: TYPE_LABELS[t] || t }, t)))] }), _jsx("input", { type: "text", placeholder: "Search logs\u2026", className: "rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] w-48", value: search, onChange: (e) => setSearch(e.target.value) }), _jsx("button", { className: `rounded px-2 py-1 font-mono ${paused ? "bg-yellow-600 text-white" : "bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)]"}`, onClick: () => setPaused((p) => !p), children: paused ? "▶ Resume" : "⏸ Pause" }), _jsx("button", { className: "rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]", onClick: () => setLogs([]), children: "Clear" }), _jsx("span", { className: `ml-auto ${autoScroll ? "text-green-400" : "text-[var(--text-muted)]"}`, children: autoScroll ? "↓ auto-scroll" : "scroll paused" })] }), _jsxs("div", { ref: containerRef, onScroll: handleScroll, className: "flex-1 overflow-y-auto rounded border border-[var(--border)] bg-black/40 font-mono text-xs leading-5", style: { maxHeight: "calc(100vh - 180px)" }, children: [filtered.length === 0 ? (_jsx("div", { className: "p-8 text-center text-[var(--text-muted)]", children: logs.length === 0 ? "No logs yet — start the system to see activity." : "No logs match the current filter." })) : (filtered.map((log) => {
                        const time = new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
                        const typeColor = TYPE_COLORS[log.type] || "text-gray-400";
                        const typeLabel = TYPE_LABELS[log.type] || log.type.toUpperCase();
                        const hasDetail = log.detail && Object.keys(log.detail).length > 0;
                        const isExpanded = expandedIds.has(log.id);
                        return (_jsxs("div", { className: "group border-b border-white/5 px-3 py-0.5 hover:bg-white/5 cursor-pointer", onClick: () => hasDetail && toggleExpand(log.id), children: [_jsxs("div", { className: "flex items-start gap-2", children: [_jsx("span", { className: "text-gray-600 shrink-0", children: time }), _jsx("span", { className: `shrink-0 w-14 text-right font-semibold ${typeColor}`, children: typeLabel }), _jsx("span", { className: "shrink-0 w-20 text-blue-300 truncate", children: log.employee }), _jsxs("span", { className: "text-[var(--text-primary)] flex-1 break-all", children: [log.content, hasDetail && (_jsx("span", { className: "ml-1 text-gray-600", children: isExpanded ? "▾" : "▸" }))] }), log.beatId && _jsx("span", { className: "shrink-0 text-gray-600 text-[0.65rem]", children: log.beatId.slice(0, 16) })] }), isExpanded && hasDetail && (_jsx("pre", { className: "ml-[8.5rem] mt-1 mb-1 text-[0.65rem] text-gray-500 whitespace-pre-wrap break-all max-h-64 overflow-auto", children: JSON.stringify(log.detail, null, 2) }))] }, log.id));
                    })), _jsx("div", { ref: bottomRef })] })] }));
}
