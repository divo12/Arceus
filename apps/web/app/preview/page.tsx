"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, FileCode, Terminal, AlertCircle, Activity, LoaderCircle } from "lucide-react";
import type { CompanySnapshot, Task } from "@arceus/contracts";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { apiUrl } from "../../lib/api";
import { PageShell } from "../../components/page-shell";

type EmployeeActivityEvent = {
  id: string;
  timestamp: string;
  employee: string;
  type: "working" | "file_edit" | "shell" | "error" | "idle" | "info";
  content: string;
  meetingId?: string | null;
  taskId?: string | null;
};

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
  files: Array<{ path: string; modifiedAt: string }>;
};

type OrchestratorStatus = {
  executionStatus: string;
  agentSessions?: Record<string, {
    role: string;
    agentId: string;
    sessionId: string;
    name: string;
    status: "idle" | "working" | "done" | "error";
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
  }>;
  localPreview?: ProductOverview["preview"];
};

const TYPE_ICONS: Record<string, typeof FileCode> = {
  file_edit: FileCode,
  shell: Terminal,
  working: LoaderCircle,
  error: AlertCircle,
  idle: Activity,
  info: Activity,
};

const emptyProductOverview: ProductOverview = {
  root: "",
  preview: {
    status: "idle", url: null, entryUrl: null, validationUrl: null,
    validationStrategy: null, targetKind: null, runtime: null, framework: null,
    command: null, targetPath: null, port: 3210, lastError: null, startedAt: null,
  },
  files: [],
};

export default function PreviewPage() {
  const [snapshot, setSnapshot] = useState<CompanySnapshot | null>(null);
  const [productOverview, setProductOverview] = useState<ProductOverview>(emptyProductOverview);
  const [orchestratorStatus, setOrchestratorStatus] = useState<OrchestratorStatus | null>(null);
  const [activityEvents, setActivityEvents] = useState<EmployeeActivityEvent[]>([]);

  async function loadData() {
    const [companyRes, productRes, orchRes, activityRes] = await Promise.allSettled([
      fetch(apiUrl("/company"), { cache: "no-store" }),
      fetch(apiUrl("/product/overview"), { cache: "no-store" }),
      fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
      fetch(apiUrl("/employee-activity"), { cache: "no-store" }),
    ]);
    if (companyRes.status === "fulfilled" && companyRes.value.ok) setSnapshot(await companyRes.value.json() as CompanySnapshot);
    if (productRes.status === "fulfilled" && productRes.value.ok) setProductOverview(await productRes.value.json() as ProductOverview);
    if (orchRes.status === "fulfilled" && orchRes.value.ok) setOrchestratorStatus(await orchRes.value.json() as OrchestratorStatus);
    if (activityRes.status === "fulfilled" && activityRes.value.ok) setActivityEvents(await activityRes.value.json() as EmployeeActivityEvent[]);
  }

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => void loadData(), 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const es = new EventSource(apiUrl("/employee-activity/stream"));
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as EmployeeActivityEvent;
        setActivityEvents((prev) => {
          if (prev.some((e) => e.id === parsed.id)) return prev;
          const next = [...prev, parsed];
          return next.length > 200 ? next.slice(-200) : next;
        });
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, []);

  const buildTaskWithPreview = snapshot?.tasks.find((t: Task) => t.kind === "implementation" && t.localPreviewUrl);
  const previewHref = productOverview.preview.entryUrl
    ?? productOverview.preview.validationUrl
    ?? productOverview.preview.url
    ?? buildTaskWithPreview?.localPreviewUrl
    ?? null;
  const latestProductFile = productOverview.files[0] ?? null;
  const recentFileEditCount = activityEvents.filter((e) => e.type === "file_edit").length;
  const developerSession = orchestratorStatus?.agentSessions?.developer ?? null;
  const recentFileEdits = activityEvents.filter((e) => e.type === "file_edit").slice(-10).reverse();
  const recentShellEvents = activityEvents.filter((e) => e.type === "shell").slice(-8).reverse();

  return (
    <PageShell title="Product Preview" description="Live preview surface, runtime details, and recent edits.">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            {previewHref ? (
              <a className="inline-flex items-center gap-2 border border-[var(--swiss-gray-200)] px-4 py-2 text-[0.8125rem] font-medium transition hover:border-[var(--swiss-black)]" href={previewHref} target="_blank" rel="noreferrer">
                Open live preview <ArrowUpRight className="h-4 w-4" />
              </a>
            ) : null}
            <Badge variant={productOverview.preview.status === "ready" ? "secondary" : "outline"}>{productOverview.preview.status}</Badge>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-px border border-[var(--swiss-gray-100)]">
          <div className="bg-[var(--swiss-white)] p-4"><div className="swiss-caption">Framework</div><div className="mt-1 text-lg font-semibold">{productOverview.preview.framework ?? "—"}</div></div>
          <div className="bg-[var(--swiss-white)] p-4"><div className="swiss-caption">Runtime</div><div className="mt-1 text-lg font-semibold">{productOverview.preview.runtime ?? "—"}</div></div>
          <div className="bg-[var(--swiss-white)] p-4"><div className="swiss-caption">Files</div><div className="mt-1 text-lg font-semibold">{productOverview.files.length}</div></div>
          <div className="bg-[var(--swiss-white)] p-4"><div className="swiss-caption">Live edits</div><div className="mt-1 text-lg font-semibold">{recentFileEditCount}</div></div>
        </div>
        {/* Preview iframe */}
        <div className="border border-[var(--swiss-gray-100)]">
          {previewHref ? (
            <iframe title="Local preview" src={previewHref} className="h-[560px] w-full bg-white" />
          ) : (
            <div className="flex h-[400px] items-center justify-center text-center text-[var(--swiss-gray-300)]">
              <div className="max-w-md space-y-2">
                <div className="text-lg font-semibold">No live preview yet</div>
                <div className="text-[0.8125rem] leading-6">Once the developer reaches a runnable surface, it will appear here.</div>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Runtime details */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Runtime details</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-[0.8125rem] md:grid-cols-2">
                <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Launch command</div><div className="mt-1 font-medium">{productOverview.preview.command ?? "—"}</div></div>
                <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Served from</div><div className="mt-1 font-medium">{productOverview.preview.targetPath ?? "—"}</div></div>
                <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Validation URL</div><div className="mt-1 font-medium break-all">{productOverview.preview.validationUrl ?? "—"}</div></div>
                <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Target kind</div><div className="mt-1 font-medium">{productOverview.preview.targetKind ?? "—"}</div></div>
                {productOverview.preview.lastError ? (
                  <div className="col-span-2 border border-[var(--swiss-red)] p-3 text-[var(--swiss-red)]"><div className="swiss-caption text-[var(--swiss-red)]">Last error</div><div className="mt-1">{productOverview.preview.lastError}</div></div>
                ) : null}
              </CardContent>
            </Card>

            {/* Recent file edits */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Recent file edits</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-[0.8125rem]">
                {recentFileEdits.length === 0 ? (
                  <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]">No file edits observed yet.</div>
                ) : recentFileEdits.map((evt) => {
                  const Icon = TYPE_ICONS[evt.type] ?? Activity;
                  return (
                    <div key={evt.id} className="border border-[var(--swiss-gray-100)] p-3">
                      <div className="flex items-start gap-3">
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--swiss-gray-300)]" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{evt.content}</div>
                          <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">{evt.employee} · {new Date(evt.timestamp).toLocaleTimeString()}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Shell activity */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Shell activity</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-[0.8125rem]">
                {recentShellEvents.length === 0 ? (
                  <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-[var(--swiss-gray-300)]">No shell activity yet.</div>
                ) : recentShellEvents.map((evt) => (
                  <div key={evt.id} className="border border-[var(--swiss-gray-100)] p-3">
                    <div className="flex items-start gap-3">
                      <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-[var(--swiss-gray-300)]" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{evt.content}</div>
                        <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">{evt.employee} · {new Date(evt.timestamp).toLocaleTimeString()}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Workspace files */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Workspace files</CardTitle></CardHeader>
              <CardContent>
                {productOverview.files.length === 0 ? (
                  <div className="border border-dashed border-[var(--swiss-gray-100)] p-3 text-sm text-[var(--swiss-gray-300)]">No workspace files yet.</div>
                ) : (
                  <div className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
                    {productOverview.files.map((file) => (
                      <div key={`${file.path}-${file.modifiedAt}`} className="border border-[var(--swiss-gray-100)] p-3">
                        <div className="break-all text-[0.8125rem] font-medium">{file.path}</div>
                        <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">Updated {new Date(file.modifiedAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Developer session */}
            {developerSession ? (
              <Card>
                <CardHeader className="pb-3"><CardTitle>Developer session</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-[0.8125rem]">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{developerSession.awaiting ?? "actively working"}</span>
                    <Badge variant={developerSession.status === "error" ? "destructive" : developerSession.status === "working" ? "secondary" : "outline"}>{developerSession.status}</Badge>
                  </div>
                  <div className="leading-6 text-[var(--swiss-gray-400)]">{developerSession.lastEventSummary ?? "No updates yet."}</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Events</div><div className="mt-1 font-semibold">{developerSession.eventCount}</div></div>
                    <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Tools</div><div className="mt-1 font-semibold">{developerSession.toolInvocationCount}</div></div>
                    <div className="border border-[var(--swiss-gray-100)] p-3"><div className="swiss-caption">Shell</div><div className="mt-1 font-semibold">{developerSession.shellCommandCount}</div></div>
                  </div>
                  {developerSession.stallReason ? <div className="border border-[var(--swiss-red)] p-3 text-[var(--swiss-red)]">{developerSession.stallReason}</div> : null}
                </CardContent>
              </Card>
            ) : null}

            {/* Latest workspace change */}
            <div className="border border-[var(--swiss-gray-100)] p-4 text-[0.8125rem]">
              <div className="swiss-caption">Latest change</div>
              <div className="mt-1 font-medium">{latestProductFile?.path ?? "No changes yet"}</div>
              {latestProductFile ? <div className="mt-1 text-xs text-[var(--swiss-gray-300)]">{new Date(latestProductFile.modifiedAt).toLocaleString()}</div> : null}
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
