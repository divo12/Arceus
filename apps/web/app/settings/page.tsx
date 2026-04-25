"use client";

import { useEffect, useState, useCallback } from "react";
import { PageShell } from "../../components/layout/page-shell";
import { apiUrl } from "../../lib/api";
import { Settings2, Cpu, Database, Heart, RefreshCw, Trash2 } from "lucide-react";

type HeartbeatConfig = {
  executionMode: string;
  schedulerIntervalMs: number;
  maxConcurrentBeats: number;
  beatTimeoutMs: number;
  beatTokenBudget: number;
  beatCostCeilingCents: number;
  pauseWhenNoActiveSprint: boolean;
  pauseWhenBudgetExhausted: boolean;
  roleIntervals: Record<string, number>;
  pauseRoles: string[];
  idleThresholdTokens: number;
};

type ControlPlaneStatus = {
  healthy: boolean;
  version: number;
  mutationCount: number;
  upSince: string;
  companyId: string;
  components: {
    stateStore: { status: string; dirty: boolean; mutationsSinceHydrate: number };
    auditLedger: { status: string };
    executionSubstrate: { status: string };
  };
};

type RuntimeStatus = {
  azureEndpoint: string;
  opencodeHost: string;
  opencodePort: number;
};

function ConfigRow({ label, value, mono }: { label: string; value: string | number | boolean; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[var(--border-subtle)]">
      <span className="text-[0.8125rem] text-[var(--text-muted)]">{label}</span>
      <span className={`text-[0.8125rem] text-[var(--text-primary)] ${mono ? "swiss-mono" : ""}`}>
        {typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}
      </span>
    </div>
  );
}

function StatusIndicator({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: ok ? "var(--status-success)" : "var(--status-error)" }}
    />
  );
}

export default function SettingsPage() {
  const [hbConfig, setHbConfig] = useState<HeartbeatConfig | null>(null);
  const [cpStatus, setCpStatus] = useState<ControlPlaneStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [dbHealth, setDbHealth] = useState<{ ok: boolean; message?: string } | null>(null);
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
      if (cpRes?.ok) setCpStatus(await cpRes.json());
      if (rtRes?.ok) setRuntime(await rtRes.json());
      if (dbRes?.ok) setDbHealth(await dbRes.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const patchConfig = async (patch: Partial<HeartbeatConfig>) => {
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
    } catch { /* ignore */ }
    setSaving(false);
  };

  const resetCompany = async () => {
    if (!confirm("Delete all company state? This cannot be undone.")) return;
    try {
      await fetch(apiUrl("/company"), { method: "DELETE" });
      await load();
    } catch { /* ignore */ }
  };

  return (
    <PageShell title="Settings" description="System configuration and operational health">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Heartbeat Config */}
        <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
          <h3 className="swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <Heart className="h-3.5 w-3.5" style={{ color: "var(--role-ceo)" }} />
            Heartbeat Engine
          </h3>
          {hbConfig ? (
            <div>
              <ConfigRow label="Execution Mode" value={hbConfig.executionMode} mono />
              <ConfigRow label="Scheduler Interval" value={`${hbConfig.schedulerIntervalMs}ms`} />
              <ConfigRow label="Max Concurrent Beats" value={hbConfig.maxConcurrentBeats} />
              <ConfigRow label="Beat Timeout" value={`${hbConfig.beatTimeoutMs}ms`} />
              <ConfigRow label="Token Budget/Beat" value={hbConfig.beatTokenBudget.toLocaleString()} />
              <ConfigRow label="Cost Ceiling/Beat" value={`${hbConfig.beatCostCeilingCents}¢`} />
              <ConfigRow label="Pause: No Sprint" value={hbConfig.pauseWhenNoActiveSprint} />
              <ConfigRow label="Pause: Budget Exhausted" value={hbConfig.pauseWhenBudgetExhausted} />
              <ConfigRow label="Paused Roles" value={hbConfig.pauseRoles.length > 0 ? hbConfig.pauseRoles.join(", ") : "none"} />

              {/* Role intervals */}
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                <p className="swiss-caption text-[var(--text-muted)] mb-2">Role Intervals</p>
                {Object.entries(hbConfig.roleIntervals).map(([role, ms]) => (
                  <div key={role} className="flex items-center justify-between py-0.5">
                    <span className="text-[0.75rem] text-[var(--text-secondary)]">{role}</span>
                    <span className="swiss-mono text-[0.75rem] text-[var(--text-muted)]">{ms}ms</span>
                  </div>
                ))}
              </div>

              {/* Quick actions */}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => patchConfig({ maxConcurrentBeats: Math.min(hbConfig.maxConcurrentBeats + 1, 8) })}
                  disabled={saving}
                  className="px-3 py-1.5 text-[0.75rem] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                >
                  +Concurrency
                </button>
                <button
                  onClick={() => patchConfig({ maxConcurrentBeats: Math.max(hbConfig.maxConcurrentBeats - 1, 1) })}
                  disabled={saving}
                  className="px-3 py-1.5 text-[0.75rem] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                >
                  -Concurrency
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[0.8125rem] text-[var(--text-muted)]">Loading…</p>
          )}
        </div>

        {/* Control Plane */}
        <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
          <h3 className="swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5" style={{ color: "var(--role-cto)" }} />
            Control Plane
          </h3>
          {cpStatus ? (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <StatusIndicator ok={cpStatus.healthy} />
                <span className="text-[0.8125rem] text-[var(--text-primary)]">
                  {cpStatus.healthy ? "Healthy" : "Unhealthy"}
                </span>
              </div>
              <ConfigRow label="Version" value={`v${cpStatus.version}`} mono />
              <ConfigRow label="Mutations" value={cpStatus.mutationCount} />
              <ConfigRow label="Up Since" value={new Date(cpStatus.upSince).toLocaleString()} />

              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                <p className="swiss-caption text-[var(--text-muted)] mb-2">Components</p>
                {Object.entries(cpStatus.components).map(([name, comp]) => (
                  <div key={name} className="flex items-center justify-between py-1">
                    <span className="text-[0.75rem] text-[var(--text-secondary)]">{name}</span>
                    <div className="flex items-center gap-1.5">
                      <StatusIndicator ok={comp.status === "ok"} />
                      <span className="swiss-mono text-[0.6875rem] text-[var(--text-muted)]">{comp.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[0.8125rem] text-[var(--text-muted)]">Loading…</p>
          )}
        </div>

        {/* Runtime */}
        <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
          <h3 className="swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5" />
            Runtime
          </h3>
          {runtime ? (
            <div>
              {Object.entries(runtime).map(([key, val]) => (
                <ConfigRow key={key} label={key} value={String(val)} mono />
              ))}
            </div>
          ) : (
            <p className="text-[0.8125rem] text-[var(--text-muted)]">Loading…</p>
          )}
        </div>

        {/* Database */}
        <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
          <h3 className="swiss-h3 text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <Database className="h-3.5 w-3.5" />
            Database
          </h3>
          {dbHealth ? (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <StatusIndicator ok={dbHealth.ok} />
                <span className="text-[0.8125rem] text-[var(--text-primary)]">
                  {dbHealth.ok ? "Connected" : "Disconnected"}
                </span>
              </div>
              {dbHealth.message && (
                <p className="text-[0.75rem] text-[var(--text-muted)]">{dbHealth.message}</p>
              )}
            </div>
          ) : (
            <p className="text-[0.8125rem] text-[var(--text-muted)]">Loading…</p>
          )}
        </div>

        {/* Danger zone */}
        <div className="col-span-full border border-[var(--status-error)] bg-[var(--bg-secondary)] p-5">
          <h3 className="swiss-h3 text-[var(--status-error)] mb-3 flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5" />
            Danger Zone
          </h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[0.8125rem] text-[var(--text-primary)]">Reset Company</p>
              <p className="text-[0.75rem] text-[var(--text-muted)]">Delete all company state and start fresh</p>
            </div>
            <button
              onClick={resetCompany}
              className="px-4 py-1.5 text-[0.75rem] font-medium border border-[var(--status-error)] text-[var(--status-error)] hover:bg-[var(--status-error)] hover:text-white transition-colors"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
