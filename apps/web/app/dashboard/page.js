"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { PageShell } from "../../components/page-shell";
import { apiUrl } from "../../lib/api";
import { Activity, CheckSquare, Users, Zap, TrendingUp, Clock, AlertCircle, CircleDot, } from "lucide-react";
function StatCard({ icon: Icon, label, value, sub, color, }) {
    return (_jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-4", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(Icon, { className: "h-3.5 w-3.5", style: color ? { color } : undefined }), _jsx("span", { className: "swiss-caption text-[var(--text-muted)]", children: label })] }), _jsx("p", { className: "text-[1.5rem] font-bold tracking-tight text-[var(--text-primary)]", children: value }), sub && _jsx("p", { className: "mt-1 text-[0.75rem] text-[var(--text-muted)]", children: sub })] }));
}
function StatusDot({ status }) {
    const color = status === "active" || status === "running" || status === "executing" || status === "completed"
        ? "var(--status-success)"
        : status === "failed" || status === "error"
            ? "var(--status-error)"
            : status === "idle" || status === "stopped"
                ? "var(--status-idle)"
                : "var(--status-warning)";
    return (_jsx("span", { className: "inline-block h-2 w-2 rounded-full", style: { backgroundColor: color } }));
}
export default function DashboardPage() {
    const [snapshot, setSnapshot] = useState(null);
    const [orchestrator, setOrchestrator] = useState(null);
    const [heartbeat, setHeartbeat] = useState(null);
    useEffect(() => {
        let active = true;
        async function poll() {
            try {
                const [snapRes, orchRes, hbRes] = await Promise.all([
                    fetch(apiUrl("/company"), { cache: "no-store" }),
                    fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
                    fetch(apiUrl("/heartbeat/status"), { cache: "no-store" }),
                ]);
                if (!active)
                    return;
                if (snapRes.ok)
                    setSnapshot(await snapRes.json());
                if (orchRes.ok)
                    setOrchestrator(await orchRes.json());
                if (hbRes.ok)
                    setHeartbeat(await hbRes.json());
            }
            catch { /* ignore */ }
        }
        poll();
        const id = setInterval(poll, 3000);
        return () => { active = false; clearInterval(id); };
    }, []);
    const company = snapshot?.company;
    const tasks = snapshot?.tasks ?? [];
    const agents = snapshot?.agents ?? [];
    const isPending = !company || company.id === "company_pending";
    const tasksByStatus = {
        created: tasks.filter((t) => t.status === "created").length,
        planned: tasks.filter((t) => t.status === "planned").length,
        inProgress: tasks.filter((t) => t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
        blocked: tasks.filter((t) => t.status === "blocked").length,
    };
    const budgetPct = company && company.budgetCents > 0
        ? Math.round((company.spentCents / company.budgetCents) * 100)
        : 0;
    return (_jsx(PageShell, { title: "Dashboard", description: "System overview and operational health", children: isPending ? (_jsx("div", { className: "flex h-64 items-center justify-center text-[var(--text-muted)]", children: _jsx("p", { className: "text-sm", children: "No company bootstrapped yet. Start a conversation with the CEO." }) })) : (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-[var(--border)] pb-4", children: [_jsxs("div", { children: [_jsx("h2", { className: "swiss-h1 text-[var(--text-primary)]", children: company.name }), _jsxs("div", { className: "mt-1 flex items-center gap-3 text-[0.8125rem] text-[var(--text-muted)]", children: [_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx(StatusDot, { status: company.status }), company.status] }), _jsxs("span", { children: ["Sprint ", company.currentSprintNumber ?? "—"] }), _jsxs("span", { children: ["Execution: ", orchestrator?.executionStatus ?? "—"] })] })] }), _jsxs("div", { className: "text-right", children: [_jsx("p", { className: "text-[0.75rem] text-[var(--text-muted)]", children: "Budget" }), _jsxs("p", { className: "text-[1rem] font-semibold text-[var(--text-primary)]", children: [(company.spentCents / 100).toFixed(2), " / ", (company.budgetCents / 100).toFixed(2), _jsxs("span", { className: "ml-1 text-[0.75rem] text-[var(--text-muted)]", children: ["(", budgetPct, "%)"] })] }), _jsx("div", { className: "mt-1 h-1.5 w-32 bg-[var(--bg-tertiary)] overflow-hidden", children: _jsx("div", { className: "h-full transition-all", style: {
                                            width: `${Math.min(budgetPct, 100)}%`,
                                            backgroundColor: budgetPct >= 90 ? "var(--status-error)" : budgetPct >= 70 ? "var(--status-warning)" : "var(--status-success)",
                                        } }) })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3 sm:grid-cols-4", children: [_jsx(StatCard, { icon: CheckSquare, label: "Tasks", value: tasks.length, sub: `${tasksByStatus.completed} done · ${tasksByStatus.inProgress} active`, color: "var(--status-info)" }), _jsx(StatCard, { icon: Users, label: "Agents", value: agents.length, sub: `${agents.filter((a) => a.status === "running").length} running`, color: "var(--role-developer)" }), _jsx(StatCard, { icon: Zap, label: "Heartbeat", value: heartbeat?.running ? "Active" : "Off", sub: heartbeat ? `${heartbeat.totalBeats} total beats` : "—", color: "var(--role-ceo)" }), _jsx(StatCard, { icon: Activity, label: "Sprint", value: orchestrator?.sprint?.title ?? "None", sub: orchestrator?.sprint ? `#${orchestrator.sprint.number} · ${orchestrator.sprint.status}` : "—", color: "var(--role-pm)" })] }), _jsxs("div", { children: [_jsx("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-3", children: "Task Breakdown" }), _jsx("div", { className: "grid grid-cols-3 gap-2 sm:grid-cols-6", children: [
                                ["Created", tasksByStatus.created, "var(--text-muted)"],
                                ["Planned", tasksByStatus.planned, "var(--status-info)"],
                                ["In Progress", tasksByStatus.inProgress, "var(--status-warning)"],
                                ["Completed", tasksByStatus.completed, "var(--status-success)"],
                                ["Failed", tasksByStatus.failed, "var(--status-error)"],
                                ["Blocked", tasksByStatus.blocked, "var(--status-idle)"],
                            ].map(([label, count, color]) => (_jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-center", children: [_jsx("p", { className: "text-[1.25rem] font-bold", style: { color }, children: count }), _jsx("p", { className: "text-[0.6875rem] text-[var(--text-muted)] mt-0.5", children: label })] }, label))) })] }), _jsxs("div", { children: [_jsx("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-3", children: "Agent Roster" }), _jsx("div", { className: "space-y-1", children: agents.map((agent) => (_jsxs("div", { className: "flex items-center gap-3 border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2", children: [_jsx("span", { className: "flex h-6 w-6 items-center justify-center text-[0.625rem] font-bold rounded", style: { backgroundColor: `var(--role-${agent.role.replace("_", "-")})`, color: "#000" }, children: agent.name[0] }), _jsx("span", { className: "text-[0.8125rem] font-medium text-[var(--text-primary)] w-20", children: agent.name }), _jsx("span", { className: "swiss-caption text-[var(--text-muted)] w-24", children: agent.role }), _jsx(StatusDot, { status: agent.status }), _jsx("span", { className: "text-[0.75rem] text-[var(--text-muted)]", children: agent.status })] }, agent.id))) })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3 sm:grid-cols-4", children: [_jsx(StatCard, { icon: TrendingUp, label: "Meetings", value: snapshot?.meetings?.length ?? 0, color: "var(--role-cto)" }), _jsx(StatCard, { icon: Clock, label: "Approvals", value: snapshot?.approvals?.filter((a) => a.status === "pending").length ?? 0, sub: "pending", color: "var(--status-warning)" }), _jsx(StatCard, { icon: CircleDot, label: "Artifacts", value: snapshot?.artifacts?.length ?? 0, color: "var(--role-ui-designer)" }), _jsx(StatCard, { icon: AlertCircle, label: "Messages", value: snapshot?.chatMessages?.length ?? 0, color: "var(--role-marketing)" })] })] })) }));
}
