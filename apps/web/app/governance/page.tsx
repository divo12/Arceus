"use client";

import { useEffect, useState, useCallback } from "react";
import { Shield, AlertTriangle, CheckCircle, TrendingUp, RefreshCw } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";
import { PageShell } from "../../components/page-shell";
import { apiUrl } from "../../lib/api";

// ── Types ──────────────────────────────────────────────────

interface TrustScoreEntry {
  agentId: string;
  score: number;
  tier: string;
  updatedAt: string;
  history: Array<{ kind: string; delta: number; reason: string; timestamp: string }>;
}

interface PolicyViolation {
  id: string;
  companyId: string;
  agentId: string;
  ruleId: string;
  tool: string;
  decision: string;
  severity: string;
  detail: string;
  beatId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface PolicyRule {
  id: string;
  name: string;
  description: string;
  priority: number;
  targetRoles: string[];
  toolPatterns: string[];
  minTrust: number;
  decision: string;
}

interface GovernanceStats {
  agentCount: number;
  trustScoreCount: number;
  averageTrust: number;
  tierDistribution: Record<string, number>;
  recentViolations: number;
  violationsBySeverity: Record<string, number>;
  policyCount: number;
}

// ── Helpers ────────────────────────────────────────────────

function tierColor(tier: string) {
  switch (tier) {
    case "trusted": return "bg-emerald-500";
    case "standard": return "bg-blue-500";
    case "probation": return "bg-amber-500";
    case "restricted": return "bg-red-500";
    default: return "bg-gray-400";
  }
}

function tierBadge(tier: string) {
  switch (tier) {
    case "trusted": return "secondary" as const;
    case "standard": return "outline" as const;
    case "probation": return "outline" as const;
    case "restricted": return "destructive" as const;
    default: return "outline" as const;
  }
}

function severityBadge(severity: string) {
  switch (severity) {
    case "critical": return "destructive" as const;
    case "high": return "destructive" as const;
    case "medium": return "outline" as const;
    default: return "secondary" as const;
  }
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Page ───────────────────────────────────────────────────

export default function GovernancePage() {
  const [stats, setStats] = useState<GovernanceStats | null>(null);
  const [trustScores, setTrustScores] = useState<TrustScoreEntry[]>([]);
  const [violations, setViolations] = useState<PolicyViolation[]>([]);
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, scoresRes, violRes, polRes] = await Promise.all([
        fetch(apiUrl("/governance/stats"), { cache: "no-store" }),
        fetch(apiUrl("/governance/trust-scores"), { cache: "no-store" }),
        fetch(apiUrl("/governance/violations?limit=50"), { cache: "no-store" }),
        fetch(apiUrl("/governance/policies"), { cache: "no-store" }),
      ]);

      if (statsRes.ok) setStats(await statsRes.json());
      if (scoresRes.ok) setTrustScores(await scoresRes.json());
      if (violRes.ok) setViolations(await violRes.json());
      if (polRes.ok) setPolicies(await polRes.json());
    } catch {
      // silent — data will remain stale
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 10_000);
    return () => clearInterval(iv);
  }, [loadData]);

  return (
    <PageShell title="Governance" description="Agent trust scores, policy enforcement, and tool access control">
      <div className="mx-auto max-w-[1400px] space-y-6 p-6">
        {/* Refresh */}
        <div className="flex justify-end">
          <button onClick={loadData} className="flex items-center gap-1.5 text-[0.75rem] text-[var(--swiss-gray-400)] transition hover:text-[var(--swiss-black)]">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        {/* ── Stats Overview ────────────────────────────────── */}
        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-[0.6875rem]">Avg Trust</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{stats.averageTrust.toFixed(2)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-[0.6875rem]">Active Policies</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{stats.policyCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-[0.6875rem]">Recent Violations</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold">{stats.recentViolations}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-[0.6875rem]">Tier Distribution</CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                {Object.entries(stats.tierDistribution).map(([tier, count]) => (
                  <span key={tier} className="flex items-center gap-1 text-[0.6875rem]">
                    <span className={`inline-block h-2 w-2 rounded-full ${tierColor(tier)}`} />
                    {count}
                  </span>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        <Separator />

        {/* ── Trust Scores ──────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[0.875rem] font-semibold tracking-tight flex items-center gap-1.5">
            <Shield className="h-4 w-4" /> Agent Trust Scores
          </h2>
          {trustScores.length === 0 && !loading && (
            <p className="text-[0.75rem] text-[var(--swiss-gray-400)]">No trust scores recorded yet.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {trustScores.map((ts) => (
              <Card key={ts.agentId}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-[0.8125rem]">{ts.agentId}</CardTitle>
                    <Badge variant={tierBadge(ts.tier)}>{ts.tier}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {/* Trust bar */}
                  <div className="mb-2 flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-[var(--swiss-gray-100)]">
                      <div
                        className={`h-2 rounded-full transition-all ${tierColor(ts.tier)}`}
                        style={{ width: `${Math.min(100, ts.score * 100)}%` }}
                      />
                    </div>
                    <span className="text-[0.75rem] font-mono font-semibold">{ts.score.toFixed(3)}</span>
                  </div>
                  {/* Recent history */}
                  {ts.history.length > 0 && (
                    <div className="space-y-0.5">
                      {ts.history.slice(-3).reverse().map((h, i) => (
                        <p key={i} className="text-[0.625rem] text-[var(--swiss-gray-400)] truncate">
                          {h.delta >= 0 ? "+" : ""}{h.delta.toFixed(3)} {h.kind}: {h.reason}
                        </p>
                      ))}
                    </div>
                  )}
                  <p className="mt-1 text-[0.625rem] text-[var(--swiss-gray-300)]">Updated {relativeTime(ts.updatedAt)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <Separator />

        {/* ── Policy Violations ─────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[0.875rem] font-semibold tracking-tight flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" /> Recent Violations
          </h2>
          {violations.length === 0 && !loading && (
            <p className="text-[0.75rem] text-[var(--swiss-gray-400)]">No violations recorded — all agents compliant.</p>
          )}
          <div className="space-y-2">
            {violations.slice(0, 20).map((v) => (
              <Card key={v.id}>
                <CardContent className="flex items-center gap-3 py-2.5 px-4">
                  <Badge variant={severityBadge(v.severity)} className="shrink-0">{v.severity}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.75rem] font-medium">
                      {v.agentId} → <code className="text-[0.6875rem]">{v.tool}</code> — {v.decision}
                    </p>
                    <p className="truncate text-[0.625rem] text-[var(--swiss-gray-400)]">
                      Rule: {v.ruleId} · {v.detail}
                    </p>
                  </div>
                  <span className="shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]">{relativeTime(v.createdAt)}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <Separator />

        {/* ── Active Policies ──────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[0.875rem] font-semibold tracking-tight flex items-center gap-1.5">
            <CheckCircle className="h-4 w-4" /> Active Policies ({policies.length})
          </h2>
          <div className="space-y-2">
            {policies.sort((a, b) => b.priority - a.priority).map((p) => (
              <Card key={p.id}>
                <CardContent className="flex items-center gap-3 py-2.5 px-4">
                  <span className="shrink-0 font-mono text-[0.6875rem] text-[var(--swiss-gray-400)] w-8 text-right">{p.priority}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.75rem] font-medium">{p.name}</p>
                    <p className="truncate text-[0.625rem] text-[var(--swiss-gray-400)]">{p.description}</p>
                  </div>
                  <Badge variant={p.decision === "deny" ? "destructive" : p.decision === "escalate" ? "outline" : "secondary"} className="shrink-0">
                    {p.decision}
                  </Badge>
                  <span className="shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]">
                    {p.targetRoles.length > 0 ? p.targetRoles.join(", ") : "all"} · trust≥{p.minTrust}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </PageShell>
  );
}
