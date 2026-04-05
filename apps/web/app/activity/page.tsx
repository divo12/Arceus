"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, AlertCircle, Building2, FileCode, LoaderCircle, Terminal, Waves } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

type EmployeeActivityEvent = {
  id: string;
  timestamp: string;
  employee: string;
  type: "working" | "file_edit" | "shell" | "error" | "idle" | "info";
  content: string;
  meetingId?: string | null;
  taskId?: string | null;
};

const API_BASE = "/backend/api";

const TYPE_ICONS: Record<EmployeeActivityEvent["type"], typeof Activity> = {
  working: LoaderCircle,
  file_edit: FileCode,
  shell: Terminal,
  error: AlertCircle,
  idle: Activity,
  info: Activity,
};

const ROLE_COLORS: Record<string, string> = {
  cto: "text-blue-600",
  pm: "text-purple-600",
  developer: "text-green-600",
  tester: "text-amber-600",
  ui_designer: "text-rose-600",
  marketing: "text-cyan-600",
  skills_lead: "text-fuchsia-600",
  ceo: "text-slate-700",
  system: "text-slate-500",
};

export default function ActivityPage() {
  const [events, setEvents] = useState<EmployeeActivityEvent[]>([]);
  const [activeType, setActiveType] = useState<"all" | EmployeeActivityEvent["type"]>("all");
  const [activeEmployee, setActiveEmployee] = useState<string>("all");

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(`${API_BASE}/employee-activity`, { cache: "no-store" });
        if (response.ok) {
          setEvents((await response.json()) as EmployeeActivityEvent[]);
        }
      } catch {
        /* ignore */
      }
    }

    void load();
    const es = new EventSource(`${API_BASE}/employee-activity/stream`);
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as EmployeeActivityEvent;
        setEvents((current) => {
          if (current.some((entry) => entry.id === parsed.id)) return current;
          return [...current, parsed].slice(-500);
        });
      } catch {
        /* ignore */
      }
    };

    return () => es.close();
  }, []);

  const ordered = [...events].reverse();
  const employees = Array.from(new Set(events.map((event) => event.employee))).sort();
  const filtered = ordered.filter((event) => (activeType === "all" || event.type === activeType) && (activeEmployee === "all" || event.employee === activeEmployee));
  const errorCount = events.filter((event) => event.type === "error").length;
  const fileEditCount = events.filter((event) => event.type === "file_edit").length;

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
              <Activity className="h-5 w-5" />
              Employee activity
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Board</Link>
            <Link href="/tasks" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Tasks</Link>
            <Link href="/meetings" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Meetings</Link>
            <Link href="/employees" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Employees</Link>
            <Link href="/workspace" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Workspace</Link>
          </div>
        </div>

        <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-sky-50/50 to-slate-100/70">
          <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white/80 px-3 py-1 text-xs font-medium text-sky-800">
                <Waves className="h-3.5 w-3.5" />
                Live operations timeline
              </div>
              <div className="text-2xl font-semibold text-slate-900">Company work, rendered as a live event stream.</div>
              <p className="max-w-2xl text-sm leading-6 text-slate-600">Filter the stream by employee or event type to follow how execution, edits, shell work, and escalations unfolded.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs sm:w-[360px]">
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Events</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{events.length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Errors</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{errorCount}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">File edits</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{fileEditCount}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>Employee log stream</CardTitle>
            <CardDescription>Company work is visible here as employee logs instead of generic agent traces.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(["all", "working", "file_edit", "shell", "error", "idle", "info"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setActiveType(type)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${activeType === type ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
                >
                  {type === "all" ? "All types" : type.replace(/_/g, " ")}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setActiveEmployee("all")}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${activeEmployee === "all" ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
              >
                All employees
              </button>
              {employees.map((employee) => (
                <button
                  key={employee}
                  type="button"
                  onClick={() => setActiveEmployee(employee)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium uppercase transition ${activeEmployee === employee ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
                >
                  {employee}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <p className="text-sm text-slate-500">No employee logs recorded for the selected filters.</p>
            ) : (
              <div className="relative space-y-3 before:absolute before:bottom-0 before:left-[18px] before:top-0 before:w-px before:bg-slate-200">
                {filtered.map((eventItem) => {
                  const Icon = TYPE_ICONS[eventItem.type] ?? Activity;
                  const roleColor = ROLE_COLORS[eventItem.employee] ?? "text-slate-600";
                  return (
                    <div key={eventItem.id} className="relative pl-12">
                      <div className={`absolute left-0 top-1 flex h-9 w-9 items-center justify-center rounded-full border ${eventItem.type === "error" ? "border-red-200 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500"}`}>
                        <Icon className={`h-4 w-4 ${eventItem.type === "working" ? "animate-spin" : ""}`} />
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-semibold uppercase ${roleColor}`}>{eventItem.employee}</span>
                          <span className="text-slate-300">·</span>
                          <span className="text-slate-500">{new Date(eventItem.timestamp).toLocaleString()}</span>
                          <Badge variant="outline">{eventItem.type.replace(/_/g, " ")}</Badge>
                          {eventItem.meetingId ? <Badge variant="outline">meeting {eventItem.meetingId.slice(-6)}</Badge> : null}
                          {eventItem.taskId ? <Badge variant="outline">task {eventItem.taskId.slice(-6)}</Badge> : null}
                        </div>
                        <div className={`mt-2 leading-6 ${eventItem.type === "error" ? "text-red-600" : "text-slate-700"}`}>{eventItem.content}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
