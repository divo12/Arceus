"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import ReactMarkdown from "react-markdown";
import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";
import { apiUrl } from "../../lib/api";
import { PageShell } from "../../components/layout/page-shell";
function taskTone(status) {
    if (status === "completed")
        return "secondary";
    if (["failed", "blocked", "cancelled"].includes(status))
        return "destructive";
    return "outline";
}
export default function TasksPage() {
    const [snapshot, setSnapshot] = useState(null);
    const [executionStatus, setExecutionStatus] = useState("idle");
    const [selectedTaskId, setSelectedTaskId] = useState(null);
    const [expandedArtifact, setExpandedArtifact] = useState(null);
    useEffect(() => {
        async function load() {
            try {
                const [companyResponse, orchestratorResponse] = await Promise.all([
                    fetch(apiUrl("/company"), { cache: "no-store" }),
                    fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
                ]);
                if (companyResponse.ok) {
                    setSnapshot((await companyResponse.json()));
                }
                if (orchestratorResponse.ok) {
                    const orchestrator = (await orchestratorResponse.json());
                    setExecutionStatus(orchestrator.executionStatus);
                }
            }
            catch {
                /* ignore */
            }
        }
        void load();
        const interval = setInterval(() => void load(), 1500);
        return () => clearInterval(interval);
    }, []);
    const currentSprint = snapshot?.sprints.find((s) => s.id === snapshot.company.currentSprintId);
    const allTasks = snapshot?.tasks ?? [];
    const tasks = currentSprint
        ? allTasks.filter((t) => t.sprintId === currentSprint.id && t.kind !== "follow_up")
        : allTasks.filter((t) => t.kind !== "follow_up");
    const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
    const columns = [
        {
            title: "Planning",
            statuses: ["created", "planned"],
            tasks: tasks.filter((task) => ["created", "planned"].includes(task.status)),
        },
        {
            title: "In motion",
            statuses: ["in_progress", "verifying", "blocked"],
            tasks: tasks.filter((task) => ["in_progress", "verifying", "blocked"].includes(task.status)),
        },
        {
            title: "Finished",
            statuses: ["completed", "failed", "cancelled"],
            tasks: tasks.filter((task) => ["completed", "failed", "cancelled"].includes(task.status)),
        },
    ];
    useEffect(() => {
        if (!selectedTaskId && tasks[0]) {
            setSelectedTaskId(tasks[0].id);
            return;
        }
        if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) {
            setSelectedTaskId(tasks[0]?.id ?? null);
        }
    }, [tasks, selectedTaskId]);
    async function openArtifact(artifactId) {
        try {
            const response = await fetch(apiUrl(`/artifacts/${artifactId}`), { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Artifact not found.");
            }
            setExpandedArtifact((await response.json()));
        }
        catch {
            /* ignore for now */
        }
    }
    async function approveBoardReview() {
        try {
            const response = await fetch(apiUrl("/board-review/approve"), { method: "POST" });
            if (!response.ok) {
                return;
            }
            const [companyResponse, orchestratorResponse] = await Promise.all([
                fetch(apiUrl("/company"), { cache: "no-store" }),
                fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
            ]);
            if (companyResponse.ok) {
                setSnapshot((await companyResponse.json()));
            }
            if (orchestratorResponse.ok) {
                const orchestrator = (await orchestratorResponse.json());
                setExecutionStatus(orchestrator.executionStatus);
            }
        }
        catch {
            /* ignore for now */
        }
    }
    const selectedTaskArtifactIds = selectedTask?.artifactIds ?? [];
    const queuedFollowUpTasks = tasks.filter((task) => task.kind === "follow_up" && ["created", "planned"].includes(task.status));
    const pendingApprovals = snapshot?.approvals.filter((approval) => approval.status === "pending") ?? [];
    return (_jsxs(PageShell, { title: "Task Pipeline", description: "Tasks move through planning, execution, and completion.", children: [_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Badge, { variant: executionStatus === "awaiting_board_review" ? "secondary" : "outline", children: executionStatus }), currentSprint ? (_jsxs(Badge, { variant: currentSprint.status === "completed" ? "secondary" : "outline", children: ["Sprint ", currentSprint.number, " \u00B7 ", currentSprint.status === "completed" ? "Done" : currentSprint.status === "executing" ? "Executing" : currentSprint.status] })) : null] }), _jsxs("div", { className: "grid grid-cols-3 gap-px border border-[var(--swiss-gray-100)]", children: [_jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: "Tasks" }), _jsx("div", { className: "mt-1 text-2xl font-semibold", children: tasks.length })] }), _jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: "Live" }), _jsx("div", { className: "mt-1 text-2xl font-semibold", children: tasks.filter((task) => ["in_progress", "verifying"].includes(task.status)).length })] }), _jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: "Blocked / failed" }), _jsx("div", { className: "mt-1 text-2xl font-semibold", children: tasks.filter((task) => ["blocked", "failed"].includes(task.status)).length })] })] }), executionStatus === "done" ? (_jsx("div", { className: "border border-[var(--swiss-black)] p-5", children: _jsx("div", { className: "flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between", children: _jsxs("div", { children: [_jsx("div", { className: "text-lg font-semibold", children: currentSprint?.status === "completed"
                                            ? `Sprint ${currentSprint.number} complete`
                                            : "Execution cycle complete" }), _jsx("div", { className: "mt-1 text-sm text-[var(--swiss-gray-400)]", children: currentSprint?.status === "completed"
                                            ? `Sprint ${currentSprint.number} complete — CEO is proposing Sprint ${currentSprint.number + 1}. Check the CEO chat.`
                                            : queuedFollowUpTasks.length > 0
                                                ? `${queuedFollowUpTasks.length} follow-up task${queuedFollowUpTasks.length === 1 ? " is" : "s are"} queued for the next cycle.`
                                                : "The current execution cycle is complete. Review the finished package or start the next instruction cycle." })] }) }) })) : null, pendingApprovals.length > 0 ? (_jsx("div", { className: "border border-[var(--swiss-red)] p-5", children: _jsxs("div", { className: "flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between", children: [_jsxs("div", { children: [_jsx("div", { className: "text-lg font-semibold", children: "Board approval required" }), _jsxs("div", { className: "mt-1 text-sm text-[var(--swiss-gray-400)]", children: [pendingApprovals.length, " approval request", pendingApprovals.length === 1 ? " is" : "s are", " pending."] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "swiss-caption", children: pendingApprovals[0]?.title }), _jsx(Button, { size: "sm", onClick: async () => {
                                                for (const a of pendingApprovals) {
                                                    await fetch(apiUrl(`/approvals/${a.id}/resolve`), {
                                                        method: "POST",
                                                        headers: { "Content-Type": "application/json" },
                                                        body: JSON.stringify({ action: "approved" }),
                                                    });
                                                }
                                                const res = await fetch(apiUrl("/company"), { cache: "no-store" });
                                                if (res.ok)
                                                    setSnapshot((await res.json()));
                                            }, children: "Approve" }), _jsx(Button, { size: "sm", variant: "outline", onClick: async () => {
                                                for (const a of pendingApprovals) {
                                                    await fetch(apiUrl(`/approvals/${a.id}/resolve`), {
                                                        method: "POST",
                                                        headers: { "Content-Type": "application/json" },
                                                        body: JSON.stringify({ action: "dismissed" }),
                                                    });
                                                }
                                                const res = await fetch(apiUrl("/company"), { cache: "no-store" });
                                                if (res.ok)
                                                    setSnapshot((await res.json()));
                                            }, children: "Dismiss" })] })] }) })) : null, _jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Execution model" }), _jsxs(CardDescription, { children: [_jsx("span", { className: "font-medium", children: "awaiting_board_review" }), " is the exception path. The board only intervenes when policy, risk, or unresolved blockers require it."] })] }), _jsxs(CardContent, { className: "grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_360px]", children: [_jsx("div", { className: "grid gap-4 xl:grid-cols-3", children: columns.map((column) => (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-2", children: [_jsxs("div", { children: [_jsx("div", { className: "font-semibold", children: column.title }), _jsxs("div", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: [column.tasks.length, " task", column.tasks.length === 1 ? "" : "s"] })] }), _jsx(ArrowRight, { className: "h-4 w-4 text-[var(--swiss-gray-200)]" })] }), _jsx("div", { className: "space-y-2", children: column.tasks.length === 0 ? (_jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]", children: "No tasks in this stage." })) : (column.tasks.map((task) => {
                                                        const selected = task.id === selectedTask?.id;
                                                        return (_jsxs("button", { type: "button", onClick: () => setSelectedTaskId(task.id), className: `w-full border p-3 text-left transition ${selected ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`, children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: `truncate font-semibold ${selected ? "text-[var(--swiss-white)]" : ""}`, children: task.title }), _jsxs("div", { className: `mt-1 swiss-caption ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-300)]"}`, children: [task.kind.replace(/_/g, " "), " \u00B7 ", task.assignedRole] })] }), _jsx(Badge, { variant: selected ? "secondary" : taskTone(task.status), children: task.status })] }), _jsx("div", { className: `mt-3 text-xs leading-5 ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-400)]"}`, children: task.deliverable })] }, task.id));
                                                    })) })] }, column.title))) }), _jsx("div", { className: "border border-[var(--swiss-gray-100)] p-4", children: selectedTask ? (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: "Task spotlight" }), _jsx("div", { className: "mt-2 text-xl font-semibold", children: selectedTask.title }), _jsx("div", { className: "mt-1 text-sm leading-6 text-[var(--swiss-gray-400)]", children: selectedTask.description })] }), _jsx(Badge, { variant: taskTone(selectedTask.status), children: selectedTask.status })] }), _jsx("hr", { className: "swiss-rule" }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-4 text-sm", children: [_jsxs("div", { children: [_jsx("span", { className: "font-medium", children: "Kind:" }), " ", selectedTask.kind.replace(/_/g, " ")] }), _jsxs("div", { children: [_jsx("span", { className: "font-medium", children: "Assigned role:" }), " ", selectedTask.assignedRole] }), _jsxs("div", { children: [_jsx("span", { className: "font-medium", children: "Deliverable:" }), " ", selectedTask.deliverable] }), _jsxs("div", { children: [_jsx("span", { className: "font-medium", children: "Depends on:" }), " ", selectedTask.dependsOnTaskIds.length === 0 ? "none" : selectedTask.dependsOnTaskIds.length] }), selectedTask.localPreviewUrl ? _jsxs("div", { children: [_jsx("span", { className: "font-medium", children: "Preview:" }), " ", selectedTask.localPreviewUrl] }) : null, _jsxs("div", { children: [_jsx("span", { className: "font-medium", children: "Verified:" }), " ", selectedTask.verifierState.isVerified ? "yes" : "not yet"] })] }), selectedTask.verifierState.feedback ? (_jsxs("div", { className: "border-l-2 border-[var(--swiss-black)] pl-4 py-3", children: [_jsx("div", { className: "mb-2 swiss-caption", children: "Verification feedback" }), _jsx("div", { className: "text-sm leading-6", children: selectedTask.verifierState.feedback })] })) : null, _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-4", children: [_jsx("div", { className: "mb-2 swiss-caption", children: "Definition of done" }), _jsx("div", { className: "space-y-2 text-sm", children: selectedTask.definitionOfDone.map((item) => (_jsx("div", { className: "border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2", children: item }, item))) })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-4", children: [_jsx("div", { className: "mb-2 swiss-caption", children: "Execution evidence" }), selectedTask.executorState.results.length === 0 && selectedTask.executorState.commandsExecuted.length === 0 ? (_jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]", children: "No execution evidence yet." })) : (_jsxs("div", { className: "space-y-2 text-sm", children: [selectedTask.executorState.commandsExecuted.map((command) => (_jsxs("div", { className: "truncate border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2 font-mono text-xs", children: ["$ ", command] }, command))), selectedTask.executorState.results.map((result) => (_jsx("div", { className: "truncate border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2", children: result }, result)))] }))] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-4", children: [_jsx("div", { className: "mb-2 swiss-caption", children: "Artifacts" }), selectedTaskArtifactIds.length === 0 ? (_jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]", children: "No artifacts attached to this task." })) : (_jsx("div", { className: "space-y-2", children: selectedTaskArtifactIds.map((artifactId) => (_jsxs("button", { type: "button", onClick: () => void openArtifact(artifactId), className: "w-full border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2 text-left text-sm text-[var(--swiss-blue)] hover:border-[var(--swiss-gray-200)]", children: ["View artifact ", artifactId] }, artifactId))) }))] }), executionStatus === "awaiting_board_review" && selectedTask.kind === "board_handoff" ? (_jsxs("div", { className: "border-l-2 border-[var(--swiss-black)] pl-4 py-3", children: [_jsx("div", { className: "text-sm font-semibold", children: "Board action required" }), _jsx("div", { className: "mt-1 text-sm text-[var(--swiss-gray-400)]", children: "Review the handoff artifact, then approve this package." }), _jsx(Button, { className: "mt-3", onClick: () => void approveBoardReview(), children: "Approve Board Review" })] })) : null] })) : (_jsx("div", { className: "text-sm text-[var(--swiss-gray-300)]", children: "Select a task from the board to inspect it." })) })] })] })] }), expandedArtifact ? (_jsx("div", { className: "fixed inset-0 z-30 flex items-center justify-center bg-[var(--swiss-black)]/50 p-4", children: _jsxs("div", { className: "flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)]", children: [_jsxs("div", { className: "flex items-start justify-between gap-3 border-b border-[var(--swiss-gray-100)] px-5 py-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-lg font-semibold", children: expandedArtifact.title }), _jsxs("div", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: [expandedArtifact.agent, " \u00B7 ", expandedArtifact.kind, " \u00B7 ", new Date(expandedArtifact.createdAt).toLocaleTimeString()] })] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => setExpandedArtifact(null), children: _jsx(X, { className: "h-4 w-4" }) })] }), _jsx("div", { className: "overflow-y-auto px-5 py-4", children: _jsx("div", { className: "markdown-content text-sm leading-7", children: _jsx(ReactMarkdown, { children: expandedArtifact.content }) }) }), _jsx(Separator, {}), _jsx("div", { className: "flex justify-end px-5 py-3", children: _jsx(Button, { variant: "outline", onClick: () => setExpandedArtifact(null), children: "Close" }) })] }) })) : null] }));
}
