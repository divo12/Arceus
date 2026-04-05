"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, BrainCircuit, Building2, CheckCircle2, ShieldAlert, Sparkles, Users } from "lucide-react";
import type { AgentIdentity, MemorySummary } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

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
  } | null;
};

const API_BASE = "/backend/api";

function renderList(items: string[], empty: string) {
  if (items.length === 0) {
    return <div className="text-slate-500">{empty}</div>;
  }

  return (
    <div className="space-y-1 text-slate-700">
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
        const response = await fetch(`${API_BASE}/employees`, { cache: "no-store" });
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
    <main className="min-h-screen bg-slate-50 px-4 py-4 md:px-8">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <Building2 className="h-4 w-4" />
              Arceus board workspace
            </div>
            <div className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <Users className="h-5 w-5" />
              Employees and memory
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Board</Link>
            <Link href="/tasks" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Tasks</Link>
            <Link href="/activity" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Activity</Link>
            <Link href="/meetings" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Meetings</Link>
            <Link href="/workspace" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Workspace</Link>
          </div>
        </div>

        <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-cyan-50/40 to-emerald-50/40">
          <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200 bg-white/80 px-3 py-1 text-xs font-medium text-cyan-800">
                <BrainCircuit className="h-3.5 w-3.5" />
                Employee memory network
              </div>
              <div className="text-2xl font-semibold text-slate-900">Roster, memory, and runtime health.</div>
              <p className="max-w-2xl text-sm leading-6 text-slate-600">Select any employee to inspect their working memory, blockers, recent learnings, and runtime state without digging through logs.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs sm:w-[360px]">
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Employees</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{employees.length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Running</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{employees.filter((employee) => employee.status === "running").length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Blockers</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{employees.reduce((count, employee) => count + (employee.memory?.openBlockers.length ?? 0), 0)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="text-base">Employee directory</CardTitle>
              <CardDescription>Interactive roster with quick health status.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {employees.length === 0 ? (
                <p className="text-sm text-slate-500">No employees available yet.</p>
              ) : (
                employees.map((employee) => {
                  const selected = employee.id === selectedEmployee?.id;
                  return (
                    <button
                      key={employee.id}
                      type="button"
                      onClick={() => setSelectedEmployeeId(employee.id)}
                      className={`w-full rounded-2xl border p-3 text-left transition ${selected ? "border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-900/10" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className={`font-semibold ${selected ? "text-white" : "text-slate-900"}`}>{employee.name}</div>
                          <div className={`text-xs ${selected ? "text-slate-300" : "text-slate-500"}`}>{employee.title}</div>
                        </div>
                        <Badge variant={selected ? "secondary" : employee.status === "error" ? "destructive" : employee.status === "running" ? "secondary" : "outline"}>{employee.status}</Badge>
                      </div>
                      <div className={`mt-3 flex flex-wrap gap-2 text-[11px] ${selected ? "text-slate-300" : "text-slate-500"}`}>
                        <span>{employee.role}</span>
                        <span>•</span>
                        <span>{employee.memory?.currentFocus.length ?? 0} focus items</span>
                        <span>•</span>
                        <span>{employee.memory?.openBlockers.length ?? 0} blockers</span>
                      </div>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
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
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><Sparkles className="h-4 w-4" /> Focus</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedEmployee.memory?.currentFocus.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><BrainCircuit className="h-4 w-4" /> Learnings</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedEmployee.memory?.recentLearnings.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><ShieldAlert className="h-4 w-4" /> Blockers</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedEmployee.memory?.openBlockers.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><CheckCircle2 className="h-4 w-4" /> Decisions</div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedEmployee.memory?.importantDecisions.length ?? 0}</div>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-2xl border border-slate-200 p-4">
                      <div className="mb-3 text-sm font-semibold text-slate-900">Memory stack</div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Current focus</div>
                          {renderList(selectedEmployee.memory?.currentFocus ?? [], "No current focus yet.")}
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Recent learnings</div>
                          {renderList(selectedEmployee.memory?.recentLearnings ?? [], "No learnings captured yet.")}
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Open blockers</div>
                          {renderList(selectedEmployee.memory?.openBlockers ?? [], "No blockers recorded.")}
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Important decisions</div>
                          {renderList(selectedEmployee.memory?.importantDecisions ?? [], "No decisions captured yet.")}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><Activity className="h-4 w-4" /> Runtime session</div>
                        {selectedEmployee.session ? (
                          <div className="space-y-3 text-sm text-slate-700">
                            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                              <span className="text-slate-500">Model</span>
                              <span className="font-medium text-slate-900">{selectedEmployee.session.model}</span>
                            </div>
                            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                              <span className="text-slate-500">Runtime status</span>
                              <Badge variant={selectedEmployee.session.runtimeStatus === "connected" ? "secondary" : "outline"}>{selectedEmployee.session.runtimeStatus}</Badge>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                              <div className="text-slate-500">Last seen</div>
                              <div className="mt-1 font-medium text-slate-900">{new Date(selectedEmployee.session.lastSeenAt).toLocaleString()}</div>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No runtime session bound yet.</div>
                        )}
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 to-slate-800 p-4 text-white">
                        <div className="text-sm font-semibold">Memory freshness</div>
                        <div className="mt-2 text-sm text-slate-300">Last memory update</div>
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
    </main>
  );
}
