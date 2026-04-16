"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { apiUrl } from "../lib/api";
const STATUS_COLORS = {
    created: "bg-[var(--swiss-gray-50)] text-[var(--swiss-gray-300)] border-[var(--swiss-gray-100)]",
    planned: "bg-[var(--swiss-white)] text-[var(--swiss-blue)] border-[var(--swiss-blue)]",
    in_progress: "bg-[var(--swiss-white)] text-[var(--swiss-black)] border-[var(--swiss-black)]",
    verifying: "bg-[var(--swiss-white)] text-[var(--swiss-gray-500)] border-[var(--swiss-gray-300)]",
    completed: "bg-[var(--swiss-black)] text-[var(--swiss-white)] border-[var(--swiss-black)]",
    failed: "bg-[var(--swiss-white)] text-[var(--swiss-red)] border-[var(--swiss-red)]",
    blocked: "bg-[var(--swiss-white)] text-[var(--swiss-red)] border-[var(--swiss-red)]",
    cancelled: "bg-[var(--swiss-gray-50)] text-[var(--swiss-gray-200)] border-[var(--swiss-gray-100)]",
};
const ROLE_BADGE_COLORS = {
    ceo: "bg-[var(--swiss-black)] text-[var(--swiss-white)]",
    cto: "bg-[var(--swiss-blue)] text-[var(--swiss-white)]",
    pm: "bg-[var(--swiss-gray-500)] text-[var(--swiss-white)]",
    developer: "bg-[var(--swiss-black)] text-[var(--swiss-white)]",
    tester: "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]",
    ui_designer: "bg-[var(--swiss-red)] text-[var(--swiss-white)]",
    marketing: "bg-[var(--swiss-gray-500)] text-[var(--swiss-white)]",
    skills_lead: "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]",
};
const EXECUTION_STATUS_LABELS = {
    idle: { label: "Idle", color: "text-[var(--swiss-gray-300)]" },
    planning: { label: "Planning", color: "text-[var(--swiss-blue)]" },
    executing: { label: "Executing", color: "text-[var(--swiss-black)]" },
    verifying: { label: "Verifying", color: "text-[var(--swiss-gray-500)]" },
    awaiting_board_review: { label: "Awaiting Board", color: "text-[var(--swiss-red)]" },
    paused: { label: "Paused", color: "text-[var(--swiss-gray-300)]" },
    done: { label: "Done", color: "text-[var(--swiss-black)]" },
    error: { label: "Error", color: "text-[var(--swiss-red)]" },
};
function TaskNode({ task, feedbackRounds }) {
    const taskFeedback = feedbackRounds.filter((r) => r.taskId === task.id);
    const statusStyle = STATUS_COLORS[task.status] ?? STATUS_COLORS.created;
    const roleStyle = ROLE_BADGE_COLORS[task.assignedRole] ?? "bg-slate-100 text-slate-700";
    return (_jsxs("div", { className: `border p-3 ${statusStyle}`, children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "text-sm font-semibold leading-tight", children: task.title }), _jsxs("div", { className: "mt-1 flex flex-wrap items-center gap-1.5", children: [_jsx("span", { className: `inline-block px-2 py-0.5 text-[10px] font-medium ${roleStyle}`, children: task.assignedRole.replace(/_/g, " ") }), _jsx("span", { className: "text-[10px] uppercase tracking-wider opacity-60", children: task.kind.replace(/_/g, " ") })] })] }), _jsx("span", { className: "shrink-0 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", children: task.status.replace(/_/g, " ") })] }), task.iterationCount > 0 && (_jsxs("div", { className: "mt-2 flex items-center gap-1.5 text-[10px]", children: [_jsxs("span", { className: "font-medium", children: ["Iteration ", task.iterationCount, "/", task.maxIterations] }), _jsx("div", { className: "flex gap-0.5", children: Array.from({ length: task.maxIterations }, (_, i) => (_jsx("div", { className: `h-1.5 w-3 ${i < task.iterationCount ? "bg-current opacity-60" : "bg-current opacity-15"}` }, i))) })] })), taskFeedback.length > 0 && (_jsx("div", { className: "mt-2 space-y-1", children: taskFeedback.slice(-2).map((round) => (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] px-2 py-1 text-[10px]", children: [_jsx("span", { className: "font-medium", children: round.fromRole }), _jsx("span", { className: "mx-1", children: "\u2192" }), _jsx("span", { className: "font-medium", children: round.toRole }), _jsx("span", { className: `ml-1 px-1 py-0.5 text-[9px] font-bold uppercase ${round.verdict === "approve" ? "bg-[var(--swiss-black)] text-[var(--swiss-white)]" : round.verdict === "revise" ? "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]" : "bg-[var(--swiss-red)] text-[var(--swiss-white)]"}`, children: round.verdict }), _jsx("div", { className: "mt-0.5 truncate opacity-70", children: round.feedback })] }, round.id))) }))] }));
}
function TransitionArrow({ transition }) {
    return (_jsxs("div", { className: "flex items-center gap-1.5 px-2 py-0.5", children: [_jsx("div", { className: "h-4 w-px bg-[var(--swiss-gray-200)]" }), _jsx("svg", { className: "h-3 w-3 text-[var(--swiss-gray-200)]", viewBox: "0 0 12 12", fill: "none", children: _jsx("path", { d: "M6 1v8M3 6l3 3 3-3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }) }), _jsxs("span", { className: "truncate text-[9px] text-[var(--swiss-gray-300)]", children: [transition.triggeredByRole, ": ", transition.reason.slice(0, 60)] })] }));
}
export function ExecutionFlow({ pollIntervalMs = 3000 }) {
    const [data, setData] = useState(null);
    useEffect(() => {
        let active = true;
        async function fetchFlow() {
            try {
                const res = await fetch(apiUrl("/execution-flow"));
                if (res.ok && active) {
                    setData(await res.json());
                }
            }
            catch {
                /* ignore fetch errors during polling */
            }
        }
        fetchFlow();
        const interval = setInterval(fetchFlow, pollIntervalMs);
        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [pollIntervalMs]);
    if (!data || data.tasks.length === 0) {
        return (_jsxs(Card, { children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsx("div", { className: "swiss-caption", children: "Dynamic orchestration" }), _jsx(CardTitle, { className: "mt-1 text-xl", children: "Execution flow" }), _jsx(CardDescription, { className: "text-sm", children: "Live state transitions and task graph powered by the LLM Router." })] }), _jsx(CardContent, { children: _jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-6 text-sm text-[var(--swiss-gray-300)]", children: "No execution data yet. The flow graph will populate once the autonomous engine begins." }) })] }));
    }
    const statusInfo = EXECUTION_STATUS_LABELS[data.executionStatus] ?? EXECUTION_STATUS_LABELS.idle;
    // Sort tasks: core pipeline first (by dependency chain), then specialists
    const corePipelineKinds = ["technical_plan", "acceptance_spec", "implementation", "local_preview", "board_handoff"];
    const coreTasks = data.tasks.filter((t) => corePipelineKinds.includes(t.kind));
    const specialistTasks = data.tasks.filter((t) => !corePipelineKinds.includes(t.kind) && t.kind !== "follow_up");
    const followUpTasks = data.tasks.filter((t) => t.kind === "follow_up");
    // Order core tasks by the pipeline sequence
    coreTasks.sort((a, b) => corePipelineKinds.indexOf(a.kind) - corePipelineKinds.indexOf(b.kind));
    // Build a map of recent transitions per task (last transition for each toTaskId)
    const transitionByTask = new Map();
    for (const t of data.transitions) {
        transitionByTask.set(t.toTaskId, t);
    }
    const completedCount = data.tasks.filter((t) => t.status === "completed").length;
    const totalCount = data.tasks.length;
    const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
    return (_jsxs(Card, { children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { children: [_jsx("div", { className: "swiss-caption", children: "Dynamic orchestration" }), _jsx(CardTitle, { className: "mt-1 text-xl", children: "Execution flow" }), _jsx(CardDescription, { className: "text-sm", children: "Live state transitions and task graph powered by the LLM Router." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `text-xs font-semibold ${statusInfo.color}`, children: statusInfo.label }), _jsxs(Badge, { variant: "secondary", children: [completedCount, "/", totalCount, " tasks"] })] })] }), _jsx("div", { className: "mt-3 h-1.5 w-full overflow-hidden bg-[var(--swiss-gray-50)]", children: _jsx("div", { className: "h-full bg-[var(--swiss-black)] transition-all duration-500", style: { width: `${progressPct}%` } }) })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-2", children: "Core pipeline" }), _jsx("div", { className: "space-y-1", children: coreTasks.map((task, index) => (_jsxs("div", { children: [_jsx(TaskNode, { task: task, feedbackRounds: data.feedbackRounds }), index < coreTasks.length - 1 && transitionByTask.has(coreTasks[index + 1]?.id) && (_jsx(TransitionArrow, { transition: transitionByTask.get(coreTasks[index + 1].id) }))] }, task.id))) })] }), specialistTasks.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-2", children: "Specialist tasks" }), _jsx("div", { className: "grid gap-2 sm:grid-cols-2", children: specialistTasks.map((task) => (_jsx(TaskNode, { task: task, feedbackRounds: data.feedbackRounds }, task.id))) })] })), followUpTasks.length > 0 && (_jsxs("div", { children: [_jsxs("div", { className: "swiss-caption mb-2", children: ["Follow-up tasks (", followUpTasks.length, ")"] }), _jsx("div", { className: "space-y-1.5", children: followUpTasks.map((task) => (_jsx("div", { className: `border px-3 py-2 text-xs ${STATUS_COLORS[task.status] ?? STATUS_COLORS.created}`, children: _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "font-medium", children: task.title }), _jsx("span", { className: "shrink-0 text-[10px] uppercase opacity-70", children: task.status.replace(/_/g, " ") })] }) }, task.id))) })] })), data.transitions.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-2", children: "Recent transitions" }), _jsx("div", { className: "max-h-40 space-y-1 overflow-y-auto", children: data.transitions.slice(-8).reverse().map((t) => (_jsxs("div", { className: "flex items-center gap-2 bg-[var(--swiss-gray-50)] px-2 py-1.5 text-[10px]", children: [_jsx("span", { className: `px-1 py-0.5 font-semibold uppercase ${t.status === "executed" ? "bg-[var(--swiss-black)] text-[var(--swiss-white)]" : t.status === "proposed" ? "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]" : "bg-[var(--swiss-red)] text-[var(--swiss-white)]"}`, children: t.status }), _jsx("span", { className: "font-medium", children: t.toStatus.replace(/_/g, " ") }), _jsx("span", { className: "truncate text-[var(--swiss-gray-300)]", children: t.reason.slice(0, 50) }), _jsx("span", { className: "ml-auto shrink-0 text-[var(--swiss-gray-200)]", children: t.triggeredByRole })] }, t.id))) })] }))] })] }));
}
