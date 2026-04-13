"use client";

import { useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { apiUrl } from "../lib/api";

type FlowTask = {
  id: string;
  kind: string;
  title: string;
  status: string;
  assignedRole: string;
  priority: string;
  iterationCount: number;
  maxIterations: number;
  dependsOnTaskIds: string[];
  childTaskIds: string[];
};

type FlowTransition = {
  id: string;
  fromTaskId: string | null;
  toTaskId: string;
  fromStatus: string | null;
  toStatus: string;
  triggeredByRole: string;
  reason: string;
  status: string;
  createdAt: string;
};

type FlowFeedbackRound = {
  id: string;
  taskId: string;
  iteration: number;
  fromRole: string;
  toRole: string;
  verdict: string;
  feedback: string;
  createdAt: string;
};

type ExecutionFlowData = {
  tasks: FlowTask[];
  transitions: FlowTransition[];
  feedbackRounds: FlowFeedbackRound[];
  executionStatus: string;
};

const STATUS_COLORS: Record<string, string> = {
  created: "bg-[var(--swiss-gray-50)] text-[var(--swiss-gray-300)] border-[var(--swiss-gray-100)]",
  planned: "bg-[var(--swiss-white)] text-[var(--swiss-blue)] border-[var(--swiss-blue)]",
  in_progress: "bg-[var(--swiss-white)] text-[var(--swiss-black)] border-[var(--swiss-black)]",
  verifying: "bg-[var(--swiss-white)] text-[var(--swiss-gray-500)] border-[var(--swiss-gray-300)]",
  completed: "bg-[var(--swiss-black)] text-[var(--swiss-white)] border-[var(--swiss-black)]",
  failed: "bg-[var(--swiss-white)] text-[var(--swiss-red)] border-[var(--swiss-red)]",
  blocked: "bg-[var(--swiss-white)] text-[var(--swiss-red)] border-[var(--swiss-red)]",
  cancelled: "bg-[var(--swiss-gray-50)] text-[var(--swiss-gray-200)] border-[var(--swiss-gray-100)]",
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  ceo: "bg-[var(--swiss-black)] text-[var(--swiss-white)]",
  cto: "bg-[var(--swiss-blue)] text-[var(--swiss-white)]",
  pm: "bg-[var(--swiss-gray-500)] text-[var(--swiss-white)]",
  developer: "bg-[var(--swiss-black)] text-[var(--swiss-white)]",
  tester: "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]",
  ui_designer: "bg-[var(--swiss-red)] text-[var(--swiss-white)]",
  marketing: "bg-[var(--swiss-gray-500)] text-[var(--swiss-white)]",
  skills_lead: "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]",
};

const EXECUTION_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  idle: { label: "Idle", color: "text-[var(--swiss-gray-300)]" },
  planning: { label: "Planning", color: "text-[var(--swiss-blue)]" },
  executing: { label: "Executing", color: "text-[var(--swiss-black)]" },
  verifying: { label: "Verifying", color: "text-[var(--swiss-gray-500)]" },
  awaiting_board_review: { label: "Awaiting Board", color: "text-[var(--swiss-red)]" },
  paused: { label: "Paused", color: "text-[var(--swiss-gray-300)]" },
  done: { label: "Done", color: "text-[var(--swiss-black)]" },
  error: { label: "Error", color: "text-[var(--swiss-red)]" },
};

function TaskNode({ task, feedbackRounds }: { task: FlowTask; feedbackRounds: FlowFeedbackRound[] }) {
  const taskFeedback = feedbackRounds.filter((r) => r.taskId === task.id);
  const statusStyle = STATUS_COLORS[task.status] ?? STATUS_COLORS.created;
  const roleStyle = ROLE_BADGE_COLORS[task.assignedRole] ?? "bg-slate-100 text-slate-700";

  return (
    <div className={`border p-3 ${statusStyle}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">{task.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className={`inline-block px-2 py-0.5 text-[10px] font-medium ${roleStyle}`}>
              {task.assignedRole.replace(/_/g, " ")}
            </span>
            <span className="text-[10px] uppercase tracking-wider opacity-60">{task.kind.replace(/_/g, " ")}</span>
          </div>
        </div>
        <span className="shrink-0 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
          {task.status.replace(/_/g, " ")}
        </span>
      </div>
      {task.iterationCount > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px]">
          <span className="font-medium">Iteration {task.iterationCount}/{task.maxIterations}</span>
          <div className="flex gap-0.5">
            {Array.from({ length: task.maxIterations }, (_, i) => (
              <div
                key={i}
                className={`h-1.5 w-3 ${i < task.iterationCount ? "bg-current opacity-60" : "bg-current opacity-15"}`}
              />
            ))}
          </div>
        </div>
      )}
      {taskFeedback.length > 0 && (
        <div className="mt-2 space-y-1">
          {taskFeedback.slice(-2).map((round) => (
            <div key={round.id} className="border border-[var(--swiss-gray-100)] px-2 py-1 text-[10px]">
              <span className="font-medium">{round.fromRole}</span>
              <span className="mx-1">→</span>
              <span className="font-medium">{round.toRole}</span>
              <span className={`ml-1 px-1 py-0.5 text-[9px] font-bold uppercase ${round.verdict === "approve" ? "bg-[var(--swiss-black)] text-[var(--swiss-white)]" : round.verdict === "revise" ? "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]" : "bg-[var(--swiss-red)] text-[var(--swiss-white)]"}`}>
                {round.verdict}
              </span>
              <div className="mt-0.5 truncate opacity-70">{round.feedback}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TransitionArrow({ transition }: { transition: FlowTransition }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5">
      <div className="h-4 w-px bg-[var(--swiss-gray-200)]" />
      <svg className="h-3 w-3 text-[var(--swiss-gray-200)]" viewBox="0 0 12 12" fill="none">
        <path d="M6 1v8M3 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate text-[9px] text-[var(--swiss-gray-300)]">
        {transition.triggeredByRole}: {transition.reason.slice(0, 60)}
      </span>
    </div>
  );
}

export function ExecutionFlow({ pollIntervalMs = 3000 }: { pollIntervalMs?: number }) {
  const [data, setData] = useState<ExecutionFlowData | null>(null);

  useEffect(() => {
    let active = true;

    async function fetchFlow() {
      try {
        const res = await fetch(apiUrl("/execution-flow"));
        if (res.ok && active) {
          setData(await res.json());
        }
      } catch {
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
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="swiss-caption">Dynamic orchestration</div>
          <CardTitle className="mt-1 text-xl">Execution flow</CardTitle>
          <CardDescription className="text-sm">Live state transitions and task graph powered by the LLM Router.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border border-dashed border-[var(--swiss-gray-100)] p-6 text-sm text-[var(--swiss-gray-300)]">
            No execution data yet. The flow graph will populate once the autonomous engine begins.
          </div>
        </CardContent>
      </Card>
    );
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
  const transitionByTask = new Map<string, FlowTransition>();
  for (const t of data.transitions) {
    transitionByTask.set(t.toTaskId, t);
  }

  const completedCount = data.tasks.filter((t) => t.status === "completed").length;
  const totalCount = data.tasks.length;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="swiss-caption">Dynamic orchestration</div>
            <CardTitle className="mt-1 text-xl">Execution flow</CardTitle>
            <CardDescription className="text-sm">Live state transitions and task graph powered by the LLM Router.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${statusInfo.color}`}>{statusInfo.label}</span>
            <Badge variant="secondary">{completedCount}/{totalCount} tasks</Badge>
          </div>
        </div>
        {/* Progress bar */}
        <div className="mt-3 h-1.5 w-full overflow-hidden bg-[var(--swiss-gray-50)]">
          <div
            className="h-full bg-[var(--swiss-black)] transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Core Pipeline */}
        <div>
          <div className="swiss-caption mb-2">Core pipeline</div>
          <div className="space-y-1">
            {coreTasks.map((task, index) => (
              <div key={task.id}>
                <TaskNode task={task} feedbackRounds={data.feedbackRounds} />
                {index < coreTasks.length - 1 && transitionByTask.has(coreTasks[index + 1]?.id) && (
                  <TransitionArrow transition={transitionByTask.get(coreTasks[index + 1]!.id)!} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Specialist tasks */}
        {specialistTasks.length > 0 && (
          <div>
            <div className="swiss-caption mb-2">Specialist tasks</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {specialistTasks.map((task) => (
                <TaskNode key={task.id} task={task} feedbackRounds={data.feedbackRounds} />
              ))}
            </div>
          </div>
        )}

        {/* Follow-up tasks */}
        {followUpTasks.length > 0 && (
          <div>
            <div className="swiss-caption mb-2">Follow-up tasks ({followUpTasks.length})</div>
            <div className="space-y-1.5">
              {followUpTasks.map((task) => (
                <div key={task.id} className={`border px-3 py-2 text-xs ${STATUS_COLORS[task.status] ?? STATUS_COLORS.created}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{task.title}</span>
                    <span className="shrink-0 text-[10px] uppercase opacity-70">{task.status.replace(/_/g, " ")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent transitions log */}
        {data.transitions.length > 0 && (
          <div>
            <div className="swiss-caption mb-2">Recent transitions</div>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {data.transitions.slice(-8).reverse().map((t) => (
                <div key={t.id} className="flex items-center gap-2 bg-[var(--swiss-gray-50)] px-2 py-1.5 text-[10px]">
                  <span className={`px-1 py-0.5 font-semibold uppercase ${t.status === "executed" ? "bg-[var(--swiss-black)] text-[var(--swiss-white)]" : t.status === "proposed" ? "bg-[var(--swiss-gray-300)] text-[var(--swiss-white)]" : "bg-[var(--swiss-red)] text-[var(--swiss-white)]"}`}>
                    {t.status}
                  </span>
                  <span className="font-medium">{t.toStatus.replace(/_/g, " ")}</span>
                  <span className="truncate text-[var(--swiss-gray-300)]">{t.reason.slice(0, 50)}</span>
                  <span className="ml-auto shrink-0 text-[var(--swiss-gray-200)]">{t.triggeredByRole}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
