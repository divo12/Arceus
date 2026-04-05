"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { useEffect, useState } from "react";
import { ArrowRight, Building2, Flag, ListChecks, Radar, Sparkles, X } from "lucide-react";
import type { CompanySnapshot, Task } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";

const API_BASE = "/backend/api";

type Artifact = {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output";
  title: string;
  content: string;
  createdAt: string;
};

function taskTone(status: Task["status"]) {
  if (status === "completed") return "secondary" as const;
  if (["failed", "blocked", "cancelled"].includes(status)) return "destructive" as const;
  return "outline" as const;
}

export default function TasksPage() {
  const [snapshot, setSnapshot] = useState<CompanySnapshot | null>(null);
  const [executionStatus, setExecutionStatus] = useState<string>("idle");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [expandedArtifact, setExpandedArtifact] = useState<Artifact | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [companyResponse, orchestratorResponse] = await Promise.all([
          fetch(`${API_BASE}/company`, { cache: "no-store" }),
          fetch(`${API_BASE}/orchestrator/status`, { cache: "no-store" }),
        ]);

        if (companyResponse.ok) {
          setSnapshot((await companyResponse.json()) as CompanySnapshot);
        }

        if (orchestratorResponse.ok) {
          const orchestrator = (await orchestratorResponse.json()) as { executionStatus: string };
          setExecutionStatus(orchestrator.executionStatus);
        }
      } catch {
        /* ignore */
      }
    }

    void load();
    const interval = setInterval(() => void load(), 1500);
    return () => clearInterval(interval);
  }, []);

  const tasks = snapshot?.tasks ?? [];
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
  const columns = [
    {
      title: "Planning",
      statuses: ["created", "planned"] as Task["status"][],
      tasks: tasks.filter((task) => ["created", "planned"].includes(task.status)),
    },
    {
      title: "In motion",
      statuses: ["in_progress", "verifying", "blocked"] as Task["status"][],
      tasks: tasks.filter((task) => ["in_progress", "verifying", "blocked"].includes(task.status)),
    },
    {
      title: "Finished",
      statuses: ["completed", "failed", "cancelled"] as Task["status"][],
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

  async function openArtifact(artifactId: string) {
    try {
      const response = await fetch(`${API_BASE}/artifacts/${artifactId}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Artifact not found.");
      }

      setExpandedArtifact((await response.json()) as Artifact);
    } catch {
      /* ignore for now */
    }
  }

  async function approveBoardReview() {
    try {
      const response = await fetch(`${API_BASE}/board-review/approve`, { method: "POST" });
      if (!response.ok) {
        return;
      }

      const [companyResponse, orchestratorResponse] = await Promise.all([
        fetch(`${API_BASE}/company`, { cache: "no-store" }),
        fetch(`${API_BASE}/orchestrator/status`, { cache: "no-store" }),
      ]);

      if (companyResponse.ok) {
        setSnapshot((await companyResponse.json()) as CompanySnapshot);
      }

      if (orchestratorResponse.ok) {
        const orchestrator = (await orchestratorResponse.json()) as { executionStatus: string };
        setExecutionStatus(orchestrator.executionStatus);
      }
    } catch {
      /* ignore for now */
    }
  }

  const selectedTaskArtifactIds = selectedTask?.artifactIds ?? [];
  const queuedFollowUpTasks = tasks.filter((task) => task.kind === "follow_up" && ["created", "planned"].includes(task.status));
  const pendingApprovals = snapshot?.approvals.filter((approval) => approval.status === "pending") ?? [];

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-4 md:px-8">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <Building2 className="h-4 w-4" />
              Arceus board workspace
            </div>
            <div className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <ListChecks className="h-5 w-5" />
              Task board
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Board
            </Link>
            <Link href="/activity" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Activity
            </Link>
            <Link href="/meetings" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Meetings
            </Link>
            <Link href="/employees" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Employees
            </Link>
            <Link href="/workspace" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Workspace
            </Link>
            <Badge variant={executionStatus === "awaiting_board_review" ? "secondary" : "outline"}>{executionStatus}</Badge>
          </div>
        </div>

        <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-violet-50/40 to-cyan-50/40">
          <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-white/80 px-3 py-1 text-xs font-medium text-violet-800">
                <Radar className="h-3.5 w-3.5" />
                Task pipeline view
              </div>
              <div className="text-2xl font-semibold text-slate-900">A visual delivery board, not just a task dump.</div>
              <p className="max-w-2xl text-sm leading-6 text-slate-600">Tasks move through planning, execution, and completion. Select a task card to inspect the detailed contract, dependencies, and execution evidence.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs sm:w-[360px]">
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Tasks</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{tasks.length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Live</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{tasks.filter((task) => ["in_progress", "verifying"].includes(task.status)).length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Blocked/failed</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{tasks.filter((task) => ["blocked", "failed"].includes(task.status)).length}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {executionStatus === "done" ? (
          <Card className="border-emerald-200 bg-emerald-50">
            <CardContent className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-lg font-semibold text-emerald-950">Execution cycle complete</div>
                <div className="mt-1 text-sm text-emerald-900">
                  {queuedFollowUpTasks.length > 0
                    ? `${queuedFollowUpTasks.length} follow-up task${queuedFollowUpTasks.length === 1 ? " is" : "s are"} queued for the next cycle. Review them below or send the CEO the next instruction.`
                    : "The current execution cycle is complete. You can now review the finished package or start the next instruction cycle."}
                </div>
              </div>
              <Link href="/" className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-900 hover:bg-emerald-100">
                Return to board
              </Link>
            </CardContent>
          </Card>
        ) : null}

        {pendingApprovals.length > 0 ? (
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="flex flex-col gap-2 p-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-lg font-semibold text-amber-950">Board approval required</div>
                <div className="mt-1 text-sm text-amber-900">
                  {pendingApprovals.length} approval request{pendingApprovals.length === 1 ? " is" : "s are"} pending. Marketing recommendations can be reviewed, but no external action should be taken until the board approves the current handoff.
                </div>
              </div>
              <div className="text-sm font-medium text-amber-950">{pendingApprovals[0]?.title}</div>
            </CardContent>
          </Card>
        ) : null}

        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>Execution model</CardTitle>
            <CardDescription><span className="font-medium text-slate-900">awaiting_board_review</span> is now the exception path. The board only intervenes when policy, risk, or unresolved blockers require it.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_360px]">
            <div className="grid gap-4 xl:grid-cols-3">
              {columns.map((column) => (
                <div key={column.title} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900">{column.title}</div>
                      <div className="text-xs text-slate-500">{column.tasks.length} task{column.tasks.length === 1 ? "" : "s"}</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-slate-400" />
                  </div>
                  <div className="space-y-3">
                    {column.tasks.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">No tasks in this stage.</div>
                    ) : (
                      column.tasks.map((task) => {
                        const selected = task.id === selectedTask?.id;
                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => setSelectedTaskId(task.id)}
                            className={`w-full rounded-2xl border p-3 text-left transition ${selected ? "border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-900/10" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className={`truncate font-semibold ${selected ? "text-white" : "text-slate-900"}`}>{task.title}</div>
                                <div className={`mt-1 text-[11px] uppercase tracking-[0.14em] ${selected ? "text-slate-300" : "text-slate-500"}`}>{task.kind.replace(/_/g, " ")} · {task.assignedRole}</div>
                              </div>
                              <Badge variant={selected ? "secondary" : taskTone(task.status)}>{task.status}</Badge>
                            </div>
                            <div className={`mt-3 text-xs leading-5 ${selected ? "text-slate-200" : "text-slate-600"}`}>{task.deliverable}</div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              {selectedTask ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-500"><Sparkles className="h-4 w-4" /> Task spotlight</div>
                      <div className="mt-2 text-xl font-semibold text-slate-900">{selectedTask.title}</div>
                      <div className="mt-1 text-sm leading-6 text-slate-600">{selectedTask.description}</div>
                    </div>
                    <Badge variant={taskTone(selectedTask.status)}>{selectedTask.status}</Badge>
                  </div>

                  <div className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    <div><span className="font-medium">Kind:</span> {selectedTask.kind.replace(/_/g, " ")}</div>
                    <div><span className="font-medium">Assigned role:</span> {selectedTask.assignedRole}</div>
                    <div><span className="font-medium">Deliverable:</span> {selectedTask.deliverable}</div>
                    <div><span className="font-medium">Depends on:</span> {selectedTask.dependsOnTaskIds.length === 0 ? "none" : selectedTask.dependsOnTaskIds.length}</div>
                    {selectedTask.localPreviewUrl ? <div><span className="font-medium">Preview:</span> {selectedTask.localPreviewUrl}</div> : null}
                    <div><span className="font-medium">Verified:</span> {selectedTask.verifierState.isVerified ? "yes" : "not yet"}</div>
                  </div>

                  {selectedTask.verifierState.feedback ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-950"><Radar className="h-4 w-4" /> Verification status</div>
                      <div className="text-sm leading-6 text-emerald-950">{selectedTask.verifierState.feedback}</div>
                    </div>
                  ) : null}

                  <div className="rounded-2xl border border-slate-200 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900"><Flag className="h-4 w-4" /> Definition of done</div>
                    <div className="space-y-2 text-sm text-slate-700">
                      {selectedTask.definitionOfDone.map((item) => (
                        <div key={item} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">{item}</div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900"><ListChecks className="h-4 w-4" /> Execution evidence</div>
                    {selectedTask.executorState.results.length === 0 && selectedTask.executorState.commandsExecuted.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No execution evidence yet.</div>
                    ) : (
                      <div className="space-y-2 text-sm text-slate-700">
                        {selectedTask.executorState.commandsExecuted.map((command) => (
                          <div key={command} className="truncate rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">$ {command}</div>
                        ))}
                        {selectedTask.executorState.results.map((result) => (
                          <div key={result} className="truncate rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">{result}</div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-slate-200 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900"><Sparkles className="h-4 w-4" /> Artifacts</div>
                    {selectedTaskArtifactIds.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No artifacts attached to this task.</div>
                    ) : (
                      <div className="space-y-2">
                        {selectedTaskArtifactIds.map((artifactId) => (
                          <button
                            key={artifactId}
                            type="button"
                            onClick={() => void openArtifact(artifactId)}
                            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-blue-700 hover:border-slate-300 hover:bg-white"
                          >
                            View artifact {artifactId}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {executionStatus === "awaiting_board_review" && selectedTask.kind === "board_handoff" ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <div className="text-sm font-semibold text-emerald-900">Board action required</div>
                      <div className="mt-1 text-sm text-emerald-800">Review the handoff artifact, then approve this package to close the execution cycle.</div>
                      <Button className="mt-3" onClick={() => void approveBoardReview()}>Approve Board Review</Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-sm text-slate-500">Select a task from the board to inspect it.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {expandedArtifact ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">{expandedArtifact.title}</div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  {expandedArtifact.agent} · {expandedArtifact.kind} · {new Date(expandedArtifact.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setExpandedArtifact(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              <div className="markdown-content text-sm leading-7 text-slate-700">
                <ReactMarkdown>{expandedArtifact.content}</ReactMarkdown>
              </div>
            </div>
            <Separator />
            <div className="flex justify-end px-5 py-3">
              <Button variant="outline" onClick={() => setExpandedArtifact(null)}>Close</Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}