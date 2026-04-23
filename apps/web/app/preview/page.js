"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { ArrowUpRight, FileCode, Terminal, AlertCircle, Activity, LoaderCircle } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { apiUrl } from "../../lib/api";
import { PageShell } from "../../components/layout/page-shell";
const TYPE_ICONS = {
    file_edit: FileCode,
    shell: Terminal,
    working: LoaderCircle,
    error: AlertCircle,
    idle: Activity,
    info: Activity,
};
const emptyProductOverview = {
    root: "",
    preview: {
        status: "idle", url: null, entryUrl: null, validationUrl: null,
        validationStrategy: null, targetKind: null, runtime: null, framework: null,
        command: null, targetPath: null, port: 3210, lastError: null, startedAt: null,
    },
    files: [],
};
export default function PreviewPage() {
    const [snapshot, setSnapshot] = useState(null);
    const [productOverview, setProductOverview] = useState(emptyProductOverview);
    const [orchestratorStatus, setOrchestratorStatus] = useState(null);
    const [activityEvents, setActivityEvents] = useState([]);
    async function loadData() {
        const [companyRes, productRes, orchRes, activityRes] = await Promise.allSettled([
            fetch(apiUrl("/company"), { cache: "no-store" }),
            fetch(apiUrl("/product/overview"), { cache: "no-store" }),
            fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
            fetch(apiUrl("/employee-activity"), { cache: "no-store" }),
        ]);
        if (companyRes.status === "fulfilled" && companyRes.value.ok)
            setSnapshot(await companyRes.value.json());
        if (productRes.status === "fulfilled" && productRes.value.ok)
            setProductOverview(await productRes.value.json());
        if (orchRes.status === "fulfilled" && orchRes.value.ok)
            setOrchestratorStatus(await orchRes.value.json());
        if (activityRes.status === "fulfilled" && activityRes.value.ok)
            setActivityEvents(await activityRes.value.json());
    }
    useEffect(() => {
        void loadData();
        const interval = setInterval(() => void loadData(), 3000);
        return () => clearInterval(interval);
    }, []);
    useEffect(() => {
        const es = new EventSource(apiUrl("/employee-activity/stream"));
        es.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data);
                setActivityEvents((prev) => {
                    if (prev.some((e) => e.id === parsed.id))
                        return prev;
                    const next = [...prev, parsed];
                    return next.length > 200 ? next.slice(-200) : next;
                });
            }
            catch { /* ignore */ }
        };
        return () => es.close();
    }, []);
    const buildTaskWithPreview = snapshot?.tasks.find((t) => t.kind === "implementation" && t.localPreviewUrl);
    const previewHref = productOverview.preview.entryUrl
        ?? productOverview.preview.validationUrl
        ?? productOverview.preview.url
        ?? buildTaskWithPreview?.localPreviewUrl
        ?? null;
    const latestProductFile = productOverview.files[0] ?? null;
    const recentFileEditCount = activityEvents.filter((e) => e.type === "file_edit").length;
    const developerSession = orchestratorStatus?.agentSessions?.developer ?? null;
    const recentFileEdits = activityEvents.filter((e) => e.type === "file_edit").slice(-10).reverse();
    const recentShellEvents = activityEvents.filter((e) => e.type === "shell").slice(-8).reverse();
    return (_jsx(PageShell, { title: "Product Preview", description: "Live preview surface, runtime details, and recent edits.", children: _jsxs("div", { className: "space-y-6", children: [_jsx("div", { className: "flex flex-wrap items-end justify-between gap-4", children: _jsxs("div", { className: "flex items-center gap-3", children: [previewHref ? (_jsxs("a", { className: "inline-flex items-center gap-2 border border-[var(--swiss-gray-200)] px-4 py-2 text-[0.8125rem] font-medium transition hover:border-[var(--swiss-black)]", href: previewHref, target: "_blank", rel: "noreferrer", children: ["Open live preview ", _jsx(ArrowUpRight, { className: "h-4 w-4" })] })) : null, _jsx(Badge, { variant: productOverview.preview.status === "ready" ? "secondary" : "outline", children: productOverview.preview.status })] }) }), _jsxs("div", { className: "grid grid-cols-4 gap-px border border-[var(--swiss-gray-100)]", children: [_jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption", children: "Framework" }), _jsx("div", { className: "mt-1 text-lg font-semibold", children: productOverview.preview.framework ?? "—" })] }), _jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption", children: "Runtime" }), _jsx("div", { className: "mt-1 text-lg font-semibold", children: productOverview.preview.runtime ?? "—" })] }), _jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption", children: "Files" }), _jsx("div", { className: "mt-1 text-lg font-semibold", children: productOverview.files.length })] }), _jsxs("div", { className: "bg-[var(--swiss-white)] p-4", children: [_jsx("div", { className: "swiss-caption", children: "Live edits" }), _jsx("div", { className: "mt-1 text-lg font-semibold", children: recentFileEditCount })] })] }), _jsx("div", { className: "border border-[var(--swiss-gray-100)]", children: previewHref ? (_jsx("iframe", { title: "Local preview", src: previewHref, className: "h-[560px] w-full bg-white" })) : (_jsx("div", { className: "flex h-[400px] items-center justify-center text-center text-[var(--swiss-gray-300)]", children: _jsxs("div", { className: "max-w-md space-y-2", children: [_jsx("div", { className: "text-lg font-semibold", children: "No live preview yet" }), _jsx("div", { className: "text-[0.8125rem] leading-6", children: "Once the developer reaches a runnable surface, it will appear here." })] }) })) }), _jsxs("div", { className: "grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]", children: [_jsxs("div", { className: "space-y-6", children: [_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsx(CardTitle, { children: "Runtime details" }) }), _jsxs(CardContent, { className: "grid gap-3 text-[0.8125rem] md:grid-cols-2", children: [_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Launch command" }), _jsx("div", { className: "mt-1 font-medium", children: productOverview.preview.command ?? "—" })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Served from" }), _jsx("div", { className: "mt-1 font-medium", children: productOverview.preview.targetPath ?? "—" })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Validation URL" }), _jsx("div", { className: "mt-1 font-medium break-all", children: productOverview.preview.validationUrl ?? "—" })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Target kind" }), _jsx("div", { className: "mt-1 font-medium", children: productOverview.preview.targetKind ?? "—" })] }), productOverview.preview.lastError ? (_jsxs("div", { className: "col-span-2 border border-[var(--swiss-red)] p-3 text-[var(--swiss-red)]", children: [_jsx("div", { className: "swiss-caption text-[var(--swiss-red)]", children: "Last error" }), _jsx("div", { className: "mt-1", children: productOverview.preview.lastError })] })) : null] })] }), _jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsx(CardTitle, { children: "Recent file edits" }) }), _jsx(CardContent, { className: "space-y-2 text-[0.8125rem]", children: recentFileEdits.length === 0 ? (_jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]", children: "No file edits observed yet." })) : recentFileEdits.map((evt) => {
                                                const Icon = TYPE_ICONS[evt.type] ?? Activity;
                                                return (_jsx("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Icon, { className: "mt-0.5 h-4 w-4 shrink-0 text-[var(--swiss-gray-300)]" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "font-medium", children: evt.content }), _jsxs("div", { className: "mt-1 text-xs text-[var(--swiss-gray-300)]", children: [evt.employee, " \u00B7 ", new Date(evt.timestamp).toLocaleTimeString()] })] })] }) }, evt.id));
                                            }) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsx(CardTitle, { children: "Shell activity" }) }), _jsx(CardContent, { className: "space-y-2 text-[0.8125rem]", children: recentShellEvents.length === 0 ? (_jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]", children: "No shell activity yet." })) : recentShellEvents.map((evt) => (_jsx("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Terminal, { className: "mt-0.5 h-4 w-4 shrink-0 text-[var(--swiss-gray-300)]" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "font-medium", children: evt.content }), _jsxs("div", { className: "mt-1 text-xs text-[var(--swiss-gray-300)]", children: [evt.employee, " \u00B7 ", new Date(evt.timestamp).toLocaleTimeString()] })] })] }) }, evt.id))) })] })] }), _jsxs("div", { className: "space-y-6", children: [_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsx(CardTitle, { children: "Workspace files" }) }), _jsx(CardContent, { children: productOverview.files.length === 0 ? (_jsx("div", { className: "border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]", children: "No workspace files yet." })) : (_jsx("div", { className: "max-h-[480px] space-y-2 overflow-y-auto pr-1", children: productOverview.files.map((file) => (_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "break-all text-[0.8125rem] font-medium", children: file.path }), _jsxs("div", { className: "mt-1 text-xs text-[var(--swiss-gray-300)]", children: ["Updated ", new Date(file.modifiedAt).toLocaleString()] })] }, `${file.path}-${file.modifiedAt}`))) })) })] }), developerSession ? (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-3", children: _jsx(CardTitle, { children: "Developer session" }) }), _jsxs(CardContent, { className: "space-y-3 text-[0.8125rem]", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "font-semibold", children: developerSession.awaiting ?? "actively working" }), _jsx(Badge, { variant: developerSession.status === "error" ? "destructive" : developerSession.status === "working" ? "secondary" : "outline", children: developerSession.status })] }), _jsx("div", { className: "leading-6 text-[var(--swiss-gray-400)]", children: developerSession.lastEventSummary ?? "No updates yet." }), _jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Events" }), _jsx("div", { className: "mt-1 font-semibold", children: developerSession.eventCount })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Tools" }), _jsx("div", { className: "mt-1 font-semibold", children: developerSession.toolInvocationCount })] }), _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-3", children: [_jsx("div", { className: "swiss-caption", children: "Shell" }), _jsx("div", { className: "mt-1 font-semibold", children: developerSession.shellCommandCount })] })] }), developerSession.stallReason ? _jsx("div", { className: "border border-[var(--swiss-red)] p-3 text-[var(--swiss-red)]", children: developerSession.stallReason }) : null] })] })) : null, _jsxs("div", { className: "border border-[var(--swiss-gray-100)] p-4 text-[0.8125rem]", children: [_jsx("div", { className: "swiss-caption", children: "Latest change" }), _jsx("div", { className: "mt-1 font-medium", children: latestProductFile?.path ?? "No changes yet" }), latestProductFile ? _jsx("div", { className: "mt-1 text-xs text-[var(--swiss-gray-300)]", children: new Date(latestProductFile.modifiedAt).toLocaleString() }) : null] })] })] })] }) }));
}
