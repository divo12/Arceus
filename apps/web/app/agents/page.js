"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { PageShell } from "../../components/page-shell";
import { apiUrl } from "../../lib/api";
import { Shield, Cpu, Wrench } from "lucide-react";
const ROLE_COLORS = {
    ceo: "var(--role-ceo)",
    cto: "var(--role-cto)",
    pm: "var(--role-pm)",
    developer: "var(--role-developer)",
    tester: "var(--role-tester)",
    ui_designer: "var(--role-ui-designer)",
    marketing: "var(--role-marketing)",
    skills_lead: "var(--role-skills-lead)",
};
function StatusBadge({ status }) {
    const bg = status === "running" || status === "active" || status === "connected"
        ? "var(--status-success)"
        : status === "idle"
            ? "var(--status-idle)"
            : status === "error" || status === "failed"
                ? "var(--status-error)"
                : "var(--status-warning)";
    return (_jsx("span", { className: "inline-flex items-center px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider", style: { backgroundColor: bg, color: "#000" }, children: status }));
}
export default function AgentsPage() {
    const [agents, setAgents] = useState([]);
    const [selected, setSelected] = useState(null);
    const [tools, setTools] = useState([]);
    useEffect(() => {
        let active = true;
        async function poll() {
            try {
                const res = await fetch(apiUrl("/employees"), { cache: "no-store" });
                if (!active)
                    return;
                if (res.ok) {
                    const data = await res.json();
                    setAgents(data);
                    if (!selected && data.length > 0)
                        setSelected(data[0]);
                    else if (selected) {
                        const updated = data.find((a) => a.id === selected.id);
                        if (updated)
                            setSelected(updated);
                    }
                }
            }
            catch { /* ignore */ }
        }
        poll();
        const id = setInterval(poll, 2000);
        return () => { active = false; clearInterval(id); };
    }, [selected?.id]);
    useEffect(() => {
        if (!selected)
            return;
        let active = true;
        async function loadTools() {
            try {
                const res = await fetch(apiUrl(`/service-registry/role/${selected.role}`), { cache: "no-store" });
                if (!active)
                    return;
                if (res.ok)
                    setTools(await res.json());
            }
            catch {
                setTools([]);
            }
        }
        loadTools();
        return () => { active = false; };
    }, [selected?.role]);
    return (_jsx(PageShell, { title: "Agents", description: "Agent roster, capabilities, and live session state", children: agents.length === 0 ? (_jsx("div", { className: "flex h-64 items-center justify-center text-[var(--text-muted)]", children: _jsx("p", { className: "text-sm", children: "No agents hired yet. Bootstrap a company first." }) })) : (_jsxs("div", { className: "flex gap-4", style: { minHeight: "calc(100vh - 150px)" }, children: [_jsx("div", { className: "w-56 shrink-0 space-y-1", children: agents.map((agent) => {
                        const isActive = selected?.id === agent.id;
                        return (_jsxs("button", { onClick: () => setSelected(agent), className: `flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors border ${isActive
                                ? "border-[var(--text-muted)] bg-[var(--bg-tertiary)]"
                                : "border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]"}`, children: [_jsx("span", { className: "flex h-7 w-7 shrink-0 items-center justify-center text-[0.625rem] font-bold rounded", style: { backgroundColor: ROLE_COLORS[agent.role] || "var(--text-muted)", color: "#000" }, children: agent.name[0] }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-[0.8125rem] font-medium text-[var(--text-primary)] truncate", children: agent.name }), _jsx("p", { className: "text-[0.6875rem] text-[var(--text-muted)] truncate", children: agent.role })] }), _jsx("span", { className: "h-2 w-2 shrink-0 rounded-full", style: {
                                        backgroundColor: agent.status === "running" || agent.status === "active"
                                            ? "var(--status-success)"
                                            : agent.status === "idle"
                                                ? "var(--status-idle)"
                                                : "var(--status-warning)",
                                    } })] }, agent.id));
                    }) }), selected && (_jsxs("div", { className: "flex-1 space-y-4", children: [_jsx("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: _jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "flex h-10 w-10 items-center justify-center text-[0.875rem] font-bold rounded", style: { backgroundColor: ROLE_COLORS[selected.role] || "var(--text-muted)", color: "#000" }, children: selected.name[0] }), _jsxs("div", { children: [_jsx("h2", { className: "swiss-h2 text-[var(--text-primary)]", children: selected.name }), _jsx("p", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: selected.title })] })] }), _jsx("p", { className: "mt-2 text-[0.8125rem] text-[var(--text-secondary)]", children: selected.profile })] }), _jsx(StatusBadge, { status: selected.status })] }) }), _jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-3 flex items-center gap-2", children: [_jsx(Cpu, { className: "h-3.5 w-3.5" }), " Session"] }), selected.session ? (_jsxs("div", { className: "grid grid-cols-2 gap-x-6 gap-y-2 text-[0.8125rem]", children: [_jsxs("div", { children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Runtime: " }), _jsx(StatusBadge, { status: selected.session.runtimeStatus })] }), _jsxs("div", { children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Events: " }), _jsx("span", { className: "text-[var(--text-primary)]", children: selected.session.eventCount })] }), _jsxs("div", { children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Tool calls: " }), _jsx("span", { className: "text-[var(--text-primary)]", children: selected.session.toolInvocationCount })] }), _jsxs("div", { children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "File edits: " }), _jsx("span", { className: "text-[var(--text-primary)]", children: selected.session.fileEditCount })] }), _jsxs("div", { children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Shell cmds: " }), _jsx("span", { className: "text-[var(--text-primary)]", children: selected.session.shellCommandCount })] }), selected.session.lastToolName && (_jsxs("div", { children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Last tool: " }), _jsx("span", { className: "swiss-mono text-[var(--text-primary)]", children: selected.session.lastToolName }), selected.session.lastToolStatus && (_jsxs("span", { className: "ml-1 text-[var(--text-muted)]", children: ["(", selected.session.lastToolStatus, ")"] }))] })), selected.session.activeTaskId && (_jsxs("div", { className: "col-span-2", children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Active task: " }), _jsx("span", { className: "swiss-mono text-[var(--text-primary)]", children: selected.session.activeTaskId })] })), selected.session.stallReason && (_jsxs("div", { className: "col-span-2 text-[var(--status-warning)]", children: ["Stall: ", selected.session.stallReason] })), selected.session.lastEventSummary && (_jsxs("div", { className: "col-span-2", children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Last event: " }), _jsx("span", { className: "text-[var(--text-secondary)]", children: selected.session.lastEventSummary.slice(0, 120) })] }))] })) : (_jsx("p", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: "No active session" }))] }), selected.memory && (_jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-3 flex items-center gap-2", children: [_jsx(Shield, { className: "h-3.5 w-3.5" }), " Memory"] }), _jsx("div", { className: "grid grid-cols-2 gap-4", children: [
                                        ["Focus", selected.memory.currentFocus],
                                        ["Learnings", selected.memory.recentLearnings],
                                        ["Patterns", selected.memory.activePatterns],
                                        ["Blockers", selected.memory.blockers],
                                    ].map(([label, items]) => (_jsxs("div", { children: [_jsx("p", { className: "swiss-caption text-[var(--text-muted)] mb-1", children: label }), items?.length ? (_jsx("ul", { className: "space-y-0.5", children: (items ?? []).map((item, i) => (_jsxs("li", { className: "text-[0.8125rem] text-[var(--text-secondary)]", children: ["\u00B7 ", item] }, i))) })) : (_jsx("p", { className: "text-[0.75rem] text-[var(--text-muted)]", children: "\u2014" }))] }, label))) })] })), _jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-3 flex items-center gap-2", children: [_jsx(Wrench, { className: "h-3.5 w-3.5" }), " Available Tools", _jsxs("span", { className: "text-[0.75rem] text-[var(--text-muted)]", children: ["(", tools.length, ")"] })] }), tools.length > 0 ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: tools.map((tool) => (_jsxs("span", { className: "inline-flex items-center gap-1 border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[0.6875rem] text-[var(--text-secondary)]", title: `source: ${tool.source}, blast: ${tool.blastRadius}`, children: [_jsx("span", { className: "h-1.5 w-1.5 rounded-full", style: {
                                                    backgroundColor: tool.blastRadius === "red" ? "var(--status-error)" :
                                                        tool.blastRadius === "yellow" ? "var(--status-warning)" :
                                                            "var(--status-success)",
                                                } }), tool.toolName] }, tool.toolName))) })) : (_jsx("p", { className: "text-[0.75rem] text-[var(--text-muted)]", children: "No tools registered" }))] })] }))] })) }));
}
