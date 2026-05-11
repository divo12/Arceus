"use client";

import { useEffect, useState } from "react";
import { PageShell } from "../../components/layout/page-shell";
import { fetchWithAuth } from "../../lib/api";
import { useAuth } from "../../contexts/auth-context";
import { Shield, Cpu, GitBranch, Clock } from "lucide-react";

type Agent = {
  id: string;
  name: string;
  role: string;
  title: string;
  status: string;
  profile: string;
  memory: {
    currentFocus: string[];
    recentLearnings: string[];
    activePatterns: string[];
    blockers: string[];
  } | null;
  session: {
    runtimeStatus: string;
    lastEventAt: string | null;
    lastEventType: string | null;
    lastEventSummary: string | null;
    lastToolName: string | null;
    lastToolStatus: string | null;
    activeTaskId: string | null;
    eventCount: number;
    toolInvocationCount: number;
    fileEditCount: number;
    shellCommandCount: number;
    stallReason: string | null;
  } | null;
};

const ROLE_COLORS: Record<string, string> = {
  ceo: "var(--role-ceo)",
  cto: "var(--role-cto)",
  pm: "var(--role-pm)",
  developer: "var(--role-developer)",
  tester: "var(--role-tester)",
  ui_designer: "var(--role-ui-designer)",
  marketing: "var(--role-marketing)",
  skills_lead: "var(--role-skills-lead)",
};

function StatusBadge({ status }: { status: string }) {
  const bg =
    status === "running" || status === "active" || status === "connected"
      ? "var(--status-success)"
      : status === "idle"
        ? "var(--status-idle)"
        : status === "error" || status === "failed"
          ? "var(--status-error)"
          : "var(--status-warning)";
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: bg, color: "#000" }}
    >
      {status}
    </span>
  );
}

export default function AgentsPage() {
  const { token } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetchWithAuth("/employees", token, { cache: "no-store" });
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setAgents(data);
          if (!selected && data.length > 0) setSelected(data[0]);
          else if (selected) {
            const updated = data.find((a: Agent) => a.id === selected.id);
            if (updated) setSelected(updated);
          }
        }
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => { active = false; clearInterval(id); };
  }, [selected?.id, token]);

  return (
    <PageShell title="Agents" description="Agent roster, capabilities, and live session state">
      {agents.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-[var(--text-muted)]">
          <p className="text-sm">No agents hired yet. Bootstrap a company first.</p>
        </div>
      ) : (
        <div className="flex gap-4" style={{ minHeight: "calc(100vh - 150px)" }}>
          {/* Agent list (left) */}
          <div className="w-56 shrink-0 space-y-1">
            {agents.map((agent) => {
              const isActive = selected?.id === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelected(agent)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors border ${
                    isActive
                      ? "border-[var(--text-muted)] bg-[var(--bg-tertiary)]"
                      : "border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center text-[0.625rem] font-bold rounded"
                    style={{ backgroundColor: ROLE_COLORS[agent.role] || "var(--text-muted)", color: "#000" }}
                  >
                    {agent.name[0]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.8125rem] font-medium text-[var(--text-primary)] truncate">{agent.name}</p>
                    <p className="text-[0.6875rem] text-[var(--text-muted)] truncate">{agent.role}</p>
                  </div>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        agent.status === "running" || agent.status === "active"
                          ? "var(--status-success)"
                          : agent.status === "idle"
                            ? "var(--status-idle)"
                            : "var(--status-warning)",
                    }}
                  />
                </button>
              );
            })}
          </div>

          {/* Agent detail (right) */}
          {selected && (
            <div className="flex-1 space-y-4">
              {/* Header */}
              <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-10 w-10 items-center justify-center text-[0.875rem] font-bold rounded"
                        style={{ backgroundColor: ROLE_COLORS[selected.role] || "var(--text-muted)", color: "#000" }}
                      >
                        {selected.name[0]}
                      </span>
                      <div>
                        <h2 className="swiss-h2 text-[var(--text-primary)]">{selected.name}</h2>
                        <p className="text-[0.8125rem] text-[var(--text-muted)]">{selected.title}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-[0.8125rem] text-[var(--text-secondary)]">{selected.profile}</p>
                  </div>
                  <StatusBadge status={selected.status} />
                </div>
              </div>

              {/* Session state */}
              <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
                <h3 className="swiss-h3 text-[var(--text-primary)] mb-3 flex items-center gap-2">
                  <Cpu className="h-3.5 w-3.5" /> Session
                </h3>
                {selected.session ? (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[0.8125rem]">
                    <div>
                      <span className="text-[var(--text-muted)]">Runtime: </span>
                      <StatusBadge status={selected.session.runtimeStatus} />
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">Events: </span>
                      <span className="text-[var(--text-primary)]">{selected.session.eventCount}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">Tool calls: </span>
                      <span className="text-[var(--text-primary)]">{selected.session.toolInvocationCount}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">File edits: </span>
                      <span className="text-[var(--text-primary)]">{selected.session.fileEditCount}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">Shell cmds: </span>
                      <span className="text-[var(--text-primary)]">{selected.session.shellCommandCount}</span>
                    </div>
                    {selected.session.lastToolName && (
                      <div>
                        <span className="text-[var(--text-muted)]">Last tool: </span>
                        <span className="swiss-mono text-[var(--text-primary)]">{selected.session.lastToolName}</span>
                        {selected.session.lastToolStatus && (
                          <span className="ml-1 text-[var(--text-muted)]">({selected.session.lastToolStatus})</span>
                        )}
                      </div>
                    )}
                    {selected.session.activeTaskId && (
                      <div className="col-span-2">
                        <span className="text-[var(--text-muted)]">Active task: </span>
                        <span className="swiss-mono text-[var(--text-primary)]">{selected.session.activeTaskId}</span>
                      </div>
                    )}
                    {selected.session.stallReason && (
                      <div className="col-span-2 text-[var(--status-warning)]">
                        Stall: {selected.session.stallReason}
                      </div>
                    )}
                    {selected.session.lastEventSummary && (
                      <div className="col-span-2">
                        <span className="text-[var(--text-muted)]">Last event: </span>
                        <span className="text-[var(--text-secondary)]">{selected.session.lastEventSummary.slice(0, 120)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[0.8125rem] text-[var(--text-muted)]">No active session</p>
                )}
              </div>

              {/* Memory */}
              {selected.memory && (
                <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
                  <h3 className="swiss-h3 text-[var(--text-primary)] mb-3 flex items-center gap-2">
                    <Shield className="h-3.5 w-3.5" /> Memory
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      ["Focus", selected.memory.currentFocus],
                      ["Learnings", selected.memory.recentLearnings],
                      ["Patterns", selected.memory.activePatterns],
                      ["Blockers", selected.memory.blockers],
                    ].map(([label, items]) => (
                      <div key={label as string}>
                        <p className="swiss-caption text-[var(--text-muted)] mb-1">{label as string}</p>
                        {(items as string[] | undefined)?.length ? (
                          <ul className="space-y-0.5">
                            {((items as string[] | undefined) ?? []).map((item, i) => (
                              <li key={i} className="text-[0.8125rem] text-[var(--text-secondary)]">· {item}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-[0.75rem] text-[var(--text-muted)]">—</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
