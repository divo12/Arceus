"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle, FileCode, LoaderCircle, Terminal, Waves } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { apiUrl } from "../../lib/api";

type EmployeeActivityEvent = {
  id: string;
  timestamp: string;
  employee: string;
  type: "working" | "file_edit" | "shell" | "error" | "idle" | "info";
  content: string;
  meetingId?: string | null;
  taskId?: string | null;
};

const TYPE_ICONS: Record<EmployeeActivityEvent["type"], typeof Activity> = {
  working: LoaderCircle,
  file_edit: FileCode,
  shell: Terminal,
  error: AlertCircle,
  idle: Activity,
  info: Activity,
};

const ROLE_COLORS: Record<string, string> = {
  cto: "text-[var(--swiss-blue)]",
  pm: "text-[var(--swiss-gray-500)]",
  developer: "text-[var(--swiss-black)]",
  tester: "text-[var(--swiss-gray-400)]",
  ui_designer: "text-[var(--swiss-red)]",
  marketing: "text-[var(--swiss-blue)]",
  skills_lead: "text-[var(--swiss-gray-500)]",
  ceo: "text-[var(--swiss-black)]",
  system: "text-[var(--swiss-gray-300)]",
};

export default function ActivityPage() {
  const [events, setEvents] = useState<EmployeeActivityEvent[]>([]);
  const [activeType, setActiveType] = useState<"all" | EmployeeActivityEvent["type"]>("all");
  const [activeEmployee, setActiveEmployee] = useState<string>("all");

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(apiUrl("/employee-activity"), { cache: "no-store" });
        if (response.ok) {
          setEvents((await response.json()) as EmployeeActivityEvent[]);
        }
      } catch {
        /* ignore */
      }
    }

    void load();
    const es = new EventSource(apiUrl("/employee-activity/stream"));
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
    <main className="min-h-screen px-6 py-6">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <header>
          <div className="swiss-caption text-[var(--swiss-gray-300)]">05 — Activity</div>
          <h1 className="swiss-h1 mt-1">Live operations timeline</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--swiss-gray-400)]">Filter the stream by employee or event type to follow how execution, edits, shell work, and escalations unfolded.</p>
        </header>

        <hr className="swiss-rule" />

        <div className="grid grid-cols-3 gap-px border border-[var(--swiss-gray-100)]">
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Events</div>
            <div className="mt-1 text-2xl font-semibold">{events.length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Errors</div>
            <div className="mt-1 text-2xl font-semibold">{errorCount}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">File edits</div>
            <div className="mt-1 text-2xl font-semibold">{fileEditCount}</div>
          </div>
        </div>

        <Card>
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
                  className={`border px-3 py-1 text-xs font-medium transition ${activeType === type ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`}
                >
                  {type === "all" ? "All types" : type.replace(/_/g, " ")}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setActiveEmployee("all")}
                className={`border px-3 py-1 text-xs font-medium transition ${activeEmployee === "all" ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`}
              >
                All employees
              </button>
              {employees.map((employee) => (
                <button
                  key={employee}
                  type="button"
                  onClick={() => setActiveEmployee(employee)}
                  className={`border px-3 py-1 text-xs font-medium uppercase transition ${activeEmployee === employee ? "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]" : "border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] hover:border-[var(--swiss-gray-200)]"}`}
                >
                  {employee}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <p className="text-sm text-[var(--swiss-gray-300)]">No employee logs recorded for the selected filters.</p>
            ) : (
              <div className="relative space-y-2 before:absolute before:bottom-0 before:left-[18px] before:top-0 before:w-px before:bg-[var(--swiss-gray-100)]">
                {filtered.map((eventItem) => {
                  const Icon = TYPE_ICONS[eventItem.type] ?? Activity;
                  const roleColor = ROLE_COLORS[eventItem.employee] ?? "text-[var(--swiss-gray-400)]";
                  return (
                    <div key={eventItem.id} className="relative pl-12">
                      <div className={`absolute left-0 top-1 flex h-9 w-9 items-center justify-center border ${eventItem.type === "error" ? "border-[var(--swiss-red)] text-[var(--swiss-red)]" : "border-[var(--swiss-gray-100)] text-[var(--swiss-gray-300)]"}`}>
                        <Icon className={`h-4 w-4 ${eventItem.type === "working" ? "animate-spin" : ""}`} />
                      </div>
                      <div className="border border-[var(--swiss-gray-100)] p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-semibold uppercase ${roleColor}`}>{eventItem.employee}</span>
                          <span className="text-[var(--swiss-gray-200)]">·</span>
                          <span className="text-[var(--swiss-gray-300)]">{new Date(eventItem.timestamp).toLocaleString()}</span>
                          <Badge variant="outline">{eventItem.type.replace(/_/g, " ")}</Badge>
                          {eventItem.meetingId ? <Badge variant="outline">meeting {eventItem.meetingId.slice(-6)}</Badge> : null}
                          {eventItem.taskId ? <Badge variant="outline">task {eventItem.taskId.slice(-6)}</Badge> : null}
                        </div>
                        <div className={`mt-2 leading-6 ${eventItem.type === "error" ? "text-[var(--swiss-red)]" : ""}`}>{eventItem.content}</div>
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
