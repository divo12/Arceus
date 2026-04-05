"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, AlertCircle, Building2, FileCode, FolderKanban, LoaderCircle, Terminal } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

type ProductOverview = {
  root: string;
  preview: {
    status: "idle" | "starting" | "ready" | "error";
    url: string | null;
    entryUrl: string | null;
    validationUrl: string | null;
    validationStrategy: "entry-url" | "health-url" | "root-url" | null;
    targetKind: "browser" | "service" | null;
    runtime: "node" | "python" | "static" | "unknown" | null;
    framework: string | null;
    command: string | null;
    targetPath: string | null;
    port: number;
    lastError: string | null;
    startedAt: string | null;
  };
  files: Array<{
    path: string;
    modifiedAt: string;
  }>;
};

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

const emptyOverview: ProductOverview = {
  root: "",
  preview: {
    status: "idle",
    url: null,
    entryUrl: null,
    validationUrl: null,
    validationStrategy: null,
    targetKind: null,
    runtime: null,
    framework: null,
    command: null,
    targetPath: null,
    port: 3210,
    lastError: null,
    startedAt: null,
  },
  files: [],
};

export default function WorkspacePage() {
  const [productOverview, setProductOverview] = useState<ProductOverview>(emptyOverview);
  const [activityEvents, setActivityEvents] = useState<EmployeeActivityEvent[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const [productResponse, activityResponse] = await Promise.all([
          fetch(`${API_BASE}/product/overview`, { cache: "no-store" }),
          fetch(`${API_BASE}/employee-activity`, { cache: "no-store" }),
        ]);

        if (productResponse.ok) {
          setProductOverview((await productResponse.json()) as ProductOverview);
        }

        if (activityResponse.ok) {
          setActivityEvents((await activityResponse.json()) as EmployeeActivityEvent[]);
        }
      } catch {
        /* ignore */
      }
    }

    void load();
    const interval = setInterval(() => void load(), 1500);
    return () => clearInterval(interval);
  }, []);

  const recentFileEditEvents = [...activityEvents].filter((event) => event.type === "file_edit").slice(-12).reverse();
  const recentShellEvents = [...activityEvents].filter((event) => event.type === "shell").slice(-8).reverse();
  const previewHref = productOverview.preview.entryUrl ?? productOverview.preview.validationUrl ?? productOverview.preview.url;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-4 md:px-8">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <Building2 className="h-4 w-4" />
              Arceus board workspace
            </div>
            <div className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <FolderKanban className="h-5 w-5" />
              Workspace detail
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Board</Link>
            <Link href="/tasks" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Tasks</Link>
            <Link href="/activity" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Activity</Link>
            <Link href="/meetings" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Meetings</Link>
            <Link href="/employees" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Employees</Link>
          </div>
        </div>

        <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-emerald-50/40 to-cyan-50/40">
          <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white/80 px-3 py-1 text-xs font-medium text-emerald-800">
                <FolderKanban className="h-3.5 w-3.5" />
                Dedicated workspace view
              </div>
              <div className="text-2xl font-semibold text-slate-900">Preview, files, and live edits without crowding the board.</div>
              <p className="max-w-2xl text-sm leading-6 text-slate-600">Use this page to inspect the active preview target, recent file changes, and live edit activity while the company runs in the background.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs sm:w-[360px]">
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Preview</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{productOverview.preview.status}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Files</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{productOverview.files.length}</div>
              </div>
              <div className="rounded-xl border border-white/70 bg-white/80 p-3">
                <div className="text-slate-500">Live edits</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{recentFileEditEvents.length}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="space-y-4">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>Preview target</CardTitle>
                <CardDescription>Target-aware local preview and validation state.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-700">
                {previewHref ? (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                    <div className="font-medium text-emerald-800">Preview ready</div>
                    <a className="mt-1 block break-all underline" href={previewHref} target="_blank" rel="noreferrer">{previewHref}</a>
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 p-3 text-slate-500">No local preview URL yet.</div>
                )}
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1">
                  <div><span className="font-medium">Validation:</span> {productOverview.preview.validationStrategy ?? "not available"}</div>
                  <div><span className="font-medium">Target type:</span> {productOverview.preview.targetKind ?? "not available"}</div>
                  <div><span className="font-medium">Framework:</span> {productOverview.preview.framework ?? "not available"}</div>
                  <div><span className="font-medium">Runtime:</span> {productOverview.preview.runtime ?? "not available"}</div>
                  <div><span className="font-medium">Served from:</span> {productOverview.preview.targetPath ?? "not available"}</div>
                  {productOverview.preview.lastError ? <div className="text-red-600"><span className="font-medium">Last error:</span> {productOverview.preview.lastError}</div> : null}
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>Live file edits</CardTitle>
                <CardDescription>Recent `file_edit` activity from the runtime event stream.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {recentFileEditEvents.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-3 text-slate-500">No file edit events observed yet.</div>
                ) : (
                  recentFileEditEvents.map((event) => {
                    const Icon = TYPE_ICONS[event.type];
                    return (
                      <div key={event.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-full border border-slate-200 bg-white p-1.5 text-slate-500"><Icon className="h-4 w-4" /></div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-slate-900">{event.content}</div>
                            <div className="mt-1 text-xs text-slate-500">{event.employee} · {new Date(event.timestamp).toLocaleTimeString()}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>Workspace files</CardTitle>
                <CardDescription>Recent files in `workspace/`, newest first.</CardDescription>
              </CardHeader>
              <CardContent>
                {productOverview.files.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">No workspace files have been created yet.</div>
                ) : (
                  <div className="max-h-[640px] space-y-2 overflow-y-auto pr-1">
                    {productOverview.files.map((file) => (
                      <div key={`${file.path}-${file.modifiedAt}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="break-all font-medium text-slate-900">{file.path}</div>
                        <div className="mt-1 text-xs text-slate-500">Updated {new Date(file.modifiedAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>Recent shell activity</CardTitle>
                <CardDescription>Helpful when implementation is progressing in the background.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {recentShellEvents.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-3 text-slate-500">No shell activity recorded yet.</div>
                ) : (
                  recentShellEvents.map((event) => {
                    const Icon = TYPE_ICONS[event.type];
                    return (
                      <div key={event.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-full border border-slate-200 bg-white p-1.5 text-slate-500"><Icon className="h-4 w-4" /></div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-slate-900">{event.content}</div>
                            <div className="mt-1 text-xs text-slate-500">{event.employee} · {new Date(event.timestamp).toLocaleTimeString()}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}