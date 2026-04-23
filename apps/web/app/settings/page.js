"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState, useCallback } from "react";
import { PageShell } from "../../components/layout/page-shell";
import { apiUrl } from "../../lib/api";
import { Settings2, Cpu, Database, Heart, Trash2 } from "lucide-react";
function ConfigRow({ label, value, mono }) {
    return (_jsxs("div", { className: "flex items-center justify-between py-1.5 border-b border-[var(--border-subtle)]", children: [_jsx("span", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: label }), _jsx("span", { className: `text-[0.8125rem] text-[var(--text-primary)] ${mono ? "swiss-mono" : ""}`, children: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value) })] }));
}
function StatusIndicator({ ok }) {
    return (_jsx("span", { className: "inline-block h-2.5 w-2.5 rounded-full", style: { backgroundColor: ok ? "var(--status-success)" : "var(--status-error)" } }));
}
export default function SettingsPage() {
    const [hbConfig, setHbConfig] = useState(null);
    const [cpStatus, setCpStatus] = useState(null);
    const [runtime, setRuntime] = useState(null);
    const [dbHealth, setDbHealth] = useState(null);
    const [saving, setSaving] = useState(false);
    const load = useCallback(async () => {
        try {
            const [hbRes, cpRes, rtRes, dbRes] = await Promise.all([
                fetch(apiUrl("/heartbeat/config"), { cache: "no-store" }).catch(() => null),
                fetch(apiUrl("/control-plane/status"), { cache: "no-store" }).catch(() => null),
                fetch(apiUrl("/runtime"), { cache: "no-store" }).catch(() => null),
                fetch(apiUrl("/persistence/health"), { cache: "no-store" }).catch(() => null),
            ]);
            if (hbRes?.ok) {
                const data = await hbRes.json();
                setHbConfig(data.config ?? data);
            }
            if (cpRes?.ok)
                setCpStatus(await cpRes.json());
            if (rtRes?.ok)
                setRuntime(await rtRes.json());
            if (dbRes?.ok)
                setDbHealth(await dbRes.json());
        }
        catch { /* ignore */ }
    }, []);
    useEffect(() => {
        load();
        const id = setInterval(load, 5000);
        return () => clearInterval(id);
    }, [load]);
    const patchConfig = async (patch) => {
        setSaving(true);
        try {
            const res = await fetch(apiUrl("/heartbeat/config"), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            if (res.ok) {
                const data = await res.json();
                setHbConfig(data.config ?? data);
            }
        }
        catch { /* ignore */ }
        setSaving(false);
    };
    const resetCompany = async () => {
        if (!confirm("Delete all company state? This cannot be undone."))
            return;
        try {
            await fetch(apiUrl("/company"), { method: "DELETE" });
            await load();
        }
        catch { /* ignore */ }
    };
    return (_jsx(PageShell, { title: "Settings", description: "System configuration and operational health", children: _jsxs("div", { className: "grid grid-cols-1 gap-6 lg:grid-cols-2", children: [_jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2", children: [_jsx(Heart, { className: "h-3.5 w-3.5", style: { color: "var(--role-ceo)" } }), "Heartbeat Engine"] }), hbConfig ? (_jsxs("div", { children: [_jsx(ConfigRow, { label: "Execution Mode", value: hbConfig.executionMode, mono: true }), _jsx(ConfigRow, { label: "Scheduler Interval", value: `${hbConfig.schedulerIntervalMs}ms` }), _jsx(ConfigRow, { label: "Max Concurrent Beats", value: hbConfig.maxConcurrentBeats }), _jsx(ConfigRow, { label: "Beat Timeout", value: `${hbConfig.beatTimeoutMs}ms` }), _jsx(ConfigRow, { label: "Token Budget/Beat", value: hbConfig.beatTokenBudget.toLocaleString() }), _jsx(ConfigRow, { label: "Cost Ceiling/Beat", value: `${hbConfig.beatCostCeilingCents}¢` }), _jsx(ConfigRow, { label: "Pause: No Sprint", value: hbConfig.pauseWhenNoActiveSprint }), _jsx(ConfigRow, { label: "Pause: Budget Exhausted", value: hbConfig.pauseWhenBudgetExhausted }), _jsx(ConfigRow, { label: "Paused Roles", value: hbConfig.pauseRoles.length > 0 ? hbConfig.pauseRoles.join(", ") : "none" }), _jsxs("div", { className: "mt-3 pt-3 border-t border-[var(--border)]", children: [_jsx("p", { className: "swiss-caption text-[var(--text-muted)] mb-2", children: "Role Intervals" }), Object.entries(hbConfig.roleIntervals).map(([role, ms]) => (_jsxs("div", { className: "flex items-center justify-between py-0.5", children: [_jsx("span", { className: "text-[0.75rem] text-[var(--text-secondary)]", children: role }), _jsxs("span", { className: "swiss-mono text-[0.75rem] text-[var(--text-muted)]", children: [ms, "ms"] })] }, role)))] }), _jsxs("div", { className: "mt-4 flex gap-2", children: [_jsx("button", { onClick: () => patchConfig({ maxConcurrentBeats: Math.min(hbConfig.maxConcurrentBeats + 1, 8) }), disabled: saving, className: "px-3 py-1.5 text-[0.75rem] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50", children: "+Concurrency" }), _jsx("button", { onClick: () => patchConfig({ maxConcurrentBeats: Math.max(hbConfig.maxConcurrentBeats - 1, 1) }), disabled: saving, className: "px-3 py-1.5 text-[0.75rem] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50", children: "-Concurrency" })] })] })) : (_jsx("p", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: "Loading\u2026" }))] }), _jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2", children: [_jsx(Cpu, { className: "h-3.5 w-3.5", style: { color: "var(--role-cto)" } }), "Control Plane"] }), cpStatus ? (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2 mb-3", children: [_jsx(StatusIndicator, { ok: cpStatus.healthy }), _jsx("span", { className: "text-[0.8125rem] text-[var(--text-primary)]", children: cpStatus.healthy ? "Healthy" : "Unhealthy" })] }), _jsx(ConfigRow, { label: "Version", value: `v${cpStatus.version}`, mono: true }), _jsx(ConfigRow, { label: "Mutations", value: cpStatus.mutationCount }), _jsx(ConfigRow, { label: "Up Since", value: new Date(cpStatus.upSince).toLocaleString() }), _jsxs("div", { className: "mt-3 pt-3 border-t border-[var(--border)]", children: [_jsx("p", { className: "swiss-caption text-[var(--text-muted)] mb-2", children: "Components" }), Object.entries(cpStatus.components).map(([name, comp]) => (_jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "text-[0.75rem] text-[var(--text-secondary)]", children: name }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(StatusIndicator, { ok: comp.status === "ok" }), _jsx("span", { className: "swiss-mono text-[0.6875rem] text-[var(--text-muted)]", children: comp.status })] })] }, name)))] })] })) : (_jsx("p", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: "Loading\u2026" }))] }), _jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2", children: [_jsx(Settings2, { className: "h-3.5 w-3.5" }), "Runtime"] }), runtime ? (_jsx("div", { children: Object.entries(runtime).map(([key, val]) => (_jsx(ConfigRow, { label: key, value: String(val), mono: true }, key))) })) : (_jsx("p", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: "Loading\u2026" }))] }), _jsxs("div", { className: "border border-[var(--border)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2", children: [_jsx(Database, { className: "h-3.5 w-3.5" }), "Database"] }), dbHealth ? (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2 mb-3", children: [_jsx(StatusIndicator, { ok: dbHealth.ok }), _jsx("span", { className: "text-[0.8125rem] text-[var(--text-primary)]", children: dbHealth.ok ? "Connected" : "Disconnected" })] }), dbHealth.message && (_jsx("p", { className: "text-[0.75rem] text-[var(--text-muted)]", children: dbHealth.message }))] })) : (_jsx("p", { className: "text-[0.8125rem] text-[var(--text-muted)]", children: "Loading\u2026" }))] }), _jsxs("div", { className: "col-span-full border border-[var(--status-error)] bg-[var(--bg-secondary)] p-5", children: [_jsxs("h3", { className: "swiss-h3 text-[var(--status-error)] mb-3 flex items-center gap-2", children: [_jsx(Trash2, { className: "h-3.5 w-3.5" }), "Danger Zone"] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[0.8125rem] text-[var(--text-primary)]", children: "Reset Company" }), _jsx("p", { className: "text-[0.75rem] text-[var(--text-muted)]", children: "Delete all company state and start fresh" })] }), _jsx("button", { onClick: resetCompany, className: "px-4 py-1.5 text-[0.75rem] font-medium border border-[var(--status-error)] text-[var(--status-error)] hover:bg-[var(--status-error)] hover:text-white transition-colors", children: "Reset" })] })] })] }) }));
}
