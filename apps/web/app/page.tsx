"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { useEffect, useRef, useState, useTransition } from "react";
import { Activity, AlertCircle, ArrowUpRight, Bot, Building2, CalendarDays, Check, Cpu, FileCode, LoaderCircle, Play, Terminal, X } from "lucide-react";
import type { AgentIdentity, CompanySnapshot, Task } from "@arceus/contracts";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";

type RuntimeStatus = {
  ready: boolean;
  chatReady: boolean;
  buildReady: boolean;
  missing: string[];
  missingChat: string[];
  missingBuild: string[];
  runtime: {
    provider: string;
    endpoint: string;
    resourceName: string;
    ceoDeploymentConfigured: boolean;
    workerDeploymentConfigured: boolean;
  };
};

// ── Card types matching backend CeoCard schema ───────────

type RoleEntry = {
  role: AgentIdentity["role"];
  title: string;
  parent_role: AgentIdentity["role"] | null;
  capabilities: string[];
};

type StrategyBlock = {
  first_release: string;
  scope_boundary: string[];
  role_rationale: string[];
  roles: RoleEntry[];
};

type QuestionBlock = {
  prompt: string;
  options: string[];
};

type CeoTaskDelta = {
  action: "create" | "reprioritize" | "reassign" | "cancel";
  title: string;
  details: string;
  assigned_role: AgentIdentity["role"];
  priority: Task["priority"];
  target_task_hint: string | null;
};

type MeetingIntentBlock = {
  create: boolean;
  type: "ad_hoc" | "sync" | "escalation" | null;
  summary: string;
  rationale: string;
  task_deltas: CeoTaskDelta[];
};

type StrategyProposalCard = {
  card_type: "strategy_proposal";
  title: string;
  summary: string;
  strategy: StrategyBlock;
  question: null;
  meeting: MeetingIntentBlock;
};

type ClarifyingQuestionCard = {
  card_type: "clarifying_question";
  title: string;
  summary: string;
  strategy: null;
  question: QuestionBlock;
  meeting: MeetingIntentBlock;
};

type StatusUpdateCard = {
  card_type: "status_update";
  title: string;
  summary: string;
  strategy: null;
  question: null;
  meeting: MeetingIntentBlock;
};

type CeoCard = StrategyProposalCard | ClarifyingQuestionCard | StatusUpdateCard;

type ChatBubble = {
  id: string;
  role: "board" | "ceo" | "system";
  content: string;
  card?: CeoCard;
};

type StreamDonePayload = {
  content?: string;
  snapshot?: CompanySnapshot;
};

type MeetingEventPayload = {
  meetingId: string;
  summary: string;
  type: "ad_hoc" | "sync" | "escalation";
  taskDeltaCount: number;
  memoryDeltaCount: number;
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

type Artifact = {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output";
  title: string;
  content: string;
  createdAt: string;
};

type ApprovalItem = CompanySnapshot["approvals"][number];

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

type OrchestratorStatus = {
  executionStatus: string;
  localPreview?: ProductOverview["preview"];
};

const ROLE_COLORS: Record<string, string> = {
  ceo: "text-slate-700",
  cto: "text-blue-600",
  pm: "text-purple-600",
  developer: "text-green-600",
  tester: "text-amber-600",
  ui_designer: "text-rose-600",
  marketing: "text-cyan-600",
  skills_lead: "text-fuchsia-600",
  system: "text-slate-500",
};

const TYPE_ICONS: Record<string, typeof FileCode> = {
  file_edit: FileCode,
  shell: Terminal,
  working: LoaderCircle,
  error: AlertCircle,
  idle: Activity,
  info: Activity,
};

const API_BASE = "/backend/api";
const CHAT_STORAGE_KEY = "arceus-board-messages";

const emptyProductOverview: ProductOverview = {
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

const emptySnapshot: CompanySnapshot = {
  company: {
    id: "company_pending",
    name: "Arceus",
    boardOwner: "board_primary",
    goal: "",
    budgetCents: 0,
    spentCents: 0,
    status: "ideation",
    currentStrategyId: "strategy_pending",
    createdAt: new Date(0).toISOString()
  },
  idea: {
    id: "idea_pending",
    companyId: "company_pending",
    coreIdea: "",
    currentDirection: "",
    refinedWithBoard: false
  },
  strategy: {
    id: "strategy_pending",
    companyId: "company_pending",
    title: "CEO workspace is waiting for your first message",
    summary: "Describe what you want the company to build. The CEO will narrow it into a real first release and propose the initial org chart.",
    firstRelease: "",
    scopeBoundary: [],
    roleRationale: [],
    status: "draft",
    createdByAgentId: "agent_ceo",
    createdAt: new Date(0).toISOString()
  },
  hierarchy: [],
  agents: [],
  sessions: [],
  tasks: [],
  meetings: [],
  approvals: [],
  memories: []
};

function formatCurrency(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(cents / 100);
}

function createId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
}

function extractArtifactId(content: string) {
  const match = content.match(/\/api\/artifacts\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

function taskTone(status: Task["status"]) {
  if (["completed"].includes(status)) return "secondary" as const;
  if (["failed", "blocked", "cancelled"].includes(status)) return "destructive" as const;
  if (["in_progress", "planned", "verifying"].includes(status)) return "outline" as const;
  return "outline" as const;
}

function buildStrategyPayload(card: StrategyProposalCard) {
  if (!card.strategy) {
    throw new Error("Strategy proposal is missing structured strategy data.");
  }

  return {
    strategy_title: card.title,
    summary: card.summary,
    first_release: card.strategy.first_release,
    scope_boundary: card.strategy.scope_boundary,
    role_rationale: card.strategy.role_rationale,
    roles: card.strategy.roles,
  };
}

function toLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function RoleEditor({
  role,
  onChange,
}: {
  role: RoleEntry;
  onChange: (next: RoleEntry) => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge variant="outline">{role.role}</Badge>
        <span className="text-[11px] text-slate-500">reports to {role.parent_role ?? "board"}</span>
      </div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Title</label>
      <input
        className="mb-3 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none ring-0"
        value={role.title}
        onChange={(event) => onChange({ ...role, title: event.target.value })}
      />
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Capabilities</label>
      <Textarea
        className="min-h-[90px] border-slate-200 bg-white text-sm"
        value={role.capabilities.join("\n")}
        onChange={(event) => onChange({ ...role, capabilities: toLines(event.target.value) })}
      />
    </div>
  );
}

function MeetingIntentSummary({ meeting }: { meeting: MeetingIntentBlock }) {
  if (!meeting.create) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{meeting.type?.replace(/_/g, " ") ?? "meeting"}</Badge>
        <Badge variant="outline">{meeting.task_deltas.length} task delta{meeting.task_deltas.length === 1 ? "" : "s"}</Badge>
      </div>
      <div className="mt-2 text-sm font-medium text-slate-900">{meeting.summary}</div>
      <div className="mt-1 text-sm leading-6 text-slate-600">{meeting.rationale}</div>
      {meeting.task_deltas.length > 0 ? (
        <div className="mt-3 space-y-2">
          {meeting.task_deltas.map((delta, index) => (
            <div key={`${delta.title}-${index}`} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{delta.action}</Badge>
                <Badge variant="outline">{delta.assigned_role}</Badge>
                <Badge variant="outline">{delta.priority}</Badge>
              </div>
              <div className="mt-2 font-medium text-slate-900">{delta.title}</div>
              <div className="mt-1 leading-5">{delta.details}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StrategyProposalEditor({
  card,
  busy,
  resolved,
  onApprove,
}: {
  card: StrategyProposalCard;
  busy: boolean;
  resolved: boolean;
  onApprove: (card: StrategyProposalCard, execute: boolean) => Promise<void>;
}) {
  if (!card.strategy) {
    return (
      <Card className="border-red-200 shadow-none">
        <CardContent className="pt-6 text-sm text-red-700">The strategy proposal card is missing structured strategy data.</CardContent>
      </Card>
    );
  }

  const [draft, setDraft] = useState<StrategyProposalCard>(card);

  return (
    <Card className="border-slate-300 shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{draft.title}</CardTitle>
            <CardDescription className="text-xs">Editable strategy proposal selected by the CEO card classifier.</CardDescription>
          </div>
          {resolved ? <Badge variant="secondary">Approved</Badge> : <Badge variant="outline">Needs board action</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <MeetingIntentSummary meeting={draft.meeting} />

        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Strategy Title</label>
          <input
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none"
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            disabled={resolved}
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Summary</label>
          <Textarea
            className="min-h-[110px] border-slate-200 bg-white text-sm"
            value={draft.summary}
            onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
            disabled={resolved}
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">First Release</label>
          <Textarea
            className="min-h-[70px] border-slate-200 bg-white text-sm"
            value={draft.strategy.first_release}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                strategy: { ...current.strategy, first_release: event.target.value },
              }))
            }
            disabled={resolved}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Scope Boundary</label>
            <Textarea
              className="min-h-[120px] border-slate-200 bg-white text-sm"
              value={draft.strategy.scope_boundary.join("\n")}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  strategy: { ...current.strategy, scope_boundary: toLines(event.target.value) },
                }))
              }
              disabled={resolved}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Role Rationale</label>
            <Textarea
              className="min-h-[120px] border-slate-200 bg-white text-sm"
              value={draft.strategy.role_rationale.join("\n")}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  strategy: { ...current.strategy, role_rationale: toLines(event.target.value) },
                }))
              }
              disabled={resolved}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Team Structure</div>
          <div className="grid gap-3 xl:grid-cols-2">
            {draft.strategy.roles.map((role, index) => (
              <RoleEditor
                key={`${role.role}-${index}`}
                role={role}
                onChange={(nextRole) =>
                  setDraft((current) => ({
                    ...current,
                    strategy: {
                      ...current.strategy,
                      roles: current.strategy.roles.map((entry, entryIndex) => (entryIndex === index ? nextRole : entry)),
                    },
                  }))
                }
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={busy || resolved} onClick={() => void onApprove(draft, false)}>
            <Check className="h-4 w-4" />
            Approve
          </Button>
          <Button disabled={busy || resolved} onClick={() => void onApprove(draft, true)}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Approve & Execute
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ClarifyingQuestionView({
  card,
  disabled,
  onChoose,
}: {
  card: ClarifyingQuestionCard;
  disabled: boolean;
  onChoose: (option: string) => void;
}) {
  if (!card.question) {
    return (
      <Card className="border-red-200 shadow-none">
        <CardContent className="pt-6 text-sm text-red-700">The clarifying question card is missing question data.</CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-slate-300 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{card.title}</CardTitle>
        <CardDescription className="text-xs">The CEO is asking the board to narrow the problem.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MeetingIntentSummary meeting={card.meeting} />
        <p className="text-sm leading-6 text-slate-700">{card.question.prompt}</p>
        <div className="flex flex-wrap gap-2">
          {card.question.options.map((option) => (
            <Button key={option} variant="outline" size="sm" disabled={disabled} onClick={() => onChoose(option)}>
              {option}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusUpdateView({ card }: { card: StatusUpdateCard }) {
  return (
    <Card className="border-slate-300 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{card.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <MeetingIntentSummary meeting={card.meeting} />
        <p className="text-sm leading-6 text-slate-700">{card.summary}</p>
      </CardContent>
    </Card>
  );
}

export default function Page() {
  const [snapshot, setSnapshot] = useState<CompanySnapshot>(emptySnapshot);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [isPending, startTransition] = useTransition();
  const [isStreaming, setIsStreaming] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<EmployeeActivityEvent[]>([]);
  const [executionStatus, setExecutionStatus] = useState<string>("idle");
  const [proposalActionId, setProposalActionId] = useState<string | null>(null);
  const [resolvedProposalIds, setResolvedProposalIds] = useState<string[]>([]);
  const [quickExecuting, setQuickExecuting] = useState(false);
  const [stoppingExecution, setStoppingExecution] = useState(false);
  const [expandedArtifact, setExpandedArtifact] = useState<Artifact | null>(null);
  const [productOverview, setProductOverview] = useState<ProductOverview>(emptyProductOverview);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatHydratedRef = useRef(false);

  async function loadState() {
    try {
      const [companyResponse, runtimeResponse] = await Promise.all([
        fetch(`${API_BASE}/company`, { cache: "no-store" }),
        fetch(`${API_BASE}/runtime`, { cache: "no-store" })
      ]);

      if (!companyResponse.ok || !runtimeResponse.ok) {
        throw new Error("The Arceus API returned a non-success response.");
      }

      const companyData = (await companyResponse.json()) as CompanySnapshot;
      const runtimeData = (await runtimeResponse.json()) as RuntimeStatus;

      setSnapshot(companyData);
      setRuntime(runtimeData);
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Failed to reach the Arceus API.");
    }
  }

  async function loadExecutionTelemetry() {
    try {
      const [activityResponse, orchestratorResponse, companyResponse, productResponse] = await Promise.all([
        fetch(`${API_BASE}/employee-activity`, { cache: "no-store" }),
        fetch(`${API_BASE}/orchestrator/status`, { cache: "no-store" }),
        fetch(`${API_BASE}/company`, { cache: "no-store" }),
        fetch(`${API_BASE}/product/overview`, { cache: "no-store" }),
      ]);

      if (activityResponse.ok) {
        setActivityEvents((await activityResponse.json()) as EmployeeActivityEvent[]);
      }

      if (orchestratorResponse.ok) {
        const orchestrator = (await orchestratorResponse.json()) as OrchestratorStatus;
        setExecutionStatus(orchestrator.executionStatus);
      }

      if (companyResponse.ok) {
        setSnapshot((await companyResponse.json()) as CompanySnapshot);
      }

      if (productResponse.ok) {
        setProductOverview((await productResponse.json()) as ProductOverview);
      }
    } catch {
      /* polling fallback should stay silent */
    }
  }

  useEffect(() => {
    void loadState();
    void loadExecutionTelemetry();
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatBubble[];
        setMessages(parsed);
      }
    } catch {
      /* ignore broken session state */
    } finally {
      chatHydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!chatHydratedRef.current) {
      return;
    }
    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* ignore storage failures */
    }
  }, [messages]);

  async function handleApproveBoardReview() {
    try {
      const response = await fetch(`${API_BASE}/board-review/approve`, {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Board review approval failed.");
      }

      const payload = (await response.json()) as { queuedFollowUpCount?: number; resolvedApprovalCount?: number };
      await loadState();
      await loadExecutionTelemetry();
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: payload.queuedFollowUpCount || payload.resolvedApprovalCount
            ? `Board approved the CTO handoff package. Execution is complete.${payload.queuedFollowUpCount ? ` ${payload.queuedFollowUpCount} follow-up task${payload.queuedFollowUpCount === 1 ? " is" : "s are"} queued for the next cycle.` : ""}${payload.resolvedApprovalCount ? ` ${payload.resolvedApprovalCount} approval request${payload.resolvedApprovalCount === 1 ? " was" : "s were"} resolved.` : ""}`
            : "Board approved the CTO handoff package. Execution is now marked complete.",
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Board review approval failed.",
        },
      ]);
    }
  }

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Activity SSE stream
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/employee-activity/stream`);

    void loadExecutionTelemetry();

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as EmployeeActivityEvent;
        setActivityEvents((prev) => {
          // Deduplicate by id
          if (prev.some((e) => e.id === parsed.id)) return prev;
          const next = [...prev, parsed];
          // Keep last 200 events in UI
          return next.length > 200 ? next.slice(-200) : next;
        });
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect
    };

    return () => es.close();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void loadExecutionTelemetry();
    }, isStreaming || executionStatus !== "idle" ? 1500 : 4000);

    return () => clearInterval(interval);
  }, [isStreaming, executionStatus]);

  async function sendMessage(rawMessage?: string) {
    const trimmed = (rawMessage ?? composer).trim();
    if (!trimmed) return;

    if (runtime && !runtime.chatReady) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content:
            "The CEO cannot respond yet because the Azure deployment name is still missing. Set ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT or ARCEUS_AZURE_OPENAI_DEPLOYMENT and try again."
        }
      ]);
      return;
    }

    const userBubble: ChatBubble = {
      id: createId(),
      role: "board",
      content: trimmed
    };

    setMessages((current) => [...current, userBubble]);
    if (!rawMessage) {
      setComposer("");
    }
    setIsStreaming(true);

    const ceoBubbleId = createId();
    setMessages((current) => [
      ...current,
      {
        id: ceoBubbleId,
        role: "ceo",
        content: ""
      }
    ]);

    const eventSource = new EventSource(`${API_BASE}/chat/ceo/stream?message=${encodeURIComponent(trimmed)}`);

    eventSource.addEventListener("token", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { content?: string };
      setMessages((current) =>
        current.map((message) => (message.id === ceoBubbleId ? { ...message, content: payload.content ?? message.content } : message))
      );
    });

    eventSource.addEventListener("proposal", (event) => {
      const card = JSON.parse((event as MessageEvent<string>).data) as CeoCard;
      setMessages((current) =>
        current.map((msg) => (msg.id === ceoBubbleId ? { ...msg, card } : msg))
      );
    });

    eventSource.addEventListener("meeting", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as MeetingEventPayload;
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: `CEO opened a ${payload.type.replace(/_/g, " ")} meeting: ${payload.summary}${payload.taskDeltaCount > 0 ? ` ${payload.taskDeltaCount} task delta${payload.taskDeltaCount === 1 ? " was" : "s were"} recorded.` : ""}`,
        },
      ]);
    });

    eventSource.addEventListener("done", async (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as StreamDonePayload;
      if (payload.snapshot) {
        setSnapshot(payload.snapshot);
      }
      await loadState();
      try {
        const orchRes = await fetch(`${API_BASE}/orchestrator/status`, { cache: "no-store" });
        if (orchRes.ok) {
          const orch = (await orchRes.json()) as { executionStatus: string };
          setExecutionStatus(orch.executionStatus);
        }
      } catch { /* ignore */ }
      setIsStreaming(false);
      eventSource.close();
    });

    eventSource.addEventListener("status", () => {
      return;
    });

    eventSource.onerror = async () => {
      eventSource.close();
      await loadState().catch(() => undefined);
      setIsStreaming(false);
      setMessages((current) =>
        current.map((message) =>
          message.id === ceoBubbleId && !message.content
            ? { ...message, role: "system", content: "The CEO runtime failed before returning a response." }
            : message
        )
      );
    };
  }

  async function handleStrategyAction(messageId: string, card: StrategyProposalCard, execute: boolean) {
    setProposalActionId(messageId);

    try {
      const response = await fetch(`${API_BASE}/strategy/${execute ? "execute" : "approve"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildStrategyPayload(card)),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Strategy action failed.");
      }

      const payload = (await response.json()) as CompanySnapshot | { snapshot: CompanySnapshot; status: string };
      const nextSnapshot = "snapshot" in payload ? payload.snapshot : payload;

      setSnapshot(nextSnapshot);
      setResolvedProposalIds((current) => [...current, messageId]);
      if (execute) {
        setExecutionStatus("planning");
      }

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: execute ? "Board approved the strategy and started execution." : "Board approved the strategy.",
        },
      ]);

      await loadState();
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Strategy action failed.",
        },
      ]);
    } finally {
      setProposalActionId(null);
    }
  }

  function handleQuestionOption(option: string) {
    startTransition(() => {
      void sendMessage(option);
    });
  }

  async function handleQuickExecute() {
    const trimmed = composer.trim();
    if (!trimmed) return;

    setQuickExecuting(true);
    setComposer("");

    setMessages((current) => [
      ...current,
      { id: createId(), role: "board", content: trimmed },
      { id: createId(), role: "system", content: "Quick execute: generating strategy and starting agents…" },
    ]);

    try {
      const response = await fetch(`${API_BASE}/quick-execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: trimmed }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Quick execute failed.");
      }

      const payload = (await response.json()) as { snapshot: CompanySnapshot; status: string };
      setSnapshot(payload.snapshot);
      setExecutionStatus("planning");

      setMessages((current) => [
        ...current,
        { id: createId(), role: "system", content: `Strategy applied. Execution started — CTO is planning, then developer will build in ./workspace/.` },
      ]);

      await loadState();
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: createId(), role: "system", content: error instanceof Error ? error.message : "Quick execute failed." },
      ]);
    } finally {
      setQuickExecuting(false);
    }
  }

  async function openArtifact(artifactId: string) {
    try {
      const response = await fetch(`${API_BASE}/artifacts/${artifactId}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Artifact not found.");
      }

      const artifact = (await response.json()) as Artifact;
      setExpandedArtifact(artifact);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Failed to load artifact.",
        },
      ]);
    }
  }

  async function handleReset() {
    try {
      const response = await fetch(`${API_BASE}/company`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Reset failed with status ${response.status}.`);
      }

      const nextSnapshot = (await response.json()) as CompanySnapshot;
      const preservedMessages = [
        ...messages,
        {
          id: createId(),
          role: "system" as const,
          content: "Company reset complete. CEO chat history was preserved locally.",
        },
      ];
      setSnapshot(nextSnapshot);
      setMessages(preservedMessages);
      setActivityEvents([]);
      setExpandedArtifact(null);
      setProductOverview(emptyProductOverview);
      setExecutionStatus("idle");
      setComposer("");
      setResolvedProposalIds([]);
      setProposalActionId(null);
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(preservedMessages));
      await loadState();
      await loadExecutionTelemetry();
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Reset failed.",
        },
      ]);
    }
  }

  async function handleStopExecution() {
    setStoppingExecution(true);
    try {
      const response = await fetch(`${API_BASE}/orchestrator/stop`, {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Execution stop failed.");
      }

      await loadState();
      await loadExecutionTelemetry();
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: "Board manually stopped the current execution cycle.",
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Execution stop failed.",
        },
      ]);
    } finally {
      setStoppingExecution(false);
    }
  }

  const latestProductFile = productOverview.files[0] ?? null;
  const recentMeetings = snapshot.meetings.slice(0, 1);
  const recentActivityEvents = [...activityEvents].slice(-3).reverse();
  const recentFileEditCount = activityEvents.filter((event) => event.type === "file_edit").length;
  const activeTasks = snapshot.tasks.filter((task) => ["in_progress", "planned", "verifying", "blocked", "created"].includes(task.status)).slice(0, 3);
  const buildTaskWithPreview = snapshot.tasks.find((task) => task.kind === "implementation" && task.localPreviewUrl);
  const queuedFollowUpTasks = snapshot.tasks.filter((task) => task.kind === "follow_up" && ["created", "planned"].includes(task.status));
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");
  const recentResolvedApprovals = snapshot.approvals.filter((approval) => ["approved", "applied", "rejected"].includes(approval.status)).slice(0, 2);
  const employeesWithMemories = snapshot.agents.map((agent) => ({
    agent,
    memory: snapshot.memories.find((memory) => memory.agentId === agent.id) ?? null,
  })).slice(0, 2);

  return (
    <main className="board-shell flex flex-col bg-slate-50">
      <div className="z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:px-8">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <Building2 className="h-4 w-4" />
              Arceus board workspace
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Board
            </Link>
            <Link href="/tasks" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Tasks
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
            <Button variant="outline" size="sm" onClick={() => void handleReset()}>
              Reset
            </Button>
            {!["idle", "done", "error", "paused"].includes(executionStatus) ? (
              <Button variant="outline" size="sm" className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => void handleStopExecution()} disabled={stoppingExecution}>
                {stoppingExecution ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Stop execution
              </Button>
            ) : null}
            <Badge variant={runtime?.chatReady ? "secondary" : "warning"}>{runtime?.chatReady ? "CEO ready" : "CEO needs deployment"}</Badge>
            {executionStatus !== "idle" && (
              <Badge variant={executionStatus === "done" ? "secondary" : executionStatus === "error" ? "destructive" : "outline"}>
                {executionStatus}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="board-grid mx-auto grid w-full max-w-[1600px] flex-1 gap-4 px-4 py-4 md:px-8 lg:grid-cols-[280px_minmax(0,1fr)_280px] xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        <aside className="flex min-h-0 flex-col gap-2.5">
          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Cpu className="h-3.5 w-3.5" />
                Company pulse
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded border border-slate-200 p-2">
                <div className="text-slate-500">Status</div>
                <div className="mt-0.5 font-semibold text-slate-900">{executionStatus}</div>
              </div>
              <div className="rounded border border-slate-200 p-2">
                <div className="text-slate-500">Employees</div>
                <div className="mt-0.5 font-semibold text-slate-900">{snapshot.agents.length}</div>
              </div>
              <div className="rounded border border-slate-200 p-2">
                <div className="text-slate-500">Tasks</div>
                <div className="mt-0.5 font-semibold text-slate-900">{snapshot.tasks.length}</div>
              </div>
              <div className="rounded border border-slate-200 p-2">
                <div className="text-slate-500">Budget</div>
                <div className="mt-0.5 font-semibold text-slate-900">{formatCurrency(snapshot.company.budgetCents)}</div>
              </div>
              <div className="col-span-2 rounded border border-slate-200 p-2 text-slate-700">
                <div className="text-slate-500">Current strategy</div>
                <div className="mt-0.5 line-clamp-2 font-medium text-slate-900">{snapshot.strategy.title}</div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Workspace</CardTitle>
              <CardDescription className="text-xs">Compact workspace summary. Open the dedicated view for full file and edit detail.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-slate-600">
              {productOverview.preview.url ? (
                <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-slate-700">
                  <div className="font-medium text-emerald-800">Preview ready</div>
                  <a className="block truncate underline" href={productOverview.preview.entryUrl ?? productOverview.preview.validationUrl ?? productOverview.preview.url} target="_blank" rel="noreferrer">{productOverview.preview.entryUrl ?? productOverview.preview.validationUrl ?? productOverview.preview.url}</a>
                  {productOverview.preview.url && productOverview.preview.entryUrl && productOverview.preview.entryUrl !== productOverview.preview.url ? (
                    <a className="mt-1 block truncate text-[11px] text-emerald-800 underline" href={productOverview.preview.url} target="_blank" rel="noreferrer">
                      Server root: {productOverview.preview.url}
                    </a>
                  ) : null}
                  {productOverview.preview.validationUrl ? (
                    <div className="mt-1 text-[11px] text-slate-600">
                      Validation: <span className="font-medium text-slate-900">{productOverview.preview.validationStrategy?.replace(/-/g, " ") ?? "root url"}</span> via {productOverview.preview.validationUrl}
                    </div>
                  ) : null}
                  {productOverview.preview.targetKind ? <div className="mt-1 text-[11px] text-slate-600">Target type: {productOverview.preview.targetKind}</div> : null}
                  {productOverview.preview.framework ? <div className="mt-1 text-[11px] text-slate-600">Framework: {productOverview.preview.framework}</div> : null}
                  {productOverview.preview.runtime ? <div className="mt-1 text-[11px] text-slate-600">Runtime: {productOverview.preview.runtime}</div> : null}
                  {productOverview.preview.targetPath ? <div className="mt-1 text-[11px] text-slate-600">Served from: {productOverview.preview.targetPath}</div> : null}
                </div>
              ) : buildTaskWithPreview?.localPreviewUrl ? (
                <div className="rounded border border-blue-200 bg-blue-50 p-2 text-slate-700">
                  <div className="font-medium text-blue-800">Live preview during implementation</div>
                  <a className="block truncate underline" href={buildTaskWithPreview.localPreviewUrl} target="_blank" rel="noreferrer">{buildTaskWithPreview.localPreviewUrl}</a>
                  <div className="mt-1 text-[11px] text-slate-600">The developer has reached a runnable target before final CTO review.</div>
                </div>
              ) : (
                <div className="rounded border border-slate-200 p-2 text-slate-500">No local preview URL yet.</div>
              )}
              <div className="rounded border border-slate-200 p-2">
                <div className="text-slate-500">Latest file change</div>
                <div className="mt-0.5 truncate text-slate-900">{latestProductFile?.path ?? "No workspace file changes yet."}</div>
              </div>
              <div className="flex items-center justify-between rounded border border-slate-200 p-2">
                <span className="text-slate-500">Files in workspace/</span>
                <span className="font-medium text-slate-900">{productOverview.files.length}</span>
              </div>
              <div className="flex items-center justify-between rounded border border-slate-200 p-2">
                <span className="text-slate-500">Live file edits observed</span>
                <span className="font-medium text-slate-900">{recentFileEditCount}</span>
              </div>
              <Link href="/workspace" className="inline-flex text-xs font-medium text-blue-600 hover:text-blue-700">
                Open full workspace view
              </Link>
              {pendingApprovals.length > 0 ? (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-950">
                  <div className="font-medium">Board approval required</div>
                  <div className="mt-1 text-[11px] leading-5">{pendingApprovals[0]?.title}</div>
                  <div className="mt-1 text-[11px] text-amber-800">{pendingApprovals.length} pending request{pendingApprovals.length === 1 ? "" : "s"}</div>
                </div>
              ) : null}
              {executionStatus === "awaiting_board_review" ? (
                <Button className="w-full" size="sm" onClick={() => void handleApproveBoardReview()}>
                  Approve Board Review
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Task flow</CardTitle>
              <CardDescription className="text-xs">Minimal task summary. Full detail is on the tasks page.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {activeTasks.length === 0 ? (
                <p className="text-slate-500">No active tasks yet.</p>
              ) : (
                activeTasks.map((task) => (
                  <div key={task.id} className="rounded border border-slate-200 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-800">{task.title}</div>
                        <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{task.kind.replace(/_/g, " ")} · {task.assignedRole}</div>
                      </div>
                      <Badge variant={taskTone(task.status)} className="text-[10px]">{task.status}</Badge>
                    </div>
                  </div>
                ))
              )}
              <Link href="/tasks" className="inline-flex text-xs font-medium text-blue-600 hover:text-blue-700">
                Open full task board
              </Link>
            </CardContent>
          </Card>
        </aside>

        <section className="min-h-0">
          <Card className="flex h-full min-h-0 flex-col border-slate-200">
            <CardHeader className="shrink-0 space-y-2 pb-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Bot className="h-5 w-5" />
                    CEO workspace
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Start with a message. The CEO will refine it into a strategy and trigger agents.
                  </CardDescription>
                  {runtimeError ? <p className="text-xs text-red-600">{runtimeError}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{snapshot.company.status}</Badge>
                  {snapshot.company.id !== "company_pending" ? <Badge variant="secondary">{snapshot.company.name}</Badge> : null}
                </div>
              </div>
            </CardHeader>

            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
              {executionStatus === "done" ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <div className="font-semibold">Execution cycle complete</div>
                  <div className="mt-1">
                    {queuedFollowUpTasks.length > 0
                      ? `${queuedFollowUpTasks.length} follow-up task${queuedFollowUpTasks.length === 1 ? " is" : "s are"} queued for the next cycle. Review them on the task board or send the CEO the next instruction.`
                      : "The current execution cycle is complete. Review artifacts, inspect the preview, or send the CEO the next instruction."}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link href="/tasks" className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100">
                      Review task board
                    </Link>
                  </div>
                </div>
              ) : null}

              <div className="flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                {messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-slate-500">
                    <Bot className="mb-4 h-8 w-8 text-slate-400" />
                    <p className="max-w-md">Tell the CEO what company to build. The first message initializes the company and triggers strategy generation.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages.map((message) => {
                      if (message.role === "ceo" && message.card) {
                        return (
                          <div key={message.id} className="max-w-[92%] space-y-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900">
                            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em] opacity-70">CEO</div>
                            {message.content ? <p className="whitespace-pre-wrap leading-6 text-slate-600">{message.content}</p> : null}
                            {message.card.card_type === "strategy_proposal" ? (
                              <StrategyProposalEditor
                                card={message.card}
                                busy={proposalActionId === message.id}
                                resolved={resolvedProposalIds.includes(message.id)}
                                onApprove={(card, execute) => handleStrategyAction(message.id, card, execute)}
                              />
                            ) : null}
                            {message.card.card_type === "clarifying_question" ? (
                              <ClarifyingQuestionView
                                card={message.card}
                                disabled={isStreaming}
                                onChoose={handleQuestionOption}
                              />
                            ) : null}
                            {message.card.card_type === "status_update" ? <StatusUpdateView card={message.card} /> : null}
                          </div>
                        );
                      }

                      return (
                        <div
                          key={message.id}
                          className={
                            message.role === "board"
                              ? "ml-auto max-w-[80%] rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white"
                              : message.role === "ceo"
                                ? "max-w-[85%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900"
                                : "max-w-[85%] rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                          }
                        >
                          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em] opacity-70">
                            {message.role === "board" ? "Board" : message.role === "ceo" ? "CEO" : "Runtime"}
                          </div>
                          <p className="whitespace-pre-wrap leading-6">{message.content}</p>
                        </div>
                      );
                    })}
                    <div ref={chatEndRef} />
                  </div>
                )}
              </div>

              <div className="shrink-0 space-y-2">
                <Textarea
                  placeholder="Tell the CEO what company to build…"
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  className="min-h-[80px] resize-none border-slate-200 bg-white"
                  disabled={isStreaming}
                />
                <div className="flex items-center justify-end gap-3">
                  <Button
                    variant="outline"
                    onClick={() => void handleQuickExecute()}
                    disabled={isPending || isStreaming || quickExecuting || !composer.trim()}
                  >
                    {quickExecuting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Quick Execute
                  </Button>
                  <Button onClick={() => startTransition(() => void sendMessage())} disabled={isPending || isStreaming || !composer.trim()}>
                    {isPending || isStreaming ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
                    Send to CEO
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <aside className="flex min-h-0 flex-col gap-2.5">
          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Approvals</CardTitle>
              <CardDescription className="text-xs">Pending and recently resolved governance actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {pendingApprovals.length === 0 && recentResolvedApprovals.length === 0 ? (
                <p className="text-slate-500">No approval requests recorded yet.</p>
              ) : null}
              {pendingApprovals.map((approval: ApprovalItem) => (
                <div key={approval.id} className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-950">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{approval.title}</div>
                    <Badge variant="warning" className="text-[10px]">pending</Badge>
                  </div>
                  <div className="mt-1 text-[11px] leading-5">{approval.description}</div>
                </div>
              ))}
              {recentResolvedApprovals.map((approval: ApprovalItem) => (
                <div key={approval.id} className="rounded border border-slate-200 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-slate-800">{approval.title}</div>
                    <Badge variant="outline" className="text-[10px]">{approval.status}</Badge>
                  </div>
                  {approval.resolutionSummary ? <div className="mt-1 text-[11px] leading-5 text-slate-600">{approval.resolutionSummary}</div> : null}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="h-3.5 w-3.5" />
                Operations snapshot
              </CardTitle>
              <CardDescription className="text-xs">Single-line summaries only. Open linked pages for detail.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {recentActivityEvents.length === 0 ? (
                <p className="text-slate-500">Employee logs will appear here once execution begins.</p>
              ) : (
                recentActivityEvents.map((evt) => {
                  const Icon = TYPE_ICONS[evt.type] ?? Activity;
                  const roleColor = ROLE_COLORS[evt.employee] ?? "text-slate-600";
                  const artifactId = extractArtifactId(evt.content);
                  const artifactLabel = artifactId ? evt.content.replace(/\s*→\s*\/api\/artifacts\/[a-zA-Z0-9_-]+/, "") : evt.content;
                  return (
                    <div key={evt.id} className="rounded border border-slate-200 p-2">
                      <div className="flex items-start gap-2">
                        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${evt.type === "error" ? "text-red-500" : "text-slate-400"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`font-semibold uppercase ${roleColor}`}>{evt.employee}</span>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-400">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <div className={`mt-0.5 truncate ${evt.type === "error" ? "text-red-600" : "text-slate-700"}`}>{artifactLabel}</div>
                          {artifactId ? (
                            <button type="button" className="mt-1 font-medium text-blue-600 hover:text-blue-700" onClick={() => void openArtifact(artifactId)}>
                              View artifact
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <Link href="/activity" className="inline-flex text-xs font-medium text-blue-600 hover:text-blue-700">
                Open full employee log
              </Link>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <CalendarDays className="h-3.5 w-3.5" />
                Meetings
              </CardTitle>
              <CardDescription className="text-xs">Latest meeting only.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-slate-600">
              {recentMeetings.length === 0 ? (
                <p className="text-slate-500">No meetings recorded yet.</p>
              ) : (
                recentMeetings.map((meeting) => (
                  <div key={meeting.id} className="rounded border border-slate-200 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-slate-800">{meeting.type.replace(/_/g, " ")}</div>
                        <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{new Date(meeting.completedAt ?? meeting.scheduledAt).toLocaleTimeString()}</div>
                      </div>
                      <Badge variant="outline" className="text-[10px]">{meeting.participants.length} people</Badge>
                    </div>
                    <div className="mt-1 line-clamp-2 text-slate-600">{meeting.summary}</div>
                  </div>
                ))
              )}
              <Link href="/meetings" className="inline-flex text-xs font-medium text-blue-600 hover:text-blue-700">
                Open meeting timeline
              </Link>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Employee memories</CardTitle>
              <CardDescription className="text-xs">Latest memory snippets only.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-slate-600">
              {employeesWithMemories.length === 0 ? (
                <p className="text-slate-500">No employee memories yet.</p>
              ) : (
                employeesWithMemories.map(({ agent, memory }) => (
                  <div key={agent.id} className="rounded border border-slate-200 p-2">
                    <div className="font-medium text-slate-800">{agent.name} · {agent.title}</div>
                    <div className="mt-1 text-slate-500">Focus</div>
                    <div className="mt-0.5 truncate text-slate-700">{memory?.currentFocus[0] ?? "No current focus yet."}</div>
                    <div className="mt-1 text-slate-500">Latest learning</div>
                    <div className="mt-0.5 truncate text-slate-700">{memory?.recentLearnings[0] ?? "No learnings captured yet."}</div>
                  </div>
                ))
              )}
              <Link href="/employees" className="inline-flex text-xs font-medium text-blue-600 hover:text-blue-700">
                Open employee directory
              </Link>
            </CardContent>
          </Card>

        </aside>
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
