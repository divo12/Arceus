"use client";

import { useEffect, useState } from "react";
import { PageShell } from "../../components/layout/page-shell";
import { apiUrl } from "../../lib/api";
import {
  Activity,
  CheckSquare,
  Users,
  Zap,
  TrendingUp,
  Clock,
  AlertCircle,
  CircleDot,
} from "lucide-react";

type Company = {
  id: string;
  name: string;
  status: string;
  budgetCents: number;
  spentCents: number;
  currentSprintId: string | null;
  currentSprintNumber: number | null;
};

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignedRole: string;
};

type Agent = {
  id: string;
  name: string;
  role: string;
  status: string;
};

type Sprint = {
  id: string;
  number: number;
  status: string;
  title: string;
};

type OrchestratorStatus = {
  executionStatus: string;
  sprint: Sprint | null;
};

type HeartbeatStatus = {
  running: boolean;
  activeLocks: number;
  semaphoreAvailable: number;
  totalBeats: number;
  config: {
    executionMode: string;
    schedulerIntervalMs: number;
    maxConcurrentBeats: number;
  };
};

type Snapshot = {
  company: Company;
  agents: Agent[];
  tasks: Task[];
  sprints: Sprint[];
  meetings: unknown[];
  approvals: { id: string; status: string }[];
  chatMessages: unknown[];
  artifacts: unknown[];
};

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-3.5 w-3.5" style={color ? { color } : undefined} />
        <span className="swiss-caption text-[var(--text-muted)]">{label}</span>
      </div>
      <p className="text-[1.5rem] font-bold tracking-tight text-[var(--text-primary)]">{value}</p>
      {sub && <p className="mt-1 text-[0.75rem] text-[var(--text-muted)]">{sub}</p>}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active" || status === "running" || status === "executing" || status === "completed"
      ? "var(--status-success)"
      : status === "failed" || status === "error"
        ? "var(--status-error)"
        : status === "idle" || status === "stopped"
          ? "var(--status-idle)"
          : "var(--status-warning)";
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

export default function DashboardPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [orchestrator, setOrchestrator] = useState<OrchestratorStatus | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatStatus | null>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const [snapRes, orchRes, hbRes] = await Promise.all([
          fetch(apiUrl("/company"), { cache: "no-store" }),
          fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
          fetch(apiUrl("/heartbeat/status"), { cache: "no-store" }),
        ]);
        if (!active) return;
        if (snapRes.ok) setSnapshot(await snapRes.json());
        if (orchRes.ok) setOrchestrator(await orchRes.json());
        if (hbRes.ok) setHeartbeat(await hbRes.json());
      } catch { /* ignore */ }
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

  return (
    <PageShell title="Dashboard" description="System overview and operational health">
      {isPending ? (
        <div className="flex h-64 items-center justify-center text-[var(--text-muted)]">
          <p className="text-sm">No company bootstrapped yet. Start a conversation with the CEO.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Company header */}
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
            <div>
              <h2 className="swiss-h1 text-[var(--text-primary)]">{company!.name}</h2>
              <div className="mt-1 flex items-center gap-3 text-[0.8125rem] text-[var(--text-muted)]">
                <span className="flex items-center gap-1.5">
                  <StatusDot status={company!.status} />
                  {company!.status}
                </span>
                <span>Sprint {company!.currentSprintNumber ?? "—"}</span>
                <span>Execution: {orchestrator?.executionStatus ?? "—"}</span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[0.75rem] text-[var(--text-muted)]">Budget</p>
              <p className="text-[1rem] font-semibold text-[var(--text-primary)]">
                {(company!.spentCents / 100).toFixed(2)} / {(company!.budgetCents / 100).toFixed(2)}
                <span className="ml-1 text-[0.75rem] text-[var(--text-muted)]">({budgetPct}%)</span>
              </p>
              <div className="mt-1 h-1.5 w-32 bg-[var(--bg-tertiary)] overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${Math.min(budgetPct, 100)}%`,
                    backgroundColor: budgetPct >= 90 ? "var(--status-error)" : budgetPct >= 70 ? "var(--status-warning)" : "var(--status-success)",
                  }}
                />
              </div>
            </div>
          </div>

          {/* Stat grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon={CheckSquare} label="Tasks" value={tasks.length} sub={`${tasksByStatus.completed} done · ${tasksByStatus.inProgress} active`} color="var(--status-info)" />
            <StatCard icon={Users} label="Agents" value={agents.length} sub={`${agents.filter((a) => a.status === "running").length} running`} color="var(--role-developer)" />
            <StatCard icon={Zap} label="Heartbeat" value={heartbeat?.running ? "Active" : "Off"} sub={heartbeat ? `${heartbeat.totalBeats} total beats` : "—"} color="var(--role-ceo)" />
            <StatCard icon={Activity} label="Sprint" value={orchestrator?.sprint?.title ?? "None"} sub={orchestrator?.sprint ? `#${orchestrator.sprint.number} · ${orchestrator.sprint.status}` : "—"} color="var(--role-pm)" />
          </div>

          {/* Task breakdown */}
          <div>
            <h3 className="swiss-h3 text-[var(--text-primary)] mb-3">Task Breakdown</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {(
                [
                  ["Created", tasksByStatus.created, "var(--text-muted)"],
                  ["Planned", tasksByStatus.planned, "var(--status-info)"],
                  ["In Progress", tasksByStatus.inProgress, "var(--status-warning)"],
                  ["Completed", tasksByStatus.completed, "var(--status-success)"],
                  ["Failed", tasksByStatus.failed, "var(--status-error)"],
                  ["Blocked", tasksByStatus.blocked, "var(--status-idle)"],
                ] as const
              ).map(([label, count, color]) => (
                <div key={label} className="border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-center">
                  <p className="text-[1.25rem] font-bold" style={{ color }}>{count}</p>
                  <p className="text-[0.6875rem] text-[var(--text-muted)] mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Agent roster */}
          <div>
            <h3 className="swiss-h3 text-[var(--text-primary)] mb-3">Agent Roster</h3>
            <div className="space-y-1">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-3 border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2">
                  <span
                    className="flex h-6 w-6 items-center justify-center text-[0.625rem] font-bold rounded"
                    style={{ backgroundColor: `var(--role-${agent.role.replace("_", "-")})`, color: "#000" }}
                  >
                    {agent.name[0]}
                  </span>
                  <span className="text-[0.8125rem] font-medium text-[var(--text-primary)] w-20">{agent.name}</span>
                  <span className="swiss-caption text-[var(--text-muted)] w-24">{agent.role}</span>
                  <StatusDot status={agent.status} />
                  <span className="text-[0.75rem] text-[var(--text-muted)]">{agent.status}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Quick stats row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon={TrendingUp} label="Meetings" value={snapshot?.meetings?.length ?? 0} color="var(--role-cto)" />
            <StatCard icon={Clock} label="Approvals" value={snapshot?.approvals?.filter((a) => a.status === "pending").length ?? 0} sub="pending" color="var(--status-warning)" />
            <StatCard icon={CircleDot} label="Artifacts" value={snapshot?.artifacts?.length ?? 0} color="var(--role-ui-designer)" />
            <StatCard icon={AlertCircle} label="Messages" value={snapshot?.chatMessages?.length ?? 0} color="var(--role-marketing)" />
          </div>
        </div>
      )}
    </PageShell>
  );
}
