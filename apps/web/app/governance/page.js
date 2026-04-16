"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState, useCallback } from "react";
import { Shield, AlertTriangle, CheckCircle, RefreshCw } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";
import { PageShell } from "../../components/page-shell";
import { apiUrl } from "../../lib/api";
// ── Helpers ────────────────────────────────────────────────
function tierColor(tier) {
    switch (tier) {
        case "trusted": return "bg-emerald-500";
        case "standard": return "bg-blue-500";
        case "probation": return "bg-amber-500";
        case "restricted": return "bg-red-500";
        default: return "bg-gray-400";
    }
}
function tierBadge(tier) {
    switch (tier) {
        case "trusted": return "secondary";
        case "standard": return "outline";
        case "probation": return "outline";
        case "restricted": return "destructive";
        default: return "outline";
    }
}
function severityBadge(severity) {
    switch (severity) {
        case "critical": return "destructive";
        case "high": return "destructive";
        case "medium": return "outline";
        default: return "secondary";
    }
}
function relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)
        return "just now";
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}
// ── Page ───────────────────────────────────────────────────
export default function GovernancePage() {
    const [stats, setStats] = useState(null);
    const [trustScores, setTrustScores] = useState([]);
    const [violations, setViolations] = useState([]);
    const [policies, setPolicies] = useState([]);
    const [loading, setLoading] = useState(true);
    const loadData = useCallback(async () => {
        try {
            const [statsRes, scoresRes, violRes, polRes] = await Promise.all([
                fetch(apiUrl("/governance/stats"), { cache: "no-store" }),
                fetch(apiUrl("/governance/trust-scores"), { cache: "no-store" }),
                fetch(apiUrl("/governance/violations?limit=50"), { cache: "no-store" }),
                fetch(apiUrl("/governance/policies"), { cache: "no-store" }),
            ]);
            if (statsRes.ok)
                setStats(await statsRes.json());
            if (scoresRes.ok)
                setTrustScores(await scoresRes.json());
            if (violRes.ok)
                setViolations(await violRes.json());
            if (polRes.ok)
                setPolicies(await polRes.json());
        }
        catch {
            // silent — data will remain stale
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        loadData();
        const iv = setInterval(loadData, 10_000);
        return () => clearInterval(iv);
    }, [loadData]);
    return (_jsx(PageShell, { title: "Governance", description: "Agent trust scores, policy enforcement, and tool access control", children: _jsxs("div", { className: "mx-auto max-w-[1400px] space-y-6 p-6", children: [_jsx("div", { className: "flex justify-end", children: _jsxs("button", { onClick: loadData, className: "flex items-center gap-1.5 text-[0.75rem] text-[var(--swiss-gray-400)] transition hover:text-[var(--swiss-black)]", children: [_jsx(RefreshCw, { className: "h-3.5 w-3.5" }), " Refresh"] }) }), stats && (_jsxs("div", { className: "grid grid-cols-2 gap-3 sm:grid-cols-4", children: [_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-2", children: _jsx(CardDescription, { className: "text-[0.6875rem]", children: "Avg Trust" }) }), _jsx(CardContent, { children: _jsx("p", { className: "text-xl font-bold", children: stats.averageTrust.toFixed(2) }) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-2", children: _jsx(CardDescription, { className: "text-[0.6875rem]", children: "Active Policies" }) }), _jsx(CardContent, { children: _jsx("p", { className: "text-xl font-bold", children: stats.policyCount }) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-2", children: _jsx(CardDescription, { className: "text-[0.6875rem]", children: "Recent Violations" }) }), _jsx(CardContent, { children: _jsx("p", { className: "text-xl font-bold", children: stats.recentViolations }) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-2", children: _jsx(CardDescription, { className: "text-[0.6875rem]", children: "Tier Distribution" }) }), _jsx(CardContent, { className: "flex gap-2", children: Object.entries(stats.tierDistribution).map(([tier, count]) => (_jsxs("span", { className: "flex items-center gap-1 text-[0.6875rem]", children: [_jsx("span", { className: `inline-block h-2 w-2 rounded-full ${tierColor(tier)}` }), count] }, tier))) })] })] })), _jsx(Separator, {}), _jsxs("section", { children: [_jsxs("h2", { className: "mb-3 text-[0.875rem] font-semibold tracking-tight flex items-center gap-1.5", children: [_jsx(Shield, { className: "h-4 w-4" }), " Agent Trust Scores"] }), trustScores.length === 0 && !loading && (_jsx("p", { className: "text-[0.75rem] text-[var(--swiss-gray-400)]", children: "No trust scores recorded yet." })), _jsx("div", { className: "grid gap-2 sm:grid-cols-2 lg:grid-cols-3", children: trustScores.map((ts) => (_jsxs(Card, { children: [_jsx(CardHeader, { className: "pb-2", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsx(CardTitle, { className: "text-[0.8125rem]", children: ts.agentId }), _jsx(Badge, { variant: tierBadge(ts.tier), children: ts.tier })] }) }), _jsxs(CardContent, { children: [_jsxs("div", { className: "mb-2 flex items-center gap-2", children: [_jsx("div", { className: "h-2 flex-1 rounded-full bg-[var(--swiss-gray-100)]", children: _jsx("div", { className: `h-2 rounded-full transition-all ${tierColor(ts.tier)}`, style: { width: `${Math.min(100, ts.score * 100)}%` } }) }), _jsx("span", { className: "text-[0.75rem] font-mono font-semibold", children: ts.score.toFixed(3) })] }), ts.history.length > 0 && (_jsx("div", { className: "space-y-0.5", children: ts.history.slice(-3).reverse().map((h, i) => (_jsxs("p", { className: "text-[0.625rem] text-[var(--swiss-gray-400)] truncate", children: [h.delta >= 0 ? "+" : "", h.delta.toFixed(3), " ", h.kind, ": ", h.reason] }, i))) })), _jsxs("p", { className: "mt-1 text-[0.625rem] text-[var(--swiss-gray-300)]", children: ["Updated ", relativeTime(ts.updatedAt)] })] })] }, ts.agentId))) })] }), _jsx(Separator, {}), _jsxs("section", { children: [_jsxs("h2", { className: "mb-3 text-[0.875rem] font-semibold tracking-tight flex items-center gap-1.5", children: [_jsx(AlertTriangle, { className: "h-4 w-4" }), " Recent Violations"] }), violations.length === 0 && !loading && (_jsx("p", { className: "text-[0.75rem] text-[var(--swiss-gray-400)]", children: "No violations recorded \u2014 all agents compliant." })), _jsx("div", { className: "space-y-2", children: violations.slice(0, 20).map((v) => (_jsx(Card, { children: _jsxs(CardContent, { className: "flex items-center gap-3 py-2.5 px-4", children: [_jsx(Badge, { variant: severityBadge(v.severity), className: "shrink-0", children: v.severity }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("p", { className: "truncate text-[0.75rem] font-medium", children: [v.agentId, " \u2192 ", _jsx("code", { className: "text-[0.6875rem]", children: v.tool }), " \u2014 ", v.decision] }), _jsxs("p", { className: "truncate text-[0.625rem] text-[var(--swiss-gray-400)]", children: ["Rule: ", v.ruleId, " \u00B7 ", v.detail] })] }), _jsx("span", { className: "shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]", children: relativeTime(v.createdAt) })] }) }, v.id))) })] }), _jsx(Separator, {}), _jsxs("section", { children: [_jsxs("h2", { className: "mb-3 text-[0.875rem] font-semibold tracking-tight flex items-center gap-1.5", children: [_jsx(CheckCircle, { className: "h-4 w-4" }), " Active Policies (", policies.length, ")"] }), _jsx("div", { className: "space-y-2", children: policies.sort((a, b) => b.priority - a.priority).map((p) => (_jsx(Card, { children: _jsxs(CardContent, { className: "flex items-center gap-3 py-2.5 px-4", children: [_jsx("span", { className: "shrink-0 font-mono text-[0.6875rem] text-[var(--swiss-gray-400)] w-8 text-right", children: p.priority }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-[0.75rem] font-medium", children: p.name }), _jsx("p", { className: "truncate text-[0.625rem] text-[var(--swiss-gray-400)]", children: p.description })] }), _jsx(Badge, { variant: p.decision === "deny" ? "destructive" : p.decision === "escalate" ? "outline" : "secondary", className: "shrink-0", children: p.decision }), _jsxs("span", { className: "shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]", children: [(p.appliesTo?.length ?? 0) > 0 ? p.appliesTo.join(", ") : "all", " \u00B7 trust\u2265", p.minTrust] })] }) }, p.id))) })] })] }) }));
}
