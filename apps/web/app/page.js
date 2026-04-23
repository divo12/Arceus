"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Activity, AlertCircle, ArrowUpRight, ChevronDown, Cpu, FileCode, Inbox, LoaderCircle, Monitor, Play, Terminal, Users, X, Zap } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { apiUrl } from "../lib/api";
import { useChatMessages } from "../components/chat/chat-context";
import { ResizableSplit } from "../components/resizable-split";
const ROLE_COLORS = {
    ceo: "text-[var(--swiss-black)]",
    cto: "text-[var(--swiss-blue)]",
    pm: "text-[var(--swiss-black)]",
    developer: "text-[var(--swiss-black)]",
    tester: "text-[var(--swiss-black)]",
    ui_designer: "text-[var(--swiss-black)]",
    marketing: "text-[var(--swiss-black)]",
    skills_lead: "text-[var(--swiss-black)]",
    system: "text-[var(--swiss-gray-400)]",
};
const TYPE_ICONS = {
    file_edit: FileCode,
    shell: Terminal,
    working: LoaderCircle,
    error: AlertCircle,
    idle: Activity,
    info: Activity,
};
// Chat storage moved to ChatProvider (components/chat-context.tsx)
const emptyProductOverview = {
    root: "",
    preview: {
        status: "idle",
        url: null,
        entryUrl: null,
        validationUrl: null,
        validationStrategy: null,
        targetKind: null,
        runtime: null,
        framework: null,
        command: null,
        targetPath: null,
        port: 3210,
        lastError: null,
        startedAt: null,
    },
    files: [],
};
const emptySnapshot = {
    company: {
        id: "company_pending",
        name: "Arceus",
        boardOwner: "board_primary",
        goal: "",
        budgetCents: 0,
        spentCents: 0,
        status: "ideation",
        currentStrategyId: "strategy_pending",
        currentSprintId: null,
        currentSprintNumber: null,
        createdAt: new Date(0).toISOString()
    },
    idea: {
        id: "idea_pending",
        companyId: "company_pending",
        coreIdea: "",
        currentDirection: "",
        refinedWithBoard: false
    },
    strategy: {
        id: "strategy_pending",
        companyId: "company_pending",
        title: "CEO workspace is waiting for your first message",
        summary: "Describe what you want the company to build. The CEO will narrow it into a real first release and propose the initial org chart.",
        firstRelease: "",
        scopeBoundary: [],
        roleRationale: [],
        status: "draft",
        createdByAgentId: "agent_ceo",
        createdAt: new Date(0).toISOString()
    },
    sprints: [],
    hierarchy: [],
    agents: [],
    sessions: [],
    tasks: [],
    artifacts: [],
    chatMessages: [],
    meetings: [],
    meetingSchedules: [],
    approvals: [],
    memories: [],
    memoryUnits: [],
    habits: [],
    priming: [],
    transitions: [],
    feedbackRounds: []
};
function formatCurrency(cents) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
    }).format(cents / 100);
}
function createId() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
}
async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }
    return (await response.json());
}
function describeApiError(error) {
    if (error instanceof Error) {
        if (error.message === "Failed to fetch") {
            return "Runtime status is temporarily unavailable.";
        }
        return error.message;
    }
    return "Runtime status is temporarily unavailable.";
}
function extractArtifactId(content) {
    const match = content.match(/\/api\/artifacts\/([a-zA-Z0-9_-]+)/);
    return match?.[1] ?? null;
}
function taskTone(status) {
    if (["completed"].includes(status))
        return "secondary";
    if (["failed", "blocked", "cancelled"].includes(status))
        return "destructive";
    if (["in_progress", "planned", "verifying"].includes(status))
        return "outline";
    return "outline";
}
function buildStrategyPayload(card) {
    if (!card.strategy) {
        throw new Error("Strategy proposal is missing structured strategy data.");
    }
    // Deduplicate roles — classifier can produce duplicates.
    // Keep first occurrence of each role type.
    const seen = new Set();
    const uniqueRoles = card.strategy.roles.filter((r) => {
        if (seen.has(r.role))
            return false;
        seen.add(r.role);
        return true;
    });
    // Ensure the 4 core roles exist (ceo, cto, pm, developer).
    // If classifier omitted any, add minimal defaults.
    const coreDefaults = [
        { role: "ceo", title: "Chief Executive Officer", parent_role: null, capabilities: ["Strategic leadership"] },
        { role: "cto", title: "Chief Technology Officer", parent_role: "ceo", capabilities: ["Technical architecture"] },
        { role: "pm", title: "Product Manager", parent_role: "cto", capabilities: ["Product scope and delivery"] },
        { role: "developer", title: "Software Developer", parent_role: "pm", capabilities: ["Implementation"] },
    ];
    for (const def of coreDefaults) {
        if (!uniqueRoles.some((r) => r.role === def.role)) {
            uniqueRoles.push(def);
        }
    }
    return {
        strategy_title: card.title,
        summary: card.summary,
        first_release: card.strategy.first_release,
        scope_boundary: card.strategy.scope_boundary,
        role_rationale: card.strategy.role_rationale,
        roles: uniqueRoles,
    };
}
function toLines(value) {
    return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}
function stageLabel(stage) {
    return stage.replace(/_/g, " ");
}
function formatRelativeTime(value) {
    if (!value) {
        return "just now";
    }
    const delta = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(delta) || delta < 0) {
        return "just now";
    }
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1)
        return "just now";
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
function getPreviewHref(productOverview, buildTaskWithPreview) {
    return productOverview.preview.entryUrl
        ?? productOverview.preview.validationUrl
        ?? productOverview.preview.url
        ?? buildTaskWithPreview?.localPreviewUrl
        ?? null;
}
function buildReturnSummary({ executionStatus, activeTasks, pendingApprovals, previewHref, latestProductFile, developerSession, recentMeeting, }) {
    const bullets = [];
    if (developerSession?.stallReason) {
        bullets.push(`Developer stall diagnosis: ${developerSession.stallReason}`);
    }
    else if (developerSession?.lastEventSummary) {
        bullets.push(`Developer last moved ${formatRelativeTime(developerSession.lastEventAt)}: ${developerSession.lastEventSummary}`);
    }
    if (previewHref) {
        bullets.push("A runnable preview is available for the current build.");
    }
    else if (executionStatus !== "idle") {
        bullets.push("Execution is active, but the product preview is not ready yet.");
    }
    if (activeTasks.length > 0) {
        bullets.push(`${activeTasks.length} task${activeTasks.length === 1 ? " is" : "s are"} in the current operating lane.`);
    }
    if (pendingApprovals.length > 0) {
        bullets.push(`${pendingApprovals.length} board approval request${pendingApprovals.length === 1 ? " is" : "s are"} waiting.`);
    }
    if (latestProductFile?.path) {
        bullets.push(`Latest workspace change: ${latestProductFile.path}`);
    }
    if (recentMeeting) {
        bullets.push(`Last meeting: ${recentMeeting.title}`);
    }
    if (bullets.length === 0) {
        bullets.push("The company is waiting for its first board directive.");
    }
    const headline = developerSession?.stallReason
        ? "The team needs intervention before momentum returns."
        : previewHref
            ? "The company has moved from planning into something you can inspect live."
            : executionStatus === "done"
                ? "This cycle is complete and ready for the next board decision."
                : executionStatus === "idle"
                    ? "The boardroom is ready for a first direction."
                    : "The company is actively executing the current plan.";
    return { headline, bullets };
}
function StringList({ title, items }) {
    if (items.length === 0) {
        return null;
    }
    return (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-400)]", children: title }), _jsx("div", { className: "mt-2 space-y-2 text-[0.8125rem] text-[var(--swiss-black)]", children: items.map((item, index) => (_jsx("div", { className: "border-b border-[var(--swiss-gray-100)] pb-2 last:border-0 last:pb-0", children: item }, `${title}-${index}`))) })] }));
}
function CardStageHeader({ stage, label }) {
    return (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Badge, { variant: "outline", children: label }), _jsx(Badge, { variant: "secondary", children: stageLabel(stage) })] }));
}
function RoleEditor({ role, onChange, }) {
    return (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between gap-2", children: [_jsx(Badge, { variant: "outline", children: role.role }), _jsxs("span", { className: "swiss-caption text-[var(--swiss-gray-300)]", children: ["reports to ", role.parent_role ?? "board"] })] }), _jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Title" }), _jsx("input", { className: "mb-3 w-full border border-[var(--swiss-gray-200)] px-3 py-2 text-[0.8125rem] outline-none focus:border-[var(--swiss-black)]", value: role.title, onChange: (event) => onChange({ ...role, title: event.target.value }) }), _jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Capabilities" }), _jsx(Textarea, { value: role.capabilities.join("\n"), onChange: (event) => onChange({ ...role, capabilities: toLines(event.target.value) }) })] }));
}
function MeetingIntentSummary({ meeting }) {
    if (!meeting.create)
        return null;
    return (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Badge, { variant: "outline", children: meeting.type?.replace(/_/g, " ") ?? "meeting" }), _jsxs(Badge, { variant: "outline", children: [meeting.task_deltas.length, " task delta", meeting.task_deltas.length === 1 ? "" : "s"] })] }), _jsx("div", { className: "mt-2 text-[0.8125rem] font-medium text-[var(--swiss-black)]", children: meeting.summary }), _jsx("div", { className: "mt-1 text-[0.8125rem] text-[var(--swiss-gray-500)]", children: meeting.rationale }), meeting.task_deltas.length > 0 ? (_jsx("div", { className: "mt-3 space-y-2", children: meeting.task_deltas.map((delta, index) => (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] px-3 py-2 text-xs", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Badge, { variant: "outline", children: delta.action }), _jsx(Badge, { variant: "outline", children: delta.assigned_role }), _jsx(Badge, { variant: "outline", children: delta.priority })] }), _jsx("div", { className: "mt-2 font-medium text-[var(--swiss-black)]", children: delta.title }), _jsx("div", { className: "mt-1 leading-5 text-[var(--swiss-gray-500)]", children: delta.details })] }, `${delta.title}-${index}`))) })) : null] }));
}
function WelcomeBriefView({ card, disabled, onChoose }) {
    return (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx(CardTitle, { children: card.title }), _jsx(CardDescription, { children: "The CEO is framing the first boardroom move." })] }), _jsx(CardStageHeader, { stage: card.stage, label: "Launch brief" })] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsx("div", { className: "border-l-2 border-[var(--swiss-black)] pl-3 text-[0.8125rem] text-[var(--swiss-gray-500)]", children: card.welcome.headline }), _jsx(StringList, { title: "Next steps", items: card.welcome.next_steps }), _jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-2 text-[var(--swiss-gray-400)]", children: "Suggested prompts" }), _jsx("div", { className: "flex flex-wrap gap-2", children: card.welcome.suggested_prompts.map((prompt) => (_jsx(Button, { variant: "outline", size: "sm", disabled: disabled, onClick: () => onChoose(prompt), children: prompt }, prompt))) })] })] })] }));
}
function MissionBriefView({ card, disabled, onChoose }) {
    return (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx(CardTitle, { children: card.title }), _jsx(CardDescription, { children: "The CEO is tightening the mission before team and sprint kickoff." })] }), _jsx(CardStageHeader, { stage: card.stage, label: "Mission brief" })] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid gap-3", children: [_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-400)]", children: "Mission" }), _jsx("div", { className: "mt-2 text-[0.8125rem] leading-6", children: card.mission.mission_statement })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-400)]", children: "Target user" }), _jsx("div", { className: "mt-2 text-[0.8125rem] leading-6", children: card.mission.target_user })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-400)]", children: "Problem" }), _jsx("div", { className: "mt-2 text-[0.8125rem] leading-6", children: card.mission.problem })] })] }), _jsx(StringList, { title: "Differentiators", items: card.mission.differentiators }), _jsxs("div", { className: "grid gap-3", children: [_jsx(StringList, { title: "Assumptions", items: card.mission.assumptions }), _jsx(StringList, { title: "Unknowns", items: card.mission.unknowns })] }), _jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-2 text-[var(--swiss-gray-400)]", children: "Board replies" }), _jsx("div", { className: "flex flex-wrap gap-2", children: card.mission.suggested_replies.map((reply) => (_jsx(Button, { variant: "outline", size: "sm", disabled: disabled, onClick: () => onChoose(reply), children: reply }, reply))) })] })] })] }));
}
function StrategyProposalEditor({ card, busy, resolved, onApprove, }) {
    if (!card.strategy) {
        return (_jsx(Card, { className: "border-[var(--swiss-red)]", children: _jsx(CardContent, { className: "pt-5 text-[0.8125rem] text-[var(--swiss-red)]", children: "The strategy proposal card is missing structured strategy data." }) }));
    }
    const [draft, setDraft] = useState(card);
    return (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx(CardTitle, { children: draft.title }), _jsx(CardDescription, { children: "Editable strategy proposal selected by the CEO card classifier." })] }), _jsx("div", { className: "flex items-center gap-2", children: _jsx(CardStageHeader, { stage: draft.stage, label: resolved ? "Approved" : "Needs board action" }) })] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Strategy Title" }), _jsx("input", { className: "w-full border border-[var(--swiss-gray-200)] px-3 py-2 text-[0.8125rem] outline-none focus:border-[var(--swiss-black)]", value: draft.title, onChange: (event) => setDraft((current) => ({ ...current, title: event.target.value })), disabled: resolved })] }), _jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Summary" }), _jsx(Textarea, { value: draft.summary, onChange: (event) => setDraft((current) => ({ ...current, summary: event.target.value })), disabled: resolved })] }), _jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "First Release" }), _jsx(Textarea, { className: "min-h-[70px]", value: draft.strategy.first_release, onChange: (event) => setDraft((current) => ({
                                    ...current,
                                    strategy: { ...current.strategy, first_release: event.target.value },
                                })), disabled: resolved })] }), _jsxs("div", { className: "grid gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Scope Boundary" }), _jsx(Textarea, { className: "min-h-[120px]", value: draft.strategy.scope_boundary.join("\n"), onChange: (event) => setDraft((current) => ({
                                            ...current,
                                            strategy: { ...current.strategy, scope_boundary: toLines(event.target.value) },
                                        })), disabled: resolved })] }), _jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Role Rationale" }), _jsx(Textarea, { className: "min-h-[120px]", value: draft.strategy.role_rationale.join("\n"), onChange: (event) => setDraft((current) => ({
                                            ...current,
                                            strategy: { ...current.strategy, role_rationale: toLines(event.target.value) },
                                        })), disabled: resolved })] })] }), _jsxs("div", { className: "grid gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Execution Sequence" }), _jsx(Textarea, { className: "min-h-[120px]", value: draft.strategy.execution_sequence.join("\n"), onChange: (event) => setDraft((current) => ({
                                            ...current,
                                            strategy: { ...current.strategy, execution_sequence: toLines(event.target.value) },
                                        })), disabled: resolved })] }), _jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Board Checkpoints" }), _jsx(Textarea, { className: "min-h-[120px]", value: draft.strategy.board_checkpoints.join("\n"), onChange: (event) => setDraft((current) => ({
                                            ...current,
                                            strategy: { ...current.strategy, board_checkpoints: toLines(event.target.value) },
                                        })), disabled: resolved })] }), _jsxs("div", { children: [_jsx("label", { className: "swiss-caption mb-1 block text-[var(--swiss-gray-400)]", children: "Key Risks" }), _jsx(Textarea, { className: "min-h-[120px]", value: draft.strategy.key_risks.join("\n"), onChange: (event) => setDraft((current) => ({
                                            ...current,
                                            strategy: { ...current.strategy, key_risks: toLines(event.target.value) },
                                        })), disabled: resolved })] })] }), _jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-400)]", children: "Team Structure" }), _jsx("div", { className: "grid gap-3", children: draft.strategy.roles.map((role, index) => (_jsx(RoleEditor, { role: role, onChange: (nextRole) => setDraft((current) => ({
                                        ...current,
                                        strategy: {
                                            ...current.strategy,
                                            roles: current.strategy.roles.map((entry, entryIndex) => (entryIndex === index ? nextRole : entry)),
                                        },
                                    })) }, `${role.role}-${index}`))) })] }), _jsx("div", { className: "flex flex-wrap items-center justify-end gap-2", children: _jsxs(Button, { disabled: busy || resolved, onClick: () => void onApprove(draft, true), children: [busy ? _jsx(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : _jsx(Play, { className: "h-4 w-4" }), resolved ? "Approved" : "Approve & Execute"] }) })] })] }));
}
function ClarifyingQuestionView({ card, disabled, onChoose, }) {
    if (!card.question) {
        return (_jsx(Card, { className: "border-[var(--swiss-red)]", children: _jsx(CardContent, { className: "pt-5 text-[0.8125rem] text-[var(--swiss-red)]", children: "The clarifying question card is missing question data." }) }));
    }
    return (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx(CardTitle, { children: card.title }), _jsx(CardDescription, { children: "The CEO is asking the board to narrow the problem." })] }), _jsx(CardStageHeader, { stage: card.stage, label: "Clarifying question" })] }) }), _jsxs(CardContent, { className: "space-y-3", children: [_jsx("p", { className: "text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)]", children: card.question.prompt }), _jsx("div", { className: "border-l-2 border-[var(--swiss-black)] pl-3 text-[0.8125rem] text-[var(--swiss-gray-500)]", children: card.question.why_now }), _jsx("div", { className: "flex flex-wrap gap-2", children: card.question.options.map((option) => (_jsx(Button, { variant: "outline", size: "sm", disabled: disabled, onClick: () => onChoose(option), children: option }, option))) })] })] }));
}
function StatusUpdateView({ card, disabled, onChoose }) {
    return (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx(CardTitle, { children: card.title }), _jsx(CardStageHeader, { stage: card.stage, label: "Operating update" })] }) }), _jsxs(CardContent, { className: "space-y-3", children: [_jsx(MeetingIntentSummary, { meeting: card.meeting }), _jsx("p", { className: "text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)]", children: card.summary }), card.status ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "border border-[var(--swiss-gray-100)] p-3 text-[0.8125rem] font-medium", children: card.status.headline }), _jsxs("div", { className: "grid gap-3", children: [_jsx(StringList, { title: "Current focus", items: card.status.current_focus }), _jsx(StringList, { title: "Blockers", items: card.status.blockers }), _jsx(StringList, { title: "Next actions", items: card.status.next_actions })] }), card.status.board_requests.length > 0 ? (_jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-2 text-[var(--swiss-gray-400)]", children: "Board requests" }), _jsx("div", { className: "flex flex-wrap gap-2", children: card.status.board_requests.map((request) => (_jsx(Button, { variant: "outline", size: "sm", disabled: disabled, onClick: () => onChoose(request), children: request }, request))) })] })) : null] })) : null] })] }));
}
function SprintProposalView({ card, busy, resolved, onApprove, onReject, }) {
    const proposal = card.sprint_proposal;
    if (!proposal)
        return null;
    const priorityColor = (p) => {
        if (p === "critical")
            return "text-red-600";
        if (p === "high")
            return "text-orange-500";
        return "text-[var(--swiss-gray-400)]";
    };
    return (_jsxs(Card, { children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx(CardTitle, { children: card.title || "Sprint Proposal" }), _jsx(Badge, { variant: "outline", className: "text-[0.625rem]", children: "Sprint Proposal" })] }), _jsx(CardDescription, { children: proposal.sprint_goal })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsx("p", { className: "text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)]", children: proposal.rationale }), _jsxs("div", { children: [_jsxs("div", { className: "swiss-caption mb-2 text-[var(--swiss-gray-400)]", children: ["Proposed Tasks (", proposal.key_tasks.length, ")"] }), _jsx("div", { className: "space-y-1.5", children: proposal.key_tasks.map((task, i) => (_jsxs("div", { className: "flex items-center gap-2 rounded border border-[var(--swiss-gray-100)] px-3 py-2 text-[0.8125rem]", children: [_jsx("span", { className: "min-w-0 flex-1 truncate font-medium", children: task.title }), _jsx(Badge, { variant: "outline", className: "shrink-0 text-[0.5625rem]", children: task.assigned_role }), _jsx("span", { className: `shrink-0 text-[0.625rem] font-mono ${priorityColor(task.priority)}`, children: task.priority }), task.depends_on.length > 0 ? (_jsxs("span", { className: "shrink-0 text-[0.5625rem] text-[var(--swiss-gray-300)]", title: task.depends_on.join(", "), children: ["dep: ", task.depends_on.length] })) : null] }, i))) })] }), proposal.carried_forward.length > 0 ? (_jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-1 text-[var(--swiss-gray-400)]", children: "Carried forward" }), _jsx("ul", { className: "list-disc pl-4 text-[0.8125rem] text-[var(--swiss-gray-500)]", children: proposal.carried_forward.map((item, i) => _jsx("li", { children: item }, i)) })] })) : null, proposal.risks.length > 0 ? (_jsxs("div", { children: [_jsx("div", { className: "swiss-caption mb-1 text-[var(--swiss-gray-400)]", children: "Risks" }), _jsx("ul", { className: "list-disc pl-4 text-[0.8125rem] text-[var(--swiss-gray-500)]", children: proposal.risks.map((risk, i) => _jsx("li", { children: risk }, i)) })] })) : null, !resolved ? (_jsxs("div", { className: "flex gap-2 pt-2", children: [_jsxs(Button, { size: "sm", disabled: busy, onClick: onApprove, children: [busy ? _jsx(LoaderCircle, { className: "mr-1 h-3 w-3 animate-spin" }) : _jsx(Play, { className: "mr-1 h-3 w-3" }), "Approve & Start Sprint"] }), _jsx(Button, { size: "sm", variant: "outline", disabled: busy, onClick: onReject, children: "Reject" })] })) : (_jsx(Badge, { variant: "secondary", className: "text-[0.625rem]", children: "Sprint approved" }))] })] }));
}
function LaunchBoardPanel({ disabled, onPrompt }) {
    const prompts = [
        "Build a consumer app that helps parents coordinate school schedules and family logistics.",
        "Create an internal SaaS tool that helps support teams summarize customer issues and draft replies.",
        "I want a lightweight B2B product for finance teams to track renewal risk and upsell timing.",
        "Help me turn an idea for a note-taking product into a focused first release and team plan.",
    ];
    return (_jsx("div", { className: "mx-auto flex h-full max-w-3xl flex-col justify-center gap-4 text-left", children: _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-6", children: [_jsx("div", { className: "flex items-start justify-between gap-4", children: _jsxs("div", { children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-gray-400)]", children: "CEO launch room" }), _jsx("div", { className: "swiss-h1 mt-3", children: "Start with a product direction." }), _jsx("div", { className: "mt-2 text-[0.8125rem] leading-6 text-[var(--swiss-gray-400)]", children: "This boardroom is built for staged decisions: idea framing, mission pressure-testing, org design, kickoff, and execution updates." })] }) }), _jsx("hr", { className: "swiss-rule my-5" }), _jsx("div", { className: "grid gap-3 md:grid-cols-2", children: prompts.map((prompt) => (_jsx("button", { type: "button", className: "border border-[var(--swiss-gray-200)] p-4 text-left text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)] transition hover:border-[var(--swiss-black)] hover:text-[var(--swiss-black)] disabled:cursor-not-allowed disabled:opacity-40", disabled: disabled, onClick: () => onPrompt(prompt), children: prompt }, prompt))) })] }) }));
}
export default function Page() {
    const [snapshot, setSnapshot] = useState(emptySnapshot);
    const [runtime, setRuntime] = useState(null);
    const [composer, setComposer] = useState("");
    const { messages: rawMessages, setMessages: setRawMessages, resolvedProposalIds, setResolvedProposalIds, clearMessages } = useChatMessages();
    const messages = rawMessages;
    const setMessages = setRawMessages;
    const [isPending, startTransition] = useTransition();
    const [isStreaming, setIsStreaming] = useState(false);
    const [runtimeError, setRuntimeError] = useState(null);
    const [activityEvents, setActivityEvents] = useState([]);
    const [executionStatus, setExecutionStatus] = useState("idle");
    const [orchestratorStatus, setOrchestratorStatus] = useState(null);
    const [proposalActionId, setProposalActionId] = useState(null);
    const [quickExecuting, setQuickExecuting] = useState(false);
    const [stoppingExecution, setStoppingExecution] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [expandedArtifact, setExpandedArtifact] = useState(null);
    const [productOverview, setProductOverview] = useState(emptyProductOverview);
    const chatEndRef = useRef(null);
    const [inboxOpen, setInboxOpen] = useState(false);
    const [sprintOpen, setSprintOpen] = useState(false);
    const [heartbeatStatus, setHeartbeatStatus] = useState(null);
    const [heartbeatHistory, setHeartbeatHistory] = useState([]);
    async function loadState(options) {
        const [companyResult, runtimeResult] = await Promise.allSettled([
            fetchJson(apiUrl("/company")),
            fetchJson(apiUrl("/runtime")),
        ]);
        if (companyResult.status === "fulfilled") {
            setSnapshot(companyResult.value);
        }
        if (runtimeResult.status === "fulfilled") {
            setRuntime(runtimeResult.value);
        }
        if (runtimeResult.status === "fulfilled") {
            setRuntimeError(null);
            return;
        }
        if (options?.suppressRuntimeError) {
            return;
        }
        if (companyResult.status === "fulfilled") {
            setRuntimeError("Runtime status is temporarily unavailable.");
            return;
        }
        setRuntimeError(describeApiError(runtimeResult.reason));
    }
    async function loadExecutionTelemetry() {
        try {
            const [activityResponse, orchestratorResponse, companyResponse, productResponse, heartbeatStatusResponse, heartbeatHistoryResponse] = await Promise.all([
                fetch(apiUrl("/employee-activity"), { cache: "no-store" }),
                fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
                fetch(apiUrl("/company"), { cache: "no-store" }),
                fetch(apiUrl("/product/overview"), { cache: "no-store" }),
                fetch(apiUrl("/heartbeat/status"), { cache: "no-store" }),
                fetch(apiUrl("/heartbeat/history?limit=30"), { cache: "no-store" }),
            ]);
            if (activityResponse.ok) {
                setActivityEvents((await activityResponse.json()));
            }
            if (orchestratorResponse.ok) {
                const orchestrator = (await orchestratorResponse.json());
                setOrchestratorStatus(orchestrator);
                setExecutionStatus(orchestrator.executionStatus);
            }
            if (companyResponse.ok) {
                setSnapshot((await companyResponse.json()));
            }
            if (productResponse.ok) {
                setProductOverview((await productResponse.json()));
            }
            if (heartbeatStatusResponse.ok) {
                setHeartbeatStatus(await heartbeatStatusResponse.json());
            }
            if (heartbeatHistoryResponse.ok) {
                setHeartbeatHistory(await heartbeatHistoryResponse.json());
            }
        }
        catch {
            /* polling fallback should stay silent */
        }
    }
    useEffect(() => {
        void loadState();
        void loadExecutionTelemetry();
    }, []);
    // Chat persistence is handled by ChatProvider in layout.tsx.
    // No hydrate/persist effects needed here — state survives navigation.
    async function handleApproveBoardReview() {
        try {
            const response = await fetch(apiUrl("/board-review/approve"), {
                method: "POST",
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error ?? "Board review approval failed.");
            }
            const payload = (await response.json());
            await loadState();
            await loadExecutionTelemetry();
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: payload.queuedFollowUpCount || payload.resolvedApprovalCount
                        ? `Board approved the CTO handoff package. Execution is complete.${payload.queuedFollowUpCount ? ` ${payload.queuedFollowUpCount} follow-up task${payload.queuedFollowUpCount === 1 ? " is" : "s are"} queued for the next cycle.` : ""}${payload.resolvedApprovalCount ? ` ${payload.resolvedApprovalCount} approval request${payload.resolvedApprovalCount === 1 ? " was" : "s were"} resolved.` : ""}`
                        : "Board approved the CTO handoff package. Execution is now marked complete.",
                },
            ]);
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: error instanceof Error ? error.message : "Board review approval failed.",
                },
            ]);
        }
    }
    // Auto-scroll chat
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);
    // Activity SSE stream
    useEffect(() => {
        const es = new EventSource(apiUrl("/employee-activity/stream"));
        void loadExecutionTelemetry();
        es.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data);
                setActivityEvents((prev) => {
                    // Deduplicate by id
                    if (prev.some((e) => e.id === parsed.id))
                        return prev;
                    const next = [...prev, parsed];
                    // Keep last 200 events in UI
                    return next.length > 200 ? next.slice(-200) : next;
                });
            }
            catch { /* ignore */ }
        };
        es.onerror = () => {
            // EventSource will auto-reconnect
        };
        return () => es.close();
    }, []);
    useEffect(() => {
        const interval = setInterval(() => {
            void loadExecutionTelemetry();
        }, isStreaming || executionStatus !== "idle" || isResetting ? 1500 : 4000);
        return () => clearInterval(interval);
    }, [isStreaming, executionStatus, isResetting]);
    // Poll runtime status so the "Runtime status is temporarily unavailable"
    // banner self-heals once the API recovers. Without this, an initial-load
    // fetch failure latches the banner until the next user action.
    useEffect(() => {
        const interval = setInterval(() => {
            void loadState({ suppressRuntimeError: true });
        }, 5000);
        return () => clearInterval(interval);
    }, []);
    async function sendMessage(rawMessage) {
        const trimmed = (rawMessage ?? composer).trim();
        if (!trimmed)
            return;
        if (runtime && !runtime.chatReady) {
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: "The CEO cannot respond yet because the Azure deployment name is still missing. Set ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT and try again."
                }
            ]);
            return;
        }
        const userBubble = {
            id: createId(),
            role: "board",
            content: trimmed
        };
        setMessages((current) => [...current, userBubble]);
        if (!rawMessage) {
            setComposer("");
        }
        setIsStreaming(true);
        const ceoBubbleId = createId();
        setMessages((current) => [
            ...current,
            {
                id: ceoBubbleId,
                role: "ceo",
                content: ""
            }
        ]);
        const eventSource = new EventSource(`${apiUrl("/chat/ceo/stream")}?message=${encodeURIComponent(trimmed)}`);
        eventSource.addEventListener("token", (event) => {
            const payload = JSON.parse(event.data);
            setMessages((current) => current.map((message) => (message.id === ceoBubbleId ? { ...message, content: payload.content ?? message.content } : message)));
        });
        eventSource.addEventListener("proposal", (event) => {
            const card = JSON.parse(event.data);
            setMessages((current) => current.map((msg) => (msg.id === ceoBubbleId ? { ...msg, card } : msg)));
        });
        eventSource.addEventListener("meeting", (event) => {
            const payload = JSON.parse(event.data);
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: `CEO opened a ${payload.type.replace(/_/g, " ")} meeting: ${payload.summary}${payload.taskDeltaCount > 0 ? ` ${payload.taskDeltaCount} task delta${payload.taskDeltaCount === 1 ? " was" : "s were"} recorded.` : ""}`,
                },
            ]);
        });
        eventSource.addEventListener("done", async (event) => {
            const payload = JSON.parse(event.data);
            if (payload.snapshot) {
                setSnapshot(payload.snapshot);
            }
            await loadState();
            try {
                const orchRes = await fetch(apiUrl("/orchestrator/status"), { cache: "no-store" });
                if (orchRes.ok) {
                    const orch = (await orchRes.json());
                    setOrchestratorStatus(orch);
                    setExecutionStatus(orch.executionStatus);
                }
            }
            catch { /* ignore */ }
            setIsStreaming(false);
            eventSource.close();
        });
        eventSource.addEventListener("status", () => {
            return;
        });
        eventSource.onerror = async () => {
            eventSource.close();
            await loadState().catch(() => undefined);
            setIsStreaming(false);
            setMessages((current) => current.map((message) => message.id === ceoBubbleId && !message.content
                ? { ...message, role: "system", content: "The CEO runtime failed before returning a response." }
                : message));
        };
    }
    async function handleStrategyAction(messageId, card, execute) {
        setProposalActionId(messageId);
        try {
            const response = await fetch(apiUrl(`/strategy/${execute ? "execute" : "approve"}`), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(buildStrategyPayload(card)),
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error ?? "Strategy action failed.");
            }
            const payload = (await response.json());
            const nextSnapshot = "snapshot" in payload ? payload.snapshot : payload;
            setSnapshot(nextSnapshot);
            setResolvedProposalIds((current) => [...current, messageId]);
            if (execute) {
                setExecutionStatus("planning");
            }
            const teamSummary = nextSnapshot.agents.length > 0
                ? `\n\nTeam hired (${nextSnapshot.agents.length}):\n${nextSnapshot.agents.map((a) => `- ${a.name} — ${a.title} (${a.role})`).join("\n")}`
                : "";
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: execute
                        ? `Board approved the strategy and started execution.${teamSummary}\n\nCTO is planning tasks. Watch the Execution tab for progress.`
                        : `Board approved the strategy.${teamSummary}\n\nThe team is ready. Type a message to start execution.`,
                },
            ]);
            await loadState();
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: error instanceof Error ? error.message : "Strategy action failed.",
                },
            ]);
        }
        finally {
            setProposalActionId(null);
        }
    }
    async function handleSprintApproval(messageId) {
        setProposalActionId(messageId);
        try {
            const response = await fetch(apiUrl("/sprint-proposal/approve"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error ?? "Sprint approval failed.");
            }
            const result = (await response.json());
            setResolvedProposalIds((current) => [...current, messageId]);
            setExecutionStatus("executing");
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: `Sprint ${result.sprintNumber} approved with ${result.taskCount} tasks. Execution started.`,
                },
            ]);
            await loadState();
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                { id: createId(), role: "system", content: error instanceof Error ? error.message : "Sprint approval failed." },
            ]);
        }
        finally {
            setProposalActionId(null);
        }
    }
    async function handleSprintReject(messageId) {
        try {
            await fetch(apiUrl("/sprint-proposal/reject"), { method: "POST" });
            setMessages((current) => [
                ...current,
                { id: createId(), role: "system", content: "Sprint proposal rejected. You can chat with the CEO to request a revised proposal." },
            ]);
            await loadState();
        }
        catch {
            // silent — non-critical
        }
    }
    function handleQuestionOption(option) {
        startTransition(() => {
            void sendMessage(option);
        });
    }
    async function handleQuickExecute() {
        const trimmed = composer.trim();
        if (!trimmed)
            return;
        setQuickExecuting(true);
        setComposer("");
        setMessages((current) => [
            ...current,
            { id: createId(), role: "board", content: trimmed },
            { id: createId(), role: "system", content: "Quick execute: generating strategy and starting agents…" },
        ]);
        try {
            const response = await fetch(apiUrl("/quick-execute"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idea: trimmed }),
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error ?? "Quick execute failed.");
            }
            const payload = (await response.json());
            setSnapshot(payload.snapshot);
            setExecutionStatus("planning");
            setMessages((current) => [
                ...current,
                { id: createId(), role: "system", content: `Strategy applied. Execution started — CTO is planning, then developer will build in ./workspace/.` },
            ]);
            await loadState();
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                { id: createId(), role: "system", content: error instanceof Error ? error.message : "Quick execute failed." },
            ]);
        }
        finally {
            setQuickExecuting(false);
        }
    }
    async function openArtifact(artifactId) {
        try {
            const response = await fetch(apiUrl(`/artifacts/${artifactId}`), { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Artifact not found.");
            }
            const artifact = (await response.json());
            setExpandedArtifact(artifact);
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: error instanceof Error ? error.message : "Failed to load artifact.",
                },
            ]);
        }
    }
    async function handleReset() {
        setIsResetting(true);
        setRuntimeError(null);
        try {
            const response = await fetch(apiUrl("/company"), {
                method: "DELETE",
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error ?? `Reset failed with status ${response.status}.`);
            }
            const nextSnapshot = (await response.json());
            setSnapshot(nextSnapshot);
            clearMessages();
            setActivityEvents([]);
            setExpandedArtifact(null);
            setProductOverview(emptyProductOverview);
            setExecutionStatus("idle");
            setComposer("");
            setProposalActionId(null);
            setRuntimeError(null);
            // localStorage persistence handled by ChatProvider automatically
            await loadExecutionTelemetry();
            window.setTimeout(() => {
                void loadState({ suppressRuntimeError: true });
            }, 250);
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: error instanceof Error ? error.message : "Reset failed.",
                },
            ]);
        }
        finally {
            setIsResetting(false);
        }
    }
    async function handleStopExecution() {
        setStoppingExecution(true);
        try {
            const response = await fetch(apiUrl("/orchestrator/stop"), {
                method: "POST",
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error ?? "Execution stop failed.");
            }
            await loadState();
            await loadExecutionTelemetry();
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: "Board manually stopped the current execution cycle.",
                },
            ]);
        }
        catch (error) {
            setMessages((current) => [
                ...current,
                {
                    id: createId(),
                    role: "system",
                    content: error instanceof Error ? error.message : "Execution stop failed.",
                },
            ]);
        }
        finally {
            setStoppingExecution(false);
        }
    }
    const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");
    // ── Computed values for the living dashboard ──────────
    const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
    const sprintTasks = currentSprint
        ? snapshot.tasks.filter((t) => t.sprintId === currentSprint.id)
        : snapshot.tasks;
    const completedTaskCount = sprintTasks.filter((t) => t.status === "completed").length;
    const totalTaskCount = sprintTasks.length;
    const buildTaskWithPreview = snapshot.tasks.find((t) => !!t.localPreviewUrl);
    const previewHref = getPreviewHref(productOverview, buildTaskWithPreview);
    const previewStatus = productOverview.preview.status;
    const agentSessionEntries = orchestratorStatus?.agentSessions
        ? Object.entries(orchestratorStatus.agentSessions)
        : [];
    const activeAgentCount = agentSessionEntries.filter(([, s]) => s.status === "working").length;
    const developerSession = agentSessionEntries.find(([, s]) => s.role === "developer")?.[1] ?? null;
    const latestProductFile = productOverview.files.length > 0 ? productOverview.files[productOverview.files.length - 1] : null;
    const recentMeeting = snapshot.meetings.length > 0 ? snapshot.meetings[snapshot.meetings.length - 1] : null;
    const activeTasks = snapshot.tasks.filter((t) => ["in_progress", "verifying", "planned"].includes(t.status));
    const returnSummary = buildReturnSummary({
        executionStatus,
        activeTasks,
        pendingApprovals,
        previewHref,
        latestProductFile,
        developerSession,
        recentMeeting,
    });
    const showCompanyView = executionStatus !== "idle" || snapshot.tasks.length > 0 || snapshot.sprints.length > 0 || previewStatus !== "idle";
    const inboxItems = [];
    // Pending approvals
    for (const approval of pendingApprovals) {
        inboxItems.push({
            id: `approval-${approval.id}`,
            kind: "approval",
            title: approval.title,
            detail: approval.description || "Needs board decision",
            time: "",
            actionLabel: executionStatus === "awaiting_board_review" ? "Approve" : undefined,
            onAction: executionStatus === "awaiting_board_review" ? () => void handleApproveBoardReview() : undefined,
        });
    }
    // Agent stalls
    for (const [, sess] of agentSessionEntries) {
        if (sess.stallReason) {
            inboxItems.push({
                id: `stall-${sess.agentId}`,
                kind: "stall",
                title: `${sess.name || sess.role} is stalled`,
                detail: sess.stallReason,
                time: sess.lastEventAt ? formatRelativeTime(sess.lastEventAt) : "",
                href: "/employees",
            });
        }
    }
    // Recent errors from activity (last 5)
    const recentErrors = activityEvents
        .filter((e) => e.type === "error")
        .slice(-5)
        .reverse();
    for (const ev of recentErrors) {
        inboxItems.push({
            id: `error-${ev.id}`,
            kind: "error",
            title: `Error from ${ev.employee}`,
            detail: ev.content.slice(0, 120),
            time: formatRelativeTime(ev.timestamp),
            href: "/logs",
        });
    }
    // Recently completed tasks (last 3)
    const recentlyCompleted = snapshot.tasks
        .filter((t) => t.status === "completed" && t.completedAt)
        .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
        .slice(0, 3);
    for (const task of recentlyCompleted) {
        inboxItems.push({
            id: `done-${task.id}`,
            kind: "completed",
            title: task.title,
            detail: `Completed by ${task.assignedRole}`,
            time: task.completedAt ? formatRelativeTime(task.completedAt) : "",
            href: "/tasks",
        });
    }
    // Recent meetings (last 2)
    const recentMeetings = snapshot.meetings.slice(-2).reverse();
    for (const mtg of recentMeetings) {
        inboxItems.push({
            id: `mtg-${mtg.id}`,
            kind: "meeting",
            title: `${mtg.type.replace(/_/g, " ")} meeting`,
            detail: (mtg.title ?? "").slice(0, 100),
            time: formatRelativeTime(mtg.createdAt),
            href: "/meetings",
        });
    }
    // Execution done notice — suppress while a sprint is in flight.
    // Backend reuses executionStatus="done" as a between-sprints signal
    // (orchestrator.ts:869, 5027) so the CEO stage inference lands on
    // "between_sprints". Don't surface that transient state as a terminal banner
    // when a sprint is still being created, executed, or reviewed.
    const hasInFlightSprint = snapshot.sprints.some((s) => s.status !== "completed");
    const hasCompletedSprint = snapshot.sprints.some((s) => s.status === "completed");
    if (executionStatus === "done" && !hasInFlightSprint && hasCompletedSprint) {
        inboxItems.push({
            id: "exec-done",
            kind: "info",
            title: "Execution cycle complete",
            detail: "Review the preview or give the CEO the next instruction.",
            time: "",
        });
    }
    const inboxCount = inboxItems.length;
    const inboxKindIcon = (kind) => {
        switch (kind) {
            case "approval": return _jsx(AlertCircle, { className: "h-3.5 w-3.5 text-[var(--swiss-red)]" });
            case "error": return _jsx(AlertCircle, { className: "h-3.5 w-3.5 text-[var(--swiss-red)]" });
            case "stall": return _jsx(AlertCircle, { className: "h-3.5 w-3.5 text-[var(--arc-warning)]" });
            case "completed": return _jsx(Activity, { className: "h-3.5 w-3.5 text-[var(--arc-success)]" });
            case "meeting": return _jsx(Users, { className: "h-3.5 w-3.5 text-[var(--swiss-blue)]" });
            case "info": return _jsx(Cpu, { className: "h-3.5 w-3.5 text-[var(--swiss-gray-400)]" });
        }
    };
    const getAgentName = (task) => {
        const agent = snapshot.agents.find((a) => a.role === task.assignedRole);
        return agent?.name ?? task.assignedRole;
    };
    const getTaskStatusIcon = (status) => {
        switch (status) {
            case "completed": return "✓";
            case "in_progress": return "●";
            case "verifying": return "◐";
            case "planned": return "○";
            case "created": return "○";
            case "blocked": return "✗";
            case "failed": return "✗";
            case "cancelled": return "—";
            default: return "○";
        }
    };
    const getTaskStatusColor = (status) => {
        switch (status) {
            case "completed": return "text-[var(--arc-success)]";
            case "in_progress": return "text-[var(--swiss-blue)]";
            case "verifying": return "text-[var(--arc-warning)]";
            case "failed":
            case "blocked": return "text-[var(--swiss-red)]";
            default: return "text-[var(--swiss-gray-400)]";
        }
    };
    const getAgentStatusColor = (status) => {
        switch (status) {
            case "working": return "bg-[var(--arc-success)]";
            case "done": return "bg-[var(--swiss-blue)]";
            case "error": return "bg-[var(--swiss-red)]";
            default: return "bg-[var(--swiss-gray-300)]";
        }
    };
    return (_jsxs("div", { className: "flex h-full flex-col", children: [_jsxs("header", { className: "flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-[0.75rem] font-semibold text-[var(--text-primary)]", children: snapshot.company.id === "company_pending" ? "Arceus" : snapshot.company.name }), currentSprint ? (_jsxs(Badge, { variant: "outline", className: "text-[0.625rem]", children: ["Sprint ", currentSprint.number] })) : null, _jsx(Badge, { variant: executionStatus === "done" ? "secondary" : executionStatus === "error" ? "destructive" : "outline", className: "text-[0.625rem]", children: executionStatus })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Badge, { variant: runtime?.chatReady ? "outline" : "warning", className: "text-[0.625rem]", children: runtime?.chatReady ? "CEO ready" : "CEO needs config" }), _jsxs(Button, { variant: "ghost", size: "sm", onClick: () => void handleReset(), disabled: isResetting, children: [isResetting ? _jsx(LoaderCircle, { className: "h-3.5 w-3.5 animate-spin" }) : null, "Reset"] }), !["idle", "done", "error", "paused"].includes(executionStatus) ? (_jsxs(Button, { variant: "ghost", size: "sm", className: "text-[var(--status-error)]", onClick: () => void handleStopExecution(), disabled: stoppingExecution, children: [stoppingExecution ? _jsx(LoaderCircle, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(X, { className: "h-3.5 w-3.5" }), "Stop"] })) : null] })] }), _jsx(ResizableSplit, { left: _jsxs("div", { className: "flex h-full flex-col", children: [runtimeError && !isResetting ? (_jsx("div", { className: "shrink-0 border-b border-[var(--status-error)]/20 bg-[var(--status-error)]/5 px-5 py-2", children: _jsx("p", { className: "text-[0.75rem] text-[var(--status-error)]", children: runtimeError }) })) : null, _jsx("div", { className: "flex-1 overflow-y-auto p-4", children: messages.length === 0 ? (_jsx(LaunchBoardPanel, { disabled: isStreaming, onPrompt: (prompt) => void sendMessage(prompt) })) : (_jsxs("div", { className: "space-y-3", children: [messages.map((message) => {
                                        if (message.role === "ceo" && message.card) {
                                            return (_jsxs("div", { className: "space-y-2 rounded-lg border border-[var(--swiss-gray-100)] px-4 py-3 text-[0.8125rem]", children: [_jsx("div", { className: "swiss-caption opacity-70", children: "CEO" }), message.content ? _jsx("p", { className: "whitespace-pre-wrap leading-6 text-[var(--swiss-gray-400)]", children: message.content }) : null, message.card.card_type === "welcome_brief" ? _jsx(WelcomeBriefView, { card: message.card, disabled: isStreaming, onChoose: handleQuestionOption }) : null, message.card.card_type === "mission_brief" ? _jsx(MissionBriefView, { card: message.card, disabled: isStreaming, onChoose: handleQuestionOption }) : null, message.card.card_type === "strategy_proposal" ? (_jsx(StrategyProposalEditor, { card: message.card, busy: proposalActionId === message.id, resolved: resolvedProposalIds.includes(message.id), onApprove: (card, execute) => handleStrategyAction(message.id, card, execute) })) : null, message.card.card_type === "clarifying_question" ? _jsx(ClarifyingQuestionView, { card: message.card, disabled: isStreaming, onChoose: handleQuestionOption }) : null, message.card.card_type === "status_update" ? _jsx(StatusUpdateView, { card: message.card, disabled: isStreaming, onChoose: handleQuestionOption }) : null, message.card.card_type === "sprint_proposal" ? (_jsx(SprintProposalView, { card: message.card, busy: proposalActionId === message.id, resolved: resolvedProposalIds.includes(message.id), onApprove: () => handleSprintApproval(message.id), onReject: () => handleSprintReject(message.id) })) : null] }, message.id));
                                        }
                                        return (_jsxs("div", { className: message.role === "board"
                                                ? "ml-auto max-w-[85%] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/60 px-4 py-3 text-[0.8125rem] backdrop-blur-sm"
                                                : message.role === "ceo"
                                                    ? "max-w-[90%] rounded-lg border border-[var(--swiss-gray-100)] px-4 py-3 text-[0.8125rem]"
                                                    : "max-w-[90%] rounded-lg border-l-2 border-[var(--swiss-gray-200)] py-2 pl-3 text-[0.8125rem] text-[var(--swiss-gray-400)]", children: [_jsx("div", { className: "swiss-caption mb-1 opacity-70", children: message.role === "board" ? "Board" : message.role === "ceo" ? "CEO" : "System" }), _jsx("p", { className: "whitespace-pre-wrap leading-6", children: message.content })] }, message.id));
                                    }), _jsx("div", { ref: chatEndRef })] })) }), _jsxs("div", { className: "shrink-0 border-t border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-4", children: [_jsx(Textarea, { placeholder: "Tell the CEO what to build or what should happen next\u2026", value: composer, onChange: (event) => setComposer(event.target.value), className: "min-h-[72px] resize-none rounded-lg bg-[var(--swiss-white)] text-[0.8125rem]", disabled: isStreaming, onKeyDown: (event) => {
                                        if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            if (composer.trim() && !isPending && !isStreaming) {
                                                startTransition(() => void sendMessage());
                                            }
                                        }
                                    } }), _jsxs("div", { className: "mt-2 flex items-center justify-end gap-2", children: [_jsxs(Button, { variant: "outline", size: "sm", onClick: () => void handleQuickExecute(), disabled: isPending || isStreaming || quickExecuting || !composer.trim(), children: [quickExecuting ? _jsx(LoaderCircle, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Zap, { className: "h-3.5 w-3.5" }), "Quick Execute"] }), _jsxs(Button, { size: "sm", onClick: () => startTransition(() => void sendMessage()), disabled: isPending || isStreaming || !composer.trim(), children: [isPending || isStreaming ? _jsx(LoaderCircle, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(ArrowUpRight, { className: "h-3.5 w-3.5" }), "Send"] })] })] })] }), right: _jsx("div", { className: "flex h-full min-w-0 flex-col overflow-y-auto bg-[var(--bg-primary)]", children: _jsxs("div", { className: "flex-1 space-y-5 p-6", children: [inboxCount > 0 ? (_jsxs("section", { className: "rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]", children: [_jsxs("button", { className: "flex w-full items-center justify-between px-5 py-3 text-left", onClick: () => setInboxOpen((prev) => !prev), children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Inbox, { className: "h-4 w-4 text-[var(--text-muted)]" }), _jsx("span", { className: "text-[0.8125rem] font-semibold", children: "Inbox" }), _jsx("span", { className: "flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--status-info)] px-1.5 text-[0.625rem] font-semibold text-white", children: inboxCount })] }), _jsx(ChevronDown, { className: `h-4 w-4 text-[var(--text-muted)] transition-transform ${inboxOpen ? "rotate-180" : ""}` })] }), inboxOpen ? (_jsx("div", { className: "border-t border-[var(--swiss-gray-100)]", children: inboxItems.map((item, idx) => {
                                            const inner = (_jsxs(_Fragment, { children: [_jsx("span", { className: "shrink-0", children: inboxKindIcon(item.kind) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-[0.8125rem] font-medium", children: item.title }), item.time ? (_jsx("span", { className: "shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]", children: item.time })) : null] }), _jsx("div", { className: "mt-0.5 truncate text-[0.75rem] leading-relaxed text-[var(--swiss-gray-400)]", children: item.detail })] }), item.actionLabel && item.onAction ? (_jsx(Button, { size: "sm", className: "shrink-0", onClick: (e) => { e.preventDefault(); e.stopPropagation(); item.onAction(); }, children: item.actionLabel })) : null] }));
                                            const cls = `flex items-start gap-3 px-5 py-3 transition hover:bg-[var(--swiss-gray-50)] ${idx < inboxItems.length - 1 ? "border-b border-[var(--swiss-gray-100)]" : ""}`;
                                            return item.href ? (_jsx(Link, { href: item.href, className: cls, children: inner }, item.id)) : (_jsx("div", { className: cls, children: inner }, item.id));
                                        }) })) : null] })) : null, _jsxs("section", { className: "overflow-hidden rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)]", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-[var(--swiss-gray-100)] px-5 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Monitor, { className: "h-4 w-4 text-[var(--swiss-gray-400)]" }), _jsx("span", { className: "text-[0.8125rem] font-semibold", children: "Product Preview" })] }), _jsxs("div", { className: "flex items-center gap-2", children: [productOverview.preview.framework ? (_jsx(Badge, { variant: "outline", className: "text-[0.625rem]", children: productOverview.preview.framework })) : null, _jsx(Badge, { variant: previewStatus === "ready" ? "secondary" : previewStatus === "error" && executionStatus !== "idle" ? "destructive" : "outline", className: "text-[0.625rem]", children: previewStatus === "ready" ? "✓ Live" : previewStatus === "starting" ? "Starting…" : previewStatus === "error" && executionStatus !== "idle" ? "Error" : "Waiting" })] })] }), previewHref ? (_jsxs("div", { className: "relative bg-[var(--arc-preview-bg)]", children: [_jsx("iframe", { src: previewHref, className: "w-full border-0", style: { height: "380px" }, title: "Product preview", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups" }), _jsxs("a", { href: previewHref, target: "_blank", rel: "noopener noreferrer", className: "absolute right-3 top-3 flex h-7 items-center gap-1.5 rounded-md bg-[var(--swiss-gray-50)]/90 px-2.5 text-[0.6875rem] font-medium text-[var(--swiss-gray-400)] backdrop-blur-sm transition hover:text-[var(--swiss-black)]", children: ["Open ", _jsx(ArrowUpRight, { className: "h-3 w-3" })] })] })) : (_jsxs("div", { className: "flex h-48 flex-col items-center justify-center gap-2 bg-[var(--arc-preview-bg)] text-[var(--swiss-gray-300)]", children: [_jsx(Monitor, { className: "h-8 w-8 opacity-30" }), _jsx("span", { className: "text-[0.8125rem]", children: "No preview available yet" }), executionStatus !== "idle" ? (_jsx("span", { className: "text-[0.6875rem] text-[var(--swiss-gray-400)]", children: "The team is building \u2014 preview will appear when ready" })) : null] }))] }), _jsxs("section", { className: "rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)]", children: [_jsxs("button", { className: "flex w-full items-center justify-between px-5 py-3 text-left", onClick: () => setSprintOpen((prev) => !prev), children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-[0.8125rem] font-semibold", children: currentSprint ? `Sprint ${currentSprint.number}` : "Current Workload" }), currentSprint ? (_jsx(Badge, { variant: currentSprint.status === "completed" ? "secondary" : currentSprint.status === "executing" ? "outline" : "outline", className: "text-[0.5625rem]", children: currentSprint.status === "completed" ? "Done" : currentSprint.status === "executing" ? "Executing" : currentSprint.status })) : null, _jsx("span", { className: "ml-1 max-w-[200px] truncate text-[0.6875rem] text-[var(--swiss-gray-400)]", children: currentSprint?.title || (snapshot.strategy.title !== "CEO workspace is waiting for your first message" ? snapshot.strategy.title : "") })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("span", { className: "font-mono text-[0.75rem] text-[var(--swiss-gray-400)]", children: [completedTaskCount, "/", totalTaskCount, " tasks"] }), totalTaskCount > 0 ? (_jsx("div", { className: "h-1.5 w-24 overflow-hidden rounded-full bg-[var(--swiss-gray-200)]", children: _jsx("div", { className: "h-full rounded-full bg-[var(--swiss-blue)] transition-all duration-500", style: { width: `${(completedTaskCount / totalTaskCount) * 100}%` } }) })) : null, _jsx(ChevronDown, { className: `h-4 w-4 text-[var(--swiss-gray-400)] transition-transform ${sprintOpen ? "rotate-180" : ""}` })] })] }), sprintOpen ? (_jsxs("div", { className: "border-t border-[var(--swiss-gray-100)] px-5 py-4", children: [sprintTasks.length > 0 ? (_jsx("div", { className: "space-y-0.5", children: sprintTasks.map((task) => (_jsxs(Link, { href: "/tasks", className: "flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-[var(--swiss-gray-100)] cursor-pointer", children: [_jsx("span", { className: `font-mono text-[0.8125rem] font-semibold ${getTaskStatusColor(task.status)}`, children: getTaskStatusIcon(task.status) }), _jsx("span", { className: "min-w-0 flex-1 truncate text-[0.8125rem]", children: task.title }), _jsx("span", { className: "shrink-0 text-[0.6875rem] text-[var(--swiss-gray-400)]", children: getAgentName(task) }), _jsx(Badge, { variant: task.status === "completed" ? "secondary" : task.status === "in_progress" ? "outline" : task.status === "failed" || task.status === "blocked" ? "destructive" : "outline", className: "shrink-0 text-[0.5625rem]", children: task.status.replace(/_/g, " ") }), _jsx("span", { className: "shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]", children: formatRelativeTime(task.completedAt ?? task.startedAt ?? task.createdAt ?? null) })] }, task.id))) })) : (_jsx("div", { className: "py-6 text-center text-[0.8125rem] text-[var(--swiss-gray-300)]", children: "No tasks yet \u2014 start by chatting with the CEO" })), currentSprint?.status === "completed" && executionStatus === "done" && !snapshot.chatMessages.some((m) => m.cardType === "sprint_proposal" && m.sprintId === currentSprint.id) ? (_jsxs("div", { className: "mt-3 flex items-center gap-2 rounded border border-[var(--swiss-gray-100)] px-3 py-2 text-[0.8125rem] text-[var(--swiss-gray-400)]", children: [_jsx(LoaderCircle, { className: "h-3 w-3 animate-spin" }), "CEO is preparing next sprint proposal..."] })) : null, currentSprint?.status === "completed" && executionStatus === "done" ? (_jsxs("div", { className: "mt-2 text-center text-[0.6875rem] text-[var(--swiss-gray-300)]", children: ["Sprint ", currentSprint.number, " complete \u2014 check CEO chat for next sprint proposal"] })) : null] })) : null] }), heartbeatStatus ? (_jsxs("section", { className: "rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-5 py-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Zap, { className: "h-3.5 w-3.5 text-[var(--swiss-gray-400)]" }), _jsx("span", { className: "text-[0.8125rem] font-semibold", children: "Heartbeat" }), heartbeatStatus.running ? (_jsxs("span", { className: "flex items-center gap-1 text-[0.6875rem] text-[var(--status-success)]", children: [_jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-success)]" }), "Running"] })) : (_jsx("span", { className: "text-[0.6875rem] text-[var(--swiss-gray-400)]", children: "Idle" }))] }), heartbeatStatus.totalBeats > 0 ? (_jsxs("span", { className: "font-mono text-[0.6875rem] text-[var(--swiss-gray-400)]", children: [heartbeatStatus.totalBeats, " beats"] })) : null] }), heartbeatHistory.length > 0 ? (_jsx("div", { className: "mt-2 flex items-center gap-[3px]", children: heartbeatHistory.map((beat) => {
                                            const isIdle = beat.outcome === "HEARTBEAT_OK" || (beat.summary?.startsWith("Idle beat") ?? false);
                                            const isSkipped = beat.outcome === "SKIPPED" || (beat.summary?.startsWith("Skipped") ?? false)
                                                || (beat.outcome === "WORK_DONE" && (beat.summary?.includes("waiting on") ?? false));
                                            const color = beat.status === "failed" || beat.outcome === "ERROR" ? "bg-[var(--status-error)]"
                                                : beat.status === "running" ? "bg-[var(--swiss-blue)] animate-pulse"
                                                    : isIdle ? "bg-[var(--swiss-gray-300)]"
                                                        : isSkipped ? "bg-[var(--swiss-gray-300)]"
                                                            : beat.outcome === "BUDGET_EXCEEDED" ? "bg-[var(--status-warning)]"
                                                                : beat.outcome === "WORK_DONE" ? "bg-[var(--status-success)]"
                                                                    : "bg-[var(--swiss-gray-300)]";
                                            const statusLabel = beat.status === "failed" || beat.outcome === "ERROR" ? "✗ Failed"
                                                : beat.status === "running" ? "● Running"
                                                    : isIdle ? "○ Idle"
                                                        : isSkipped ? "○ Skipped"
                                                            : beat.outcome === "WORK_DONE" ? "✓ Work done"
                                                                : beat.outcome ?? beat.status;
                                            return (_jsx("span", { className: `group relative h-2 flex-1 cursor-default rounded-full ${color}`, children: _jsxs("span", { className: "pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-48 -translate-x-1/2 rounded-lg border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2 shadow-lg group-hover:block", children: [_jsxs("span", { className: "flex items-center gap-1.5 text-[0.75rem] font-semibold", children: [_jsx("span", { className: `inline-block h-1.5 w-1.5 rounded-full ${color.replace(" animate-pulse", "")}` }), statusLabel] }), beat.agentId ? (_jsx("span", { className: "mt-1 block text-[0.6875rem] text-[var(--swiss-gray-400)]", children: beat.agentId })) : null, beat.summary ? (_jsx("span", { className: "mt-1 block text-[0.6875rem] leading-snug text-[var(--text-secondary)]", children: beat.summary })) : null, _jsx("span", { className: "mt-1.5 block text-[0.625rem] text-[var(--swiss-gray-300)]", children: beat.startedAt ? formatRelativeTime(beat.startedAt) : "—" })] }) }, beat.id));
                                        }) })) : (_jsx("div", { className: "mt-1 text-[0.6875rem] text-[var(--swiss-gray-300)]", children: "No beats recorded yet" }))] })) : null] }) }) }), _jsxs("footer", { className: "flex h-8 shrink-0 items-center gap-4 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-5 font-mono text-[0.6875rem] text-[var(--text-muted)]", children: [currentSprint ? _jsxs("span", { children: ["Sprint ", currentSprint.number] }) : null, totalTaskCount > 0 ? _jsxs("span", { children: [completedTaskCount, "/", totalTaskCount, " tasks"] }) : null, activeAgentCount > 0 ? (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-success)]" }), activeAgentCount, " active"] })) : null, _jsxs("span", { children: ["Preview: ", previewStatus === "ready" ? "✓ running" : previewStatus === "starting" ? "starting…" : "—"] }), _jsx("span", { className: "ml-auto text-[var(--text-muted)]", children: snapshot.company.name || "Arceus" })] }), expandedArtifact ? (_jsx("div", { className: "fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm", children: _jsxs("div", { className: "flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]", children: [_jsxs("div", { className: "flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-[0.9375rem] font-semibold", children: expandedArtifact.title }), _jsxs("div", { className: "swiss-caption mt-1 text-[var(--text-muted)]", children: [expandedArtifact.agent, " \u00B7 ", expandedArtifact.kind, " \u00B7 ", new Date(expandedArtifact.createdAt).toLocaleTimeString()] })] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => setExpandedArtifact(null), children: _jsx(X, { className: "h-4 w-4" }) })] }), _jsx("div", { className: "overflow-y-auto px-5 py-4", children: _jsx("div", { className: "markdown-content text-[0.8125rem] leading-7 text-[var(--text-secondary)]", children: _jsx(ReactMarkdown, { children: expandedArtifact.content }) }) }), _jsx(Separator, {}), _jsx("div", { className: "flex justify-end px-5 py-3", children: _jsx(Button, { variant: "outline", onClick: () => setExpandedArtifact(null), children: "Close" }) })] }) })) : null] }));
}
