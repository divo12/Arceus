"use client";

import ReactMarkdown from "react-markdown";
import { useEffect, useState } from "react";
import { ArrowRight, Flag, ListChecks, Radar, Sparkles, X } from "lucide-react";
import type { CompanySnapshot, Task } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";
import { apiUrl } from "../../lib/api";
import { PageShell } from "../../components/page-shell";

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
          fetch(apiUrl("/company"), { cache: "no-store" }),
          fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
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

  const currentSprint = snapshot?.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  const allTasks = snapshot?.tasks ?? [];
  const tasks = currentSprint
    ? allTasks.filter((t) => t.sprintId === currentSprint.id && t.kind !== "follow_up")
    : allTasks.filter((t) => t.kind !== "follow_up");
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
      const response = await fetch(apiUrl(`/artifacts/${artifactId}`), { cache: "no-store" });
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
      const response = await fetch(apiUrl("/board-review/approve"), { method: "POST" });
      if (!response.ok) {
        return;
      }

      const [companyResponse, orchestratorResponse] = await Promise.all([
        fetch(apiUrl("/company"), { cache: "no-store" }),
        fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
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
    <PageShell title="Task Pipeline" description="Tasks move through planning, execution, and completion.">
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Badge variant={executionStatus === "awaiting_board_review" ? "secondary" : "outline"}>{executionStatus}</Badge>
          {currentSprint ? (
            <Badge variant={currentSprint.status === "completed" ? "secondary" : "outline"}>
              Sprint {currentSprint.number} · {currentSprint.status === "completed" ? "Done" : currentSprint.status === "executing" ? "Executing" : currentSprint.status}
            </Badge>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-px border border-[var(--swiss-gray-100)]">
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Tasks</div>
            <div className="mt-1 text-2xl font-semibold">{tasks.length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Live</div>
            <div className="mt-1 text-2xl font-semibold">{tasks.filter((task) => ["in_progress", "verifying"].includes(task.status)).length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Blocked / failed</div>
            <div className="mt-1 text-2xl font-semibold">{tasks.filter((task) => ["blocked", "failed"].includes(task.status)).length}</div>
          </div>
        </div>

        {executionStatus === "done" ? (
          <div className="border border-[var(--swiss-black)] p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-lg font-semibold">
                  {currentSprint?.status === "completed"
                    ? `Sprint ${currentSprint.number} complete`
                    : "Execution cycle complete"}
                </div>
                <div className="mt-1 text-sm text-[var(--swiss-gray-400)]">
                  {currentSprint?.status === "completed"
                    ? `Sprint ${currentSprint.number} complete — CEO is proposing Sprint ${currentSprint.number + 1}. Check the CEO chat.`
                    : queuedFollowUpTasks.length > 0
                      ? `${queuedFollowUpTasks.length} follow-up task${queuedFollowUpTasks.length === 1 ? " is" : "s are"} queued for the next cycle.`
                      : "The current execution cycle is complete. Review the finished package or start the next instruction cycle."}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {pendingApprovals.length > 0 ? (
          <div className="border border-[var(--swiss-red)] p-5">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-lg font-semibold">Board approval required</div>
                <div className="mt-1 text-sm text-[var(--swiss-gray-400)]">
                  {pendingApprovals.length} approval request{pendingApprovals.length === 1 ? " is" : "s are"} pending.
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="swiss-caption">{pendingApprovals[0]?.title}</div>
                <Button
                  size="sm"
                  onClick={async () => {
                    for (const a of pendingApprovals) {
                      await fetch(apiUrl(`/approvals/${a.id}/resolve`), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "approved" }),
                      });
                    }
                    const res = await fetch(apiUrl("/company"), { cache: "no-store" });
                    if (res.ok) setSnapshot((await res.json()) as CompanySnapshot);
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    for (const a of pendingApprovals) {
                      await fetch(apiUrl(`/approvals/${a.id}/resolve`), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "dismissed" }),
                      });
                    }
                    const res = await fetch(apiUrl("/company"), { cache: "no-store" });
                    if (res.ok) setSnapshot((await res.json()) as CompanySnapshot);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Execution model</CardTitle>
            <CardDescription><span className="font-medium">awaiting_board_review</span> is the exception path. The board only intervenes when policy, risk, or unresolved blockers require it.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_360px]">
            <div className="grid gap-4 xl:grid-cols-3">
              {columns.map((column) => (
                <div key={column.title} className="border border-[var(--swiss-gray-100)] p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold">{column.title}</div>
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">{column.tasks.length} task{column.tasks.length === 1 ? "" : "s"}</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-[var(--swiss-gray-200)]" />
                  </div>
                  <div className="space-y-2">
                    {column.tasks.length === 0 ? (
                      <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No tasks in this stage.</div>
                    ) : (
                      column.tasks.map((task) => {
                        const selected = task.id === selectedTask?.id;
                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => setSelectedTaskId(task.id)}
                            className={`w-full border p-3 text-left transition ${selected ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className={`truncate font-semibold ${selected ? "text-[var(--swiss-white)]" : ""}`}>{task.title}</div>
                                <div className={`mt-1 swiss-caption ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-300)]"}`}>{task.kind.replace(/_/g, " ")} · {task.assignedRole}</div>
                              </div>
                              <Badge variant={selected ? "secondary" : taskTone(task.status)}>{task.status}</Badge>
                            </div>
                            <div className={`mt-3 text-xs leading-5 ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-400)]"}`}>{task.deliverable}</div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="border border-[var(--swiss-gray-100)] p-4">
              {selectedTask ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Task spotlight</div>
                      <div className="mt-2 text-xl font-semibold">{selectedTask.title}</div>
                      <div className="mt-1 text-sm leading-6 text-[var(--swiss-gray-400)]">{selectedTask.description}</div>
                    </div>
                    <Badge variant={taskTone(selectedTask.status)}>{selectedTask.status}</Badge>
                  </div>

                  <hr className="swiss-rule" />

                  <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-4 text-sm">
                    <div><span className="font-medium">Kind:</span> {selectedTask.kind.replace(/_/g, " ")}</div>
                    <div><span className="font-medium">Assigned role:</span> {selectedTask.assignedRole}</div>
                    <div><span className="font-medium">Deliverable:</span> {selectedTask.deliverable}</div>
                    <div><span className="font-medium">Depends on:</span> {selectedTask.dependsOnTaskIds.length === 0 ? "none" : selectedTask.dependsOnTaskIds.length}</div>
                    {selectedTask.localPreviewUrl ? <div><span className="font-medium">Preview:</span> {selectedTask.localPreviewUrl}</div> : null}
                    <div><span className="font-medium">Verified:</span> {selectedTask.verifierState.isVerified ? "yes" : "not yet"}</div>
                  </div>

                  {selectedTask.verifierState.feedback ? (
                    <div className="border-l-2 border-[var(--swiss-black)] pl-4 py-3">
                      <div className="mb-2 swiss-caption">Verification feedback</div>
                      <div className="text-sm leading-6">{selectedTask.verifierState.feedback}</div>
                    </div>
                  ) : null}

                  <div className="border border-[var(--swiss-gray-100)] p-4">
                    <div className="mb-2 swiss-caption">Definition of done</div>
                    <div className="space-y-2 text-sm">
                      {selectedTask.definitionOfDone.map((item) => (
                        <div key={item} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">{item}</div>
                      ))}
                    </div>
                  </div>

                  <div className="border border-[var(--swiss-gray-100)] p-4">
                    <div className="mb-2 swiss-caption">Execution evidence</div>
                    {selectedTask.executorState.results.length === 0 && selectedTask.executorState.commandsExecuted.length === 0 ? (
                      <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No execution evidence yet.</div>
                    ) : (
                      <div className="space-y-2 text-sm">
                        {selectedTask.executorState.commandsExecuted.map((command) => (
                          <div key={command} className="truncate border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2 font-mono text-xs">$ {command}</div>
                        ))}
                        {selectedTask.executorState.results.map((result) => (
                          <div key={result} className="truncate border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">{result}</div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border border-[var(--swiss-gray-100)] p-4">
                    <div className="mb-2 swiss-caption">Artifacts</div>
                    {selectedTaskArtifactIds.length === 0 ? (
                      <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No artifacts attached to this task.</div>
                    ) : (
                      <div className="space-y-2">
                        {selectedTaskArtifactIds.map((artifactId) => (
                          <button
                            key={artifactId}
                            type="button"
                            onClick={() => void openArtifact(artifactId)}
                            className="w-full border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2 text-left text-sm text-[var(--swiss-blue)] hover:border-[var(--swiss-gray-200)]"
                          >
                            View artifact {artifactId}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {executionStatus === "awaiting_board_review" && selectedTask.kind === "board_handoff" ? (
                    <div className="border-l-2 border-[var(--swiss-black)] pl-4 py-3">
                      <div className="text-sm font-semibold">Board action required</div>
                      <div className="mt-1 text-sm text-[var(--swiss-gray-400)]">Review the handoff artifact, then approve this package.</div>
                      <Button className="mt-3" onClick={() => void approveBoardReview()}>Approve Board Review</Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-sm text-[var(--swiss-gray-300)]">Select a task from the board to inspect it.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {expandedArtifact ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-[var(--swiss-black)]/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--swiss-gray-100)] px-5 py-4">
              <div>
                <div className="text-lg font-semibold">{expandedArtifact.title}</div>
                <div className="swiss-caption text-[var(--swiss-gray-300)]">
                  {expandedArtifact.agent} · {expandedArtifact.kind} · {new Date(expandedArtifact.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setExpandedArtifact(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              <div className="markdown-content text-sm leading-7">
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
    </PageShell>
  );
}