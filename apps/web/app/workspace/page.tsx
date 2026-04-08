"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle, FileCode, FolderKanban, LoaderCircle, Terminal } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { PageShell } from "../../components/page-shell";

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
    <PageShell title="Workspace" description="Preview, files, and live edits.">
      <div className="space-y-6">

        <div className="grid grid-cols-3 gap-px border border-[var(--swiss-gray-100)]">
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Preview</div>
            <div className="mt-1 text-2xl font-semibold">{productOverview.preview.status}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Files</div>
            <div className="mt-1 text-2xl font-semibold">{productOverview.files.length}</div>
          </div>
          <div className="bg-[var(--swiss-white)] p-4">
            <div className="swiss-caption text-[var(--swiss-gray-300)]">Live edits</div>
            <div className="mt-1 text-2xl font-semibold">{recentFileEditEvents.length}</div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Preview target</CardTitle>
                <CardDescription>Target-aware local preview and validation state.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {previewHref ? (
                  <div className="border border-[var(--swiss-black)] p-3">
                    <div className="font-medium">Preview ready</div>
                    <a className="mt-1 block break-all underline" href={previewHref} target="_blank" rel="noreferrer">{previewHref}</a>
                  </div>
                ) : (
                  <div className="border border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]">No local preview URL yet.</div>
                )}
                <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3 space-y-1">
                  <div><span className="font-medium">Validation:</span> {productOverview.preview.validationStrategy ?? "not available"}</div>
                  <div><span className="font-medium">Target type:</span> {productOverview.preview.targetKind ?? "not available"}</div>
                  <div><span className="font-medium">Framework:</span> {productOverview.preview.framework ?? "not available"}</div>
                  <div><span className="font-medium">Runtime:</span> {productOverview.preview.runtime ?? "not available"}</div>
                  <div><span className="font-medium">Served from:</span> {productOverview.preview.targetPath ?? "not available"}</div>
                  {productOverview.preview.lastError ? <div className="text-[var(--swiss-red)]"><span className="font-medium">Last error:</span> {productOverview.preview.lastError}</div> : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Live file edits</CardTitle>
                <CardDescription>Recent file_edit activity from the runtime event stream.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {recentFileEditEvents.length === 0 ? (
                  <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]">No file edit events observed yet.</div>
                ) : (
                  recentFileEditEvents.map((event) => {
                    const Icon = TYPE_ICONS[event.type];
                    return (
                      <div key={event.id} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] p-1.5 text-[var(--swiss-gray-300)]"><Icon className="h-4 w-4" /></div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">{event.content}</div>
                            <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">{event.employee} · {new Date(event.timestamp).toLocaleTimeString()}</div>
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
            <Card>
              <CardHeader>
                <CardTitle>Workspace files</CardTitle>
                <CardDescription>Recent files in workspace/, newest first.</CardDescription>
              </CardHeader>
              <CardContent>
                {productOverview.files.length === 0 ? (
                  <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No workspace files have been created yet.</div>
                ) : (
                  <div className="max-h-[640px] space-y-2 overflow-y-auto pr-1">
                    {productOverview.files.map((file) => (
                      <div key={`${file.path}-${file.modifiedAt}`} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                        <div className="break-all font-medium">{file.path}</div>
                        <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">Updated {new Date(file.modifiedAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent shell activity</CardTitle>
                <CardDescription>Helpful when implementation is progressing in the background.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {recentShellEvents.length === 0 ? (
                  <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]">No shell activity recorded yet.</div>
                ) : (
                  recentShellEvents.map((event) => {
                    const Icon = TYPE_ICONS[event.type];
                    return (
                      <div key={event.id} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] p-1.5 text-[var(--swiss-gray-300)]"><Icon className="h-4 w-4" /></div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">{event.content}</div>
                            <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">{event.employee} · {new Date(event.timestamp).toLocaleTimeString()}</div>
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
    </PageShell>
  );
}