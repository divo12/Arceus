"use client";

import { useEffect, useState } from "react";
import { Activity, BrainCircuit, CheckCircle2, ShieldAlert, Sparkles, Users } from "lucide-react";
import type { AgentIdentity, MemorySummary } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { apiUrl } from "../../lib/api";
import { PageShell } from "../../components/layout/page-shell";

type EmployeeDirectoryEntry = {
  id: string;
  name: string;
  role: AgentIdentity["role"];
  title: string;
  status: string;
  profile: string;
  memory: MemorySummary | null;
  session: {
    id: string;
    runtimeStatus: string;
    model: string;
    lastSeenAt: string;
    sessionId: string | null;
    lastEventAt: string | null;
    lastEventType: string | null;
    lastEventSummary: string | null;
    lastToolName: string | null;
    lastToolStatus: "invoked" | "completed" | null;
    lastToolAt: string | null;
    lastProgressAt: string | null;
    lastWorkspaceChangeAt: string | null;
    awaiting: string | null;
    activeTaskId: string | null;
    promptStartedAt: string | null;
    promptCompletedAt: string | null;
    eventCount: number;
    toolInvocationCount: number;
    fileEditCount: number;
    shellCommandCount: number;
    stallReason: string | null;
  } | null;
};

function renderList(items: string[], empty: string) {
  if (items.length === 0) {
    return <div className="text-[var(--swiss-gray-300)]">{empty}</div>;
  }

  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div key={item}>- {item}</div>
      ))}
    </div>
  );
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<EmployeeDirectoryEntry[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(apiUrl("/employees"), { cache: "no-store" });
        if (response.ok) {
          setEmployees((await response.json()) as EmployeeDirectoryEntry[]);
        }
      } catch {
        /* ignore */
      }
    }

    void load();
    const interval = setInterval(() => void load(), 1500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedEmployeeId && employees[0]) {
      setSelectedEmployeeId(employees[0].id);
      return;
    }

    if (selectedEmployeeId && !employees.some((employee) => employee.id === selectedEmployeeId)) {
      setSelectedEmployeeId(employees[0]?.id ?? null);
    }
  }, [employees, selectedEmployeeId]);

  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId) ?? employees[0] ?? null;

  return (
    <PageShell title="Team Roster" description="Employee directory, working memory, and runtime health.">
      <div className="space-y-6">

        <div className="grid grid-cols-3 gap-px border border-[var(--swiss-gray-100)]">
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Employees</div>
            <div className="mt-1 text-2xl font-semibold">{employees.length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Running</div>
            <div className="mt-1 text-2xl font-semibold">{employees.filter((employee) => employee.status === "running").length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Blockers</div>
            <div className="mt-1 text-2xl font-semibold">{employees.reduce((count, employee) => count + (employee.memory?.openBlockers.length ?? 0), 0)}</div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Employee directory</CardTitle>
              <CardDescription>Interactive roster with quick health status.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {employees.length === 0 ? (
                <p className="text-sm text-[var(--swiss-gray-300)]">No employees available yet.</p>
              ) : (
                employees.map((employee) => {
                  const selected = employee.id === selectedEmployee?.id;
                  return (
                    <button
                      key={employee.id}
                      type="button"
                      onClick={() => setSelectedEmployeeId(employee.id)}
                      className={`w-full border p-3 text-left transition ${selected ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className={`font-semibold ${selected ? "text-[var(--swiss-white)]" : ""}`}>{employee.name}</div>
                          <div className={`text-xs ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-300)]"}`}>{employee.title}</div>
                        </div>
                        <Badge variant={selected ? "secondary" : employee.status === "error" ? "destructive" : employee.status === "running" ? "secondary" : "outline"}>{employee.status}</Badge>
                      </div>
                      <div className={`mt-3 flex flex-wrap gap-2 swiss-caption ${selected ? "text-[var(--swiss-gray-200)]" : "text-[var(--swiss-gray-300)]"}`}>
                        <span>{employee.role}</span>
                        <span>·</span>
                        <span>{employee.memory?.currentFocus.length ?? 0} focus items</span>
                        <span>·</span>
                        <span>{employee.memory?.openBlockers.length ?? 0} blockers</span>
                      </div>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              {selectedEmployee ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-xl">{selectedEmployee.name} · {selectedEmployee.title}</CardTitle>
                      <CardDescription className="mt-1 max-w-3xl text-sm leading-6">{selectedEmployee.profile}</CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{selectedEmployee.role}</Badge>
                      <Badge variant={selectedEmployee.status === "error" ? "destructive" : selectedEmployee.status === "running" ? "secondary" : "outline"}>{selectedEmployee.status}</Badge>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <CardTitle>No employee selected</CardTitle>
                  <CardDescription>Select an employee from the directory.</CardDescription>
                </>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              {selectedEmployee ? (
                <>
                  <div className="grid gap-px border border-[var(--swiss-gray-100)] md:grid-cols-2 xl:grid-cols-4">
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Focus</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedEmployee.memory?.currentFocus.length ?? 0}</div>
                    </div>
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Learnings</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedEmployee.memory?.recentLearnings.length ?? 0}</div>
                    </div>
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Blockers</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedEmployee.memory?.openBlockers.length ?? 0}</div>
                    </div>
                    <div className="bg-[var(--swiss-white)] p-4">
                      <div className="swiss-caption text-[var(--swiss-gray-300)]">Decisions</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedEmployee.memory?.importantDecisions.length ?? 0}</div>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="border border-[var(--swiss-gray-100)] p-4">
                      <div className="mb-3 text-sm font-semibold">Memory stack</div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                          <div className="mb-2 swiss-caption text-[var(--swiss-gray-300)]">Current focus</div>
                          {renderList(selectedEmployee.memory?.currentFocus ?? [], "No current focus yet.")}
                        </div>
                        <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                          <div className="mb-2 swiss-caption text-[var(--swiss-gray-300)]">Recent learnings</div>
                          {renderList(selectedEmployee.memory?.recentLearnings ?? [], "No learnings captured yet.")}
                        </div>
                        <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                          <div className="mb-2 swiss-caption text-[var(--swiss-gray-300)]">Open blockers</div>
                          {renderList(selectedEmployee.memory?.openBlockers ?? [], "No blockers recorded.")}
                        </div>
                        <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                          <div className="mb-2 swiss-caption text-[var(--swiss-gray-300)]">Important decisions</div>
                          {renderList(selectedEmployee.memory?.importantDecisions ?? [], "No decisions captured yet.")}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="border border-[var(--swiss-gray-100)] p-4">
                        <div className="mb-3 swiss-caption">Runtime session</div>
                        {selectedEmployee.session ? (
                          <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                              <span className="text-[var(--swiss-gray-300)]">Model</span>
                              <span className="font-medium">{selectedEmployee.session.model}</span>
                            </div>
                            <div className="flex items-center justify-between border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                              <span className="text-[var(--swiss-gray-300)]">Runtime status</span>
                              <Badge variant={selectedEmployee.session.runtimeStatus === "connected" ? "secondary" : "outline"}>{selectedEmployee.session.runtimeStatus}</Badge>
                            </div>
                            <div className="flex items-center justify-between border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                              <span className="text-[var(--swiss-gray-300)]">Opencode session</span>
                              <span className="font-medium">{selectedEmployee.session.sessionId ? selectedEmployee.session.sessionId.slice(-8) : "not bound"}</span>
                            </div>
                            <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                              <div className="text-[var(--swiss-gray-300)]">Awaiting</div>
                              <div className="mt-1 font-medium">{selectedEmployee.session.awaiting ?? "idle"}</div>
                            </div>
                            <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                              <div className="text-[var(--swiss-gray-300)]">Last session update</div>
                              <div className="mt-1 text-sm font-medium">{selectedEmployee.session.lastEventSummary ?? "No Opencode progress recorded yet."}</div>
                              {selectedEmployee.session.lastEventType ? <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">{selectedEmployee.session.lastEventType}</div> : null}
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                                <div className="text-[var(--swiss-gray-300)]">Last progress</div>
                                <div className="mt-1 font-medium">{selectedEmployee.session.lastProgressAt ? new Date(selectedEmployee.session.lastProgressAt).toLocaleString() : "No progress yet"}</div>
                              </div>
                              <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                                <div className="text-[var(--swiss-gray-300)]">Last workspace change</div>
                                <div className="mt-1 font-medium">{selectedEmployee.session.lastWorkspaceChangeAt ? new Date(selectedEmployee.session.lastWorkspaceChangeAt).toLocaleString() : "No workspace changes"}</div>
                              </div>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                                <div className="text-[var(--swiss-gray-300)]">Events</div>
                                <div className="mt-1 font-medium">{selectedEmployee.session.eventCount}</div>
                              </div>
                              <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                                <div className="text-[var(--swiss-gray-300)]">Tools</div>
                                <div className="mt-1 font-medium">{selectedEmployee.session.toolInvocationCount}</div>
                              </div>
                              <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                                <div className="text-[var(--swiss-gray-300)]">Shell commands</div>
                                <div className="mt-1 font-medium">{selectedEmployee.session.shellCommandCount}</div>
                              </div>
                            </div>
                            {selectedEmployee.session.lastToolName ? (
                              <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                                <div className="text-[var(--swiss-gray-300)]">Last tool</div>
                                <div className="mt-1 font-medium">{selectedEmployee.session.lastToolName}{selectedEmployee.session.lastToolStatus ? ` (${selectedEmployee.session.lastToolStatus})` : ""}</div>
                              </div>
                            ) : null}
                            {selectedEmployee.session.stallReason ? (
                              <div className="border border-[var(--swiss-red)] px-3 py-2">
                                <div className="font-medium">Stall diagnosis</div>
                                <div className="mt-1 text-sm leading-6">{selectedEmployee.session.stallReason}</div>
                              </div>
                            ) : null}
                            <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-3 py-2">
                              <div className="text-[var(--swiss-gray-300)]">Last seen</div>
                              <div className="mt-1 font-medium">{new Date(selectedEmployee.session.lastSeenAt).toLocaleString()}</div>
                            </div>
                          </div>
                        ) : (
                          <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No runtime session bound yet.</div>
                        )}
                      </div>

                      <div className="border border-[var(--swiss-black)] bg-[var(--swiss-black)] p-4 text-[var(--swiss-white)]">
                        <div className="text-sm font-semibold">Memory freshness</div>
                        <div className="mt-2 text-sm text-[var(--swiss-gray-200)]">Last memory update</div>
                        <div className="mt-1 text-lg font-semibold">{selectedEmployee.memory ? new Date(selectedEmployee.memory.updatedAt).toLocaleString() : "No memory yet"}</div>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
