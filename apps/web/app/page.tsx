"use client";

import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Activity, AlertCircle, ArrowUpRight, Bell, Bot, ChevronDown, Cpu, FileCode, Inbox, LoaderCircle, Monitor, Play, Terminal, Users, X, Zap } from "lucide-react";
import type { AgentIdentity, CompanySnapshot, Task } from "@arceus/contracts";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { apiUrl } from "../lib/api";
import { useChatMessages } from "../components/chat-context";

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

type CeoStage = "welcome" | "idea_refinement" | "team_design" | "kickoff" | "execution" | "between_sprints";

type WelcomeBlock = {
  headline: string;
  next_steps: string[];
  suggested_prompts: string[];
};

type MissionBlock = {
  mission_statement: string;
  target_user: string;
  problem: string;
  differentiators: string[];
  assumptions: string[];
  unknowns: string[];
  suggested_replies: string[];
};

type StrategyBlock = {
  first_release: string;
  scope_boundary: string[];
  role_rationale: string[];
  roles: RoleEntry[];
  execution_sequence: string[];
  board_checkpoints: string[];
  key_risks: string[];
};

type QuestionBlock = {
  prompt: string;
  options: string[];
  why_now: string;
};

type StatusBlock = {
  headline: string;
  current_focus: string[];
  blockers: string[];
  next_actions: string[];
  board_requests: string[];
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
  stage: CeoStage;
  title: string;
  summary: string;
  welcome: null;
  mission: null;
  strategy: StrategyBlock;
  question: null;
  status: null;
  meeting: MeetingIntentBlock;
};

type WelcomeBriefCard = {
  card_type: "welcome_brief";
  stage: CeoStage;
  title: string;
  summary: string;
  welcome: WelcomeBlock;
  mission: null;
  strategy: null;
  question: null;
  status: null;
  meeting: MeetingIntentBlock;
};

type MissionBriefCard = {
  card_type: "mission_brief";
  stage: CeoStage;
  title: string;
  summary: string;
  welcome: null;
  mission: MissionBlock;
  strategy: null;
  question: null;
  status: null;
  meeting: MeetingIntentBlock;
};

type ClarifyingQuestionCard = {
  card_type: "clarifying_question";
  stage: CeoStage;
  title: string;
  summary: string;
  welcome: null;
  mission: null;
  strategy: null;
  question: QuestionBlock;
  status: null;
  meeting: MeetingIntentBlock;
};

type StatusUpdateCard = {
  card_type: "status_update";
  stage: CeoStage;
  title: string;
  summary: string;
  welcome: null;
  mission: null;
  strategy: null;
  question: null;
  status: StatusBlock;
  meeting: MeetingIntentBlock;
};

type SprintProposalTask = {
  title: string;
  assigned_role: AgentIdentity["role"];
  priority: "critical" | "high" | "medium" | "low";
  depends_on: string[];
  rationale: string;
};

type SprintProposalBlock = {
  sprint_goal: string;
  key_tasks: SprintProposalTask[];
  carried_forward: string[];
  risks: string[];
  rationale: string;
};

type SprintProposalCard = {
  card_type: "sprint_proposal";
  stage: CeoStage | "between_sprints";
  title: string;
  summary: string;
  welcome: null;
  mission: null;
  strategy: null;
  question: null;
  status: null;
  sprint_proposal: SprintProposalBlock;
  meeting: MeetingIntentBlock;
};

type CeoCard = WelcomeBriefCard | MissionBriefCard | StrategyProposalCard | ClarifyingQuestionCard | StatusUpdateCard | SprintProposalCard;

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

type AgentSession = NonNullable<OrchestratorStatus["agentSessions"]>[string];

const ROLE_COLORS: Record<string, string> = {
  ceo: "text-[var(--swiss-black)]",
  cto: "text-[var(--swiss-blue)]",
  pm: "text-[var(--swiss-black)]",
  developer: "text-[var(--swiss-black)]",
  tester: "text-[var(--swiss-black)]",
  ui_designer: "text-[var(--swiss-black)]",
  marketing: "text-[var(--swiss-black)]",
  skills_lead: "text-[var(--swiss-black)]",
  system: "text-[var(--swiss-gray-400)]",
};

const TYPE_ICONS: Record<string, typeof FileCode> = {
  file_edit: FileCode,
  shell: Terminal,
  working: LoaderCircle,
  error: AlertCircle,
  idle: Activity,
  info: Activity,
};

// Chat storage moved to ChatProvider (components/chat-context.tsx)

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
    currentSprintId: null,
    currentSprintNumber: null,
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
  sprints: [],
  hierarchy: [],
  agents: [],
  sessions: [],
  tasks: [],
  artifacts: [],
  chatMessages: [],
  meetings: [],
  approvals: [],
  memories: [],
  memoryUnits: [],
  habits: [],
  priming: [],
  transitions: [],
  feedbackRounds: []
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

async function fetchJson<T>(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

function describeApiError(error: unknown) {
  if (error instanceof Error) {
    if (error.message === "Failed to fetch") {
      return "Runtime status is temporarily unavailable.";
    }

    return error.message;
  }

  return "Runtime status is temporarily unavailable.";
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

  // Deduplicate roles — classifier can produce duplicates.
  // Keep first occurrence of each role type.
  const seen = new Set<string>();
  const uniqueRoles = card.strategy.roles.filter((r) => {
    if (seen.has(r.role)) return false;
    seen.add(r.role);
    return true;
  });

  // Ensure the 4 core roles exist (ceo, cto, pm, developer).
  // If classifier omitted any, add minimal defaults.
  const coreDefaults: RoleEntry[] = [
    { role: "ceo", title: "Chief Executive Officer", parent_role: null, capabilities: ["Strategic leadership"] },
    { role: "cto", title: "Chief Technology Officer", parent_role: "ceo", capabilities: ["Technical architecture"] },
    { role: "pm", title: "Product Manager", parent_role: "cto", capabilities: ["Product scope and delivery"] },
    { role: "developer", title: "Software Developer", parent_role: "pm", capabilities: ["Implementation"] },
  ];
  for (const def of coreDefaults) {
    if (!uniqueRoles.some((r) => r.role === def.role)) {
      uniqueRoles.push(def);
    }
  }

  return {
    strategy_title: card.title,
    summary: card.summary,
    first_release: card.strategy.first_release,
    scope_boundary: card.strategy.scope_boundary,
    role_rationale: card.strategy.role_rationale,
    roles: uniqueRoles,
  };
}

function toLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stageLabel(stage: CeoStage) {
  return stage.replace(/_/g, " ");
}

function formatRelativeTime(value: string | null) {
  if (!value) {
    return "just now";
  }

  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 0) {
    return "just now";
  }

  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getPreviewHref(productOverview: ProductOverview, buildTaskWithPreview: Task | undefined) {
  return productOverview.preview.entryUrl
    ?? productOverview.preview.validationUrl
    ?? productOverview.preview.url
    ?? buildTaskWithPreview?.localPreviewUrl
    ?? null;
}

function buildReturnSummary({
  executionStatus,
  activeTasks,
  pendingApprovals,
  previewHref,
  latestProductFile,
  developerSession,
  recentMeeting,
}: {
  executionStatus: string;
  activeTasks: Task[];
  pendingApprovals: ApprovalItem[];
  previewHref: string | null;
  latestProductFile: ProductOverview["files"][number] | null;
  developerSession: AgentSession | null;
  recentMeeting: CompanySnapshot["meetings"][number] | null;
}) {
  const bullets: string[] = [];

  if (developerSession?.stallReason) {
    bullets.push(`Developer stall diagnosis: ${developerSession.stallReason}`);
  } else if (developerSession?.lastEventSummary) {
    bullets.push(`Developer last moved ${formatRelativeTime(developerSession.lastEventAt)}: ${developerSession.lastEventSummary}`);
  }

  if (previewHref) {
    bullets.push("A runnable preview is available for the current build.");
  } else if (executionStatus !== "idle") {
    bullets.push("Execution is active, but the product preview is not ready yet.");
  }

  if (activeTasks.length > 0) {
    bullets.push(`${activeTasks.length} task${activeTasks.length === 1 ? " is" : "s are"} in the current operating lane.`);
  }

  if (pendingApprovals.length > 0) {
    bullets.push(`${pendingApprovals.length} board approval request${pendingApprovals.length === 1 ? " is" : "s are"} waiting.`);
  }

  if (latestProductFile?.path) {
    bullets.push(`Latest workspace change: ${latestProductFile.path}`);
  }

  if (recentMeeting) {
    bullets.push(`Last meeting: ${recentMeeting.summary}`);
  }

  if (bullets.length === 0) {
    bullets.push("The company is waiting for its first board directive.");
  }

  const headline = developerSession?.stallReason
    ? "The team needs intervention before momentum returns."
    : previewHref
      ? "The company has moved from planning into something you can inspect live."
      : executionStatus === "done"
        ? "This cycle is complete and ready for the next board decision."
        : executionStatus === "idle"
          ? "The boardroom is ready for a first direction."
          : "The company is actively executing the current plan.";

  return { headline, bullets };
}

function StringList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="border border-[var(--swiss-gray-100)] p-3">
      <div className="swiss-caption text-[var(--swiss-gray-400)]">{title}</div>
      <div className="mt-2 space-y-2 text-[0.8125rem] text-[var(--swiss-black)]">
        {items.map((item, index) => (
          <div key={`${title}-${index}`} className="border-b border-[var(--swiss-gray-100)] pb-2 last:border-0 last:pb-0">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function CardStageHeader({ stage, label }: { stage: CeoStage; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">{label}</Badge>
      <Badge variant="secondary">{stageLabel(stage)}</Badge>
    </div>
  );
}

function RoleEditor({
  role,
  onChange,
}: {
  role: RoleEntry;
  onChange: (next: RoleEntry) => void;
}) {
  return (
    <div className="border border-[var(--swiss-gray-100)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge variant="outline">{role.role}</Badge>
        <span className="swiss-caption text-[var(--swiss-gray-300)]">reports to {role.parent_role ?? "board"}</span>
      </div>
      <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Title</label>
      <input
        className="mb-3 w-full border border-[var(--swiss-gray-200)] px-3 py-2 text-[0.8125rem] outline-none focus:border-[var(--swiss-black)]"
        value={role.title}
        onChange={(event) => onChange({ ...role, title: event.target.value })}
      />
      <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Capabilities</label>
      <Textarea
        value={role.capabilities.join("\n")}
        onChange={(event) => onChange({ ...role, capabilities: toLines(event.target.value) })}
      />
    </div>
  );
}

function MeetingIntentSummary({ meeting }: { meeting: MeetingIntentBlock }) {
  if (!meeting.create) return null;

  return (
    <div className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{meeting.type?.replace(/_/g, " ") ?? "meeting"}</Badge>
        <Badge variant="outline">{meeting.task_deltas.length} task delta{meeting.task_deltas.length === 1 ? "" : "s"}</Badge>
      </div>
      <div className="mt-2 text-[0.8125rem] font-medium text-[var(--swiss-black)]">{meeting.summary}</div>
      <div className="mt-1 text-[0.8125rem] text-[var(--swiss-gray-500)]">{meeting.rationale}</div>
      {meeting.task_deltas.length > 0 ? (
        <div className="mt-3 space-y-2">
          {meeting.task_deltas.map((delta, index) => (
            <div key={`${delta.title}-${index}`} className="border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)] px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{delta.action}</Badge>
                <Badge variant="outline">{delta.assigned_role}</Badge>
                <Badge variant="outline">{delta.priority}</Badge>
              </div>
              <div className="mt-2 font-medium text-[var(--swiss-black)]">{delta.title}</div>
              <div className="mt-1 leading-5 text-[var(--swiss-gray-500)]">{delta.details}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WelcomeBriefView({ card, disabled, onChoose }: { card: WelcomeBriefCard; disabled: boolean; onChoose: (option: string) => void }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{card.title}</CardTitle>
            <CardDescription>The CEO is framing the first boardroom move.</CardDescription>
          </div>
          <CardStageHeader stage={card.stage} label="Launch brief" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border-l-2 border-[var(--swiss-black)] pl-3 text-[0.8125rem] text-[var(--swiss-gray-500)]">{card.welcome.headline}</div>
        <StringList title="Next steps" items={card.welcome.next_steps} />
        <div>
          <div className="swiss-caption mb-2 text-[var(--swiss-gray-400)]">Suggested prompts</div>
          <div className="flex flex-wrap gap-2">
            {card.welcome.suggested_prompts.map((prompt) => (
              <Button key={prompt} variant="outline" size="sm" disabled={disabled} onClick={() => onChoose(prompt)}>
                {prompt}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MissionBriefView({ card, disabled, onChoose }: { card: MissionBriefCard; disabled: boolean; onChoose: (option: string) => void }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{card.title}</CardTitle>
            <CardDescription>The CEO is tightening the mission before team and sprint kickoff.</CardDescription>
          </div>
          <CardStageHeader stage={card.stage} label="Mission brief" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3">
          <div className="border border-[var(--swiss-gray-100)] p-3">
            <div className="swiss-caption text-[var(--swiss-gray-400)]">Mission</div>
            <div className="mt-2 text-[0.8125rem] leading-6">{card.mission.mission_statement}</div>
          </div>
          <div className="border border-[var(--swiss-gray-100)] p-3">
            <div className="swiss-caption text-[var(--swiss-gray-400)]">Target user</div>
            <div className="mt-2 text-[0.8125rem] leading-6">{card.mission.target_user}</div>
          </div>
          <div className="border border-[var(--swiss-gray-100)] p-3">
            <div className="swiss-caption text-[var(--swiss-gray-400)]">Problem</div>
            <div className="mt-2 text-[0.8125rem] leading-6">{card.mission.problem}</div>
          </div>
        </div>
        <StringList title="Differentiators" items={card.mission.differentiators} />
        <div className="grid gap-3">
          <StringList title="Assumptions" items={card.mission.assumptions} />
          <StringList title="Unknowns" items={card.mission.unknowns} />
        </div>
        <div>
          <div className="swiss-caption mb-2 text-[var(--swiss-gray-400)]">Board replies</div>
          <div className="flex flex-wrap gap-2">
            {card.mission.suggested_replies.map((reply) => (
              <Button key={reply} variant="outline" size="sm" disabled={disabled} onClick={() => onChoose(reply)}>
                {reply}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
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
      <Card className="border-[var(--swiss-red)]">
        <CardContent className="pt-5 text-[0.8125rem] text-[var(--swiss-red)]">The strategy proposal card is missing structured strategy data.</CardContent>
      </Card>
    );
  }

  const [draft, setDraft] = useState<StrategyProposalCard>(card);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{draft.title}</CardTitle>
            <CardDescription>Editable strategy proposal selected by the CEO card classifier.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <CardStageHeader stage={draft.stage} label={resolved ? "Approved" : "Needs board action"} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        <div>
          <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Strategy Title</label>
          <input
            className="w-full border border-[var(--swiss-gray-200)] px-3 py-2 text-[0.8125rem] outline-none focus:border-[var(--swiss-black)]"
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            disabled={resolved}
          />
        </div>

        <div>
          <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Summary</label>
          <Textarea
            value={draft.summary}
            onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
            disabled={resolved}
          />
        </div>

        <div>
          <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">First Release</label>
          <Textarea
            className="min-h-[70px]"
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

        <div className="grid gap-4">
          <div>
            <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Scope Boundary</label>
            <Textarea
              className="min-h-[120px]"
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
            <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Role Rationale</label>
            <Textarea
              className="min-h-[120px]"
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

        <div className="grid gap-4">
          <div>
            <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Execution Sequence</label>
            <Textarea
              className="min-h-[120px]"
              value={draft.strategy.execution_sequence.join("\n")}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  strategy: { ...current.strategy, execution_sequence: toLines(event.target.value) },
                }))
              }
              disabled={resolved}
            />
          </div>
          <div>
            <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Board Checkpoints</label>
            <Textarea
              className="min-h-[120px]"
              value={draft.strategy.board_checkpoints.join("\n")}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  strategy: { ...current.strategy, board_checkpoints: toLines(event.target.value) },
                }))
              }
              disabled={resolved}
            />
          </div>
          <div>
            <label className="swiss-caption mb-1 block text-[var(--swiss-gray-400)]">Key Risks</label>
            <Textarea
              className="min-h-[120px]"
              value={draft.strategy.key_risks.join("\n")}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  strategy: { ...current.strategy, key_risks: toLines(event.target.value) },
                }))
              }
              disabled={resolved}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="swiss-caption text-[var(--swiss-gray-400)]">Team Structure</div>
          <div className="grid gap-3">
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
          <Button disabled={busy || resolved} onClick={() => void onApprove(draft, true)}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {resolved ? "Approved" : "Approve & Execute"}
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
      <Card className="border-[var(--swiss-red)]">
        <CardContent className="pt-5 text-[0.8125rem] text-[var(--swiss-red)]">The clarifying question card is missing question data.</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{card.title}</CardTitle>
            <CardDescription>The CEO is asking the board to narrow the problem.</CardDescription>
          </div>
          <CardStageHeader stage={card.stage} label="Clarifying question" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)]">{card.question.prompt}</p>
        <div className="border-l-2 border-[var(--swiss-black)] pl-3 text-[0.8125rem] text-[var(--swiss-gray-500)]">{card.question.why_now}</div>
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

function StatusUpdateView({ card, disabled, onChoose }: { card: StatusUpdateCard; disabled: boolean; onChoose: (option: string) => void }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{card.title}</CardTitle>
          <CardStageHeader stage={card.stage} label="Operating update" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <MeetingIntentSummary meeting={card.meeting} />
        <p className="text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)]">{card.summary}</p>
        {card.status ? (
          <>
            <div className="border border-[var(--swiss-gray-100)] p-3 text-[0.8125rem] font-medium">{card.status.headline}</div>
            <div className="grid gap-3">
              <StringList title="Current focus" items={card.status.current_focus} />
              <StringList title="Blockers" items={card.status.blockers} />
              <StringList title="Next actions" items={card.status.next_actions} />
            </div>
            {card.status.board_requests.length > 0 ? (
              <div>
                <div className="swiss-caption mb-2 text-[var(--swiss-gray-400)]">Board requests</div>
                <div className="flex flex-wrap gap-2">
                  {card.status.board_requests.map((request) => (
                    <Button key={request} variant="outline" size="sm" disabled={disabled} onClick={() => onChoose(request)}>
                      {request}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

const priorityColor: Record<string, string> = {
  critical: "text-[var(--swiss-red)]",
  high: "text-orange-600",
  medium: "text-[var(--swiss-gray-500)]",
  low: "text-[var(--swiss-gray-300)]",
};

function SprintProposalView({
  card,
  busy,
  resolved,
  onApprove,
}: {
  card: SprintProposalCard;
  busy: boolean;
  resolved: boolean;
  onApprove: (card: SprintProposalCard) => Promise<void>;
}) {
  const sp = card.sprint_proposal;
  if (!sp) {
    return (
      <Card className="border-[var(--swiss-red)]">
        <CardContent className="pt-5 text-[0.8125rem] text-[var(--swiss-red)]">Sprint proposal card is missing structured data.</CardContent>
      </Card>
    );
  }

  const [draft, setDraft] = useState(sp);

  function updateTask(index: number, field: keyof SprintProposalTask, value: string) {
    setDraft((current) => ({
      ...current,
      key_tasks: current.key_tasks.map((t, i) =>
        i === index ? { ...t, [field]: field === "depends_on" ? value.split(",").map((s) => s.trim()).filter(Boolean) : value } : t
      ),
    }));
  }

  function removeTask(index: number) {
    setDraft((current) => ({
      ...current,
      key_tasks: current.key_tasks.filter((_, i) => i !== index),
    }));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{card.title}</CardTitle>
            <CardDescription>CEO sprint proposal for board review.</CardDescription>
          </div>
          <CardStageHeader stage={card.stage} label={resolved ? "Approved" : "Sprint proposal"} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)]">{card.summary}</p>

        <div className="border border-[var(--swiss-gray-100)] p-3">
          <div className="swiss-caption text-[var(--swiss-gray-400)]">Sprint Goal</div>
          <div className="mt-1 text-[0.8125rem] font-medium">{draft.sprint_goal}</div>
        </div>

        <div>
          <div className="swiss-caption mb-2 text-[var(--swiss-gray-400)]">Key Tasks ({draft.key_tasks.length})</div>
          <div className="space-y-2">
            {draft.key_tasks.map((task, index) => (
              <div key={`${task.title}-${index}`} className="border border-[var(--swiss-gray-100)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <input
                      className="w-full border-none bg-transparent text-[0.8125rem] font-semibold outline-none"
                      value={task.title}
                      onChange={(e) => updateTask(index, "title", e.target.value)}
                      disabled={resolved}
                    />
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="outline">{task.assigned_role}</Badge>
                      <span className={`text-xs font-medium ${priorityColor[task.priority] ?? ""}`}>{task.priority}</span>
                      {task.depends_on.length > 0 ? (
                        <span className="text-xs text-[var(--swiss-gray-300)]">depends on: {task.depends_on.join(", ")}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-[var(--swiss-gray-400)]">{task.rationale}</div>
                  </div>
                  {!resolved ? (
                    <button type="button" onClick={() => removeTask(index)} className="text-[var(--swiss-gray-300)] hover:text-[var(--swiss-red)]">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        {draft.risks.length > 0 ? <StringList title="Risks" items={draft.risks} /> : null}
        {draft.carried_forward.length > 0 ? <StringList title="Carried forward" items={draft.carried_forward} /> : null}
        {draft.rationale ? (
          <div>
            <div className="swiss-caption mb-1 text-[var(--swiss-gray-400)]">Rationale</div>
            <p className="text-[0.8125rem] text-[var(--swiss-gray-500)]">{draft.rationale}</p>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            disabled={busy || resolved || draft.key_tasks.length === 0}
            onClick={() => void onApprove({ ...card, sprint_proposal: draft })}
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {resolved ? "Sprint Started" : "Approve & Start Sprint"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LaunchBoardPanel({ disabled, onPrompt }: { disabled: boolean; onPrompt: (prompt: string) => void }) {
  const prompts = [
    "Build a consumer app that helps parents coordinate school schedules and family logistics.",
    "Create an internal SaaS tool that helps support teams summarize customer issues and draft replies.",
    "I want a lightweight B2B product for finance teams to track renewal risk and upsell timing.",
    "Help me turn an idea for a note-taking product into a focused first release and team plan.",
  ];

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-4 text-left">
      <div className="border border-[var(--swiss-gray-100)] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="swiss-caption text-[var(--swiss-gray-400)]">CEO launch room</div>
            <div className="swiss-h1 mt-3">Start with a product direction.</div>
            <div className="mt-2 text-[0.8125rem] leading-6 text-[var(--swiss-gray-400)]">
              This boardroom is built for staged decisions: idea framing, mission pressure-testing, org design, kickoff, and execution updates.
            </div>
          </div>
        </div>
        <hr className="swiss-rule my-5" />
        <div className="grid gap-3 md:grid-cols-2">
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="border border-[var(--swiss-gray-200)] p-4 text-left text-[0.8125rem] leading-6 text-[var(--swiss-gray-500)] transition hover:border-[var(--swiss-black)] hover:text-[var(--swiss-black)] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
              onClick={() => onPrompt(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  const [snapshot, setSnapshot] = useState<CompanySnapshot>(emptySnapshot);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [composer, setComposer] = useState("");
  const { messages: rawMessages, setMessages: setRawMessages, resolvedProposalIds, setResolvedProposalIds, clearMessages } = useChatMessages();
  const messages = rawMessages as ChatBubble[];
  const setMessages = setRawMessages as React.Dispatch<React.SetStateAction<ChatBubble[]>>;
  const [isPending, startTransition] = useTransition();
  const [isStreaming, setIsStreaming] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<EmployeeActivityEvent[]>([]);
  const [executionStatus, setExecutionStatus] = useState<string>("idle");
  const [orchestratorStatus, setOrchestratorStatus] = useState<OrchestratorStatus | null>(null);
  const [proposalActionId, setProposalActionId] = useState<string | null>(null);
  const [quickExecuting, setQuickExecuting] = useState(false);
  const [stoppingExecution, setStoppingExecution] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [expandedArtifact, setExpandedArtifact] = useState<Artifact | null>(null);
  const [productOverview, setProductOverview] = useState<ProductOverview>(emptyProductOverview);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [sprintOpen, setSprintOpen] = useState(false);

  async function loadState(options?: { suppressRuntimeError?: boolean }) {
    const [companyResult, runtimeResult] = await Promise.allSettled([
      fetchJson<CompanySnapshot>(apiUrl("/company")),
      fetchJson<RuntimeStatus>(apiUrl("/runtime")),
    ]);

    if (companyResult.status === "fulfilled") {
      setSnapshot(companyResult.value);
    }

    if (runtimeResult.status === "fulfilled") {
      setRuntime(runtimeResult.value);
    }

    if (runtimeResult.status === "fulfilled") {
      setRuntimeError(null);
      return;
    }

    if (options?.suppressRuntimeError) {
      return;
    }

    if (companyResult.status === "fulfilled") {
      setRuntimeError("Runtime status is temporarily unavailable.");
      return;
    }

    setRuntimeError(describeApiError(runtimeResult.reason));
  }

  async function loadExecutionTelemetry() {
    try {
      const [activityResponse, orchestratorResponse, companyResponse, productResponse] = await Promise.all([
        fetch(apiUrl("/employee-activity"), { cache: "no-store" }),
        fetch(apiUrl("/orchestrator/status"), { cache: "no-store" }),
        fetch(apiUrl("/company"), { cache: "no-store" }),
        fetch(apiUrl("/product/overview"), { cache: "no-store" }),
      ]);

      if (activityResponse.ok) {
        setActivityEvents((await activityResponse.json()) as EmployeeActivityEvent[]);
      }

      if (orchestratorResponse.ok) {
        const orchestrator = (await orchestratorResponse.json()) as OrchestratorStatus;
        setOrchestratorStatus(orchestrator);
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

  // Chat persistence is handled by ChatProvider in layout.tsx.
  // No hydrate/persist effects needed here — state survives navigation.

  async function handleApproveBoardReview() {
    try {
      const response = await fetch(apiUrl("/board-review/approve"), {
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
    const es = new EventSource(apiUrl("/employee-activity/stream"));

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
    }, isStreaming || executionStatus !== "idle" || isResetting ? 1500 : 4000);

    return () => clearInterval(interval);
  }, [isStreaming, executionStatus, isResetting]);

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

    const eventSource = new EventSource(`${apiUrl("/chat/ceo/stream")}?message=${encodeURIComponent(trimmed)}`);

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
        const orchRes = await fetch(apiUrl("/orchestrator/status"), { cache: "no-store" });
        if (orchRes.ok) {
          const orch = (await orchRes.json()) as OrchestratorStatus;
          setOrchestratorStatus(orch);
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
      const response = await fetch(apiUrl(`/strategy/${execute ? "execute" : "approve"}`), {
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

      const teamSummary = nextSnapshot.agents.length > 0
        ? `\n\nTeam hired (${nextSnapshot.agents.length}):\n${nextSnapshot.agents.map((a: { role: string; title: string; name: string }) => `- ${a.name} — ${a.title} (${a.role})`).join("\n")}`
        : "";

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: execute
            ? `Board approved the strategy and started execution.${teamSummary}\n\nCTO is planning tasks. Watch the Execution tab for progress.`
            : `Board approved the strategy.${teamSummary}\n\nThe team is ready. Type a message to start execution.`,
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

  async function handleSprintApproval(messageId: string, card: SprintProposalCard) {
    setProposalActionId(messageId);

    try {
      const sp = card.sprint_proposal;
      const response = await fetch(apiUrl("/sprint/approve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: card.title,
          goal: sp.sprint_goal,
          key_tasks: sp.key_tasks,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Sprint approval failed.");
      }

      const payload = (await response.json()) as { sprint: { number: number; title: string }; executionStatus: string; tasks: unknown[] };

      setResolvedProposalIds((current) => [...current, messageId]);
      setExecutionStatus(payload.executionStatus);

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: `Sprint ${payload.sprint.number} started: ${payload.sprint.title}\n${payload.tasks.length} tasks dispatched. Watch the Execution tab for progress.`,
        },
      ]);

      await loadState();
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Sprint approval failed.",
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
      const response = await fetch(apiUrl("/quick-execute"), {
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
      const response = await fetch(apiUrl(`/artifacts/${artifactId}`), { cache: "no-store" });
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
    setIsResetting(true);
    setRuntimeError(null);

    try {
      const response = await fetch(apiUrl("/company"), {
        method: "DELETE",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Reset failed with status ${response.status}.`);
      }

      const nextSnapshot = (await response.json()) as CompanySnapshot;
      setSnapshot(nextSnapshot);
      clearMessages();
      setActivityEvents([]);
      setExpandedArtifact(null);
      setProductOverview(emptyProductOverview);
      setExecutionStatus("idle");
      setComposer("");
      setProposalActionId(null);
      setRuntimeError(null);
      // localStorage persistence handled by ChatProvider automatically
      await loadExecutionTelemetry();
      window.setTimeout(() => {
        void loadState({ suppressRuntimeError: true });
      }, 250);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          content: error instanceof Error ? error.message : "Reset failed.",
        },
      ]);
    } finally {
      setIsResetting(false);
    }
  }

  async function handleStopExecution() {
    setStoppingExecution(true);
    try {
      const response = await fetch(apiUrl("/orchestrator/stop"), {
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

  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");

  // ── Computed values for the living dashboard ──────────
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  const sprintTasks = currentSprint
    ? snapshot.tasks.filter((t) => t.sprintId === currentSprint.id)
    : snapshot.tasks;
  const completedTaskCount = sprintTasks.filter((t) => t.status === "completed").length;
  const totalTaskCount = sprintTasks.length;

  const buildTaskWithPreview = snapshot.tasks.find((t) => !!t.localPreviewUrl);
  const previewHref = getPreviewHref(productOverview, buildTaskWithPreview);
  const previewStatus = productOverview.preview.status;

  const agentSessionEntries = orchestratorStatus?.agentSessions
    ? Object.entries(orchestratorStatus.agentSessions)
    : [];
  const activeAgentCount = agentSessionEntries.filter(([, s]) => s.status === "working").length;
  const developerSession = agentSessionEntries.find(([, s]) => s.role === "developer")?.[1] ?? null;
  const latestProductFile = productOverview.files.length > 0 ? productOverview.files[productOverview.files.length - 1] : null;
  const recentMeeting = snapshot.meetings.length > 0 ? snapshot.meetings[snapshot.meetings.length - 1] : null;

  const activeTasks = snapshot.tasks.filter((t) => ["in_progress", "verifying", "planned"].includes(t.status));
  const returnSummary = buildReturnSummary({
    executionStatus,
    activeTasks,
    pendingApprovals,
    previewHref,
    latestProductFile,
    developerSession,
    recentMeeting,
  });

  const showCompanyView = executionStatus !== "idle" || snapshot.tasks.length > 0 || snapshot.sprints.length > 0 || previewStatus !== "idle";

  // ── Inbox items ────────────────────────────────────────
  type InboxItem = {
    id: string;
    kind: "approval" | "error" | "completed" | "stall" | "meeting" | "info";
    title: string;
    detail: string;
    time: string;
    actionLabel?: string;
    onAction?: () => void;
    href?: string;
  };

  const inboxItems: InboxItem[] = [];

  // Pending approvals
  for (const approval of pendingApprovals) {
    inboxItems.push({
      id: `approval-${approval.id}`,
      kind: "approval",
      title: approval.title,
      detail: approval.description || "Needs board decision",
      time: "",
      actionLabel: executionStatus === "awaiting_board_review" ? "Approve" : undefined,
      onAction: executionStatus === "awaiting_board_review" ? () => void handleApproveBoardReview() : undefined,
    });
  }

  // Agent stalls
  for (const [, sess] of agentSessionEntries) {
    if (sess.stallReason) {
      inboxItems.push({
        id: `stall-${sess.agentId}`,
        kind: "stall",
        title: `${sess.name || sess.role} is stalled`,
        detail: sess.stallReason,
        time: sess.lastEventAt ? formatRelativeTime(sess.lastEventAt) : "",
        href: "/employees",
      });
    }
  }

  // Recent errors from activity (last 5)
  const recentErrors = activityEvents
    .filter((e) => e.type === "error")
    .slice(-5)
    .reverse();
  for (const ev of recentErrors) {
    inboxItems.push({
      id: `error-${ev.id}`,
      kind: "error",
      title: `Error from ${ev.employee}`,
      detail: ev.content.slice(0, 120),
      time: formatRelativeTime(ev.timestamp),
      href: "/activity",
    });
  }

  // Recently completed tasks (last 3)
  const recentlyCompleted = snapshot.tasks
    .filter((t) => t.status === "completed" && t.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
    .slice(0, 3);
  for (const task of recentlyCompleted) {
    inboxItems.push({
      id: `done-${task.id}`,
      kind: "completed",
      title: task.title,
      detail: `Completed by ${task.assignedRole}`,
      time: task.completedAt ? formatRelativeTime(task.completedAt) : "",
      href: "/tasks",
    });
  }

  // Recent meetings (last 2)
  const recentMeetings = snapshot.meetings.slice(-2).reverse();
  for (const mtg of recentMeetings) {
    inboxItems.push({
      id: `mtg-${mtg.id}`,
      kind: "meeting",
      title: `${mtg.type.replace(/_/g, " ")} meeting`,
      detail: mtg.summary.slice(0, 100),
      time: formatRelativeTime(mtg.scheduledAt),
      href: "/meetings",
    });
  }

  // Execution done notice
  if (executionStatus === "done") {
    inboxItems.push({
      id: "exec-done",
      kind: "info",
      title: "Execution cycle complete",
      detail: "Review the preview or give the CEO the next instruction.",
      time: "",
    });
  }

  const inboxCount = inboxItems.length;

  const inboxKindIcon = (kind: InboxItem["kind"]) => {
    switch (kind) {
      case "approval": return <AlertCircle className="h-3.5 w-3.5 text-[var(--swiss-red)]" />;
      case "error": return <AlertCircle className="h-3.5 w-3.5 text-[var(--swiss-red)]" />;
      case "stall": return <AlertCircle className="h-3.5 w-3.5 text-[var(--arc-warning)]" />;
      case "completed": return <Activity className="h-3.5 w-3.5 text-[var(--arc-success)]" />;
      case "meeting": return <Users className="h-3.5 w-3.5 text-[var(--swiss-blue)]" />;
      case "info": return <Cpu className="h-3.5 w-3.5 text-[var(--swiss-gray-400)]" />;
    }
  };

  const getAgentName = (task: Task) => {
    const agent = snapshot.agents.find((a) => a.role === task.assignedRole);
    return agent?.name ?? task.assignedRole;
  };

  const getTaskStatusIcon = (status: Task["status"]) => {
    switch (status) {
      case "completed": return "✓";
      case "in_progress": return "●";
      case "verifying": return "◐";
      case "planned": return "○";
      case "created": return "○";
      case "blocked": return "✗";
      case "failed": return "✗";
      case "cancelled": return "—";
      default: return "○";
    }
  };

  const getTaskStatusColor = (status: Task["status"]) => {
    switch (status) {
      case "completed": return "text-[var(--arc-success)]";
      case "in_progress": return "text-[var(--swiss-blue)]";
      case "verifying": return "text-[var(--arc-warning)]";
      case "failed":
      case "blocked": return "text-[var(--swiss-red)]";
      default: return "text-[var(--swiss-gray-400)]";
    }
  };

  const getAgentStatusColor = (status?: string) => {
    switch (status) {
      case "working": return "bg-[var(--arc-success)]";
      case "done": return "bg-[var(--swiss-blue)]";
      case "error": return "bg-[var(--swiss-red)]";
      default: return "bg-[var(--swiss-gray-300)]";
    }
  };

  return (
    <div className="flex h-screen flex-col">
      {/* ── Top bar ─────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-5">
        <div className="flex items-center gap-3">
          <span className="text-[0.8125rem] font-bold tracking-tight">
            {snapshot.company.id === "company_pending" ? "Arceus" : snapshot.company.name}
          </span>
          <span className="mx-1 h-4 w-px bg-[var(--swiss-gray-200)]" />
          <nav className="flex items-center gap-1">
            {[
              { href: "/tasks", label: "Tasks" },
              { href: "/employees", label: "Team" },
              { href: "/meetings", label: "Meetings" },
              { href: "/activity", label: "Activity" },
              { href: "/workspace", label: "Workspace" },
              { href: "/preview", label: "Preview" },
              { href: "/execution", label: "Execution" },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-2 py-1 text-[0.6875rem] text-[var(--swiss-gray-400)] transition hover:bg-[var(--swiss-gray-100)] hover:text-[var(--swiss-black)]"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="mx-1 h-4 w-px bg-[var(--swiss-gray-200)]" />
          {currentSprint ? (
            <Badge
              variant={currentSprint.status === "completed" ? "secondary" : "outline"}
              className="text-[0.625rem]"
            >
              Sprint {currentSprint.number} · {currentSprint.status === "completed" ? "Done" : currentSprint.status === "executing" ? "Executing" : "Planning"}
            </Badge>
          ) : null}
          <Badge
            variant={executionStatus === "done" ? "secondary" : executionStatus === "error" ? "destructive" : "outline"}
            className="text-[0.625rem]"
          >
            {executionStatus}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={runtime?.chatReady ? "outline" : "warning"} className="text-[0.625rem]">
            {runtime?.chatReady ? "CEO ready" : "CEO needs config"}
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => void handleReset()} disabled={isResetting}>
            {isResetting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            Reset
          </Button>
          {!["idle", "done", "error", "paused"].includes(executionStatus) ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-[var(--swiss-red)]"
              onClick={() => void handleStopExecution()}
              disabled={stoppingExecution}
            >
              {stoppingExecution ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Stop
            </Button>
          ) : null}
        </div>
      </header>

      {/* ── Main area ───────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* ── CEO Chat Panel (left) ─────────────────────── */}
        <div
          className={`flex flex-col border-r border-[var(--swiss-gray-100)] ${
            showCompanyView ? "w-[560px] shrink-0" : "flex-1"
          }`}
        >
          {runtimeError && !isResetting ? (
            <div className="shrink-0 border-b border-[var(--swiss-red)]/20 bg-[var(--swiss-red)]/5 px-5 py-2">
              <p className="text-[0.75rem] text-[var(--swiss-red)]">{runtimeError}</p>
            </div>
          ) : null}

          {/* Chat messages (scrollable) */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <LaunchBoardPanel disabled={isStreaming} onPrompt={(prompt) => void sendMessage(prompt)} />
            ) : (
              <div className="space-y-3">
                {messages.map((message) => {
                  if (message.role === "ceo" && message.card) {
                    return (
                      <div key={message.id} className="space-y-2 rounded-lg border border-[var(--swiss-gray-100)] px-4 py-3 text-[0.8125rem]">
                        <div className="swiss-caption opacity-70">CEO</div>
                        {message.content ? <p className="whitespace-pre-wrap leading-6 text-[var(--swiss-gray-400)]">{message.content}</p> : null}
                        {message.card.card_type === "welcome_brief" ? <WelcomeBriefView card={message.card} disabled={isStreaming} onChoose={handleQuestionOption} /> : null}
                        {message.card.card_type === "mission_brief" ? <MissionBriefView card={message.card} disabled={isStreaming} onChoose={handleQuestionOption} /> : null}
                        {message.card.card_type === "strategy_proposal" ? (
                          <StrategyProposalEditor
                            card={message.card}
                            busy={proposalActionId === message.id}
                            resolved={resolvedProposalIds.includes(message.id)}
                            onApprove={(card, execute) => handleStrategyAction(message.id, card, execute)}
                          />
                        ) : null}
                        {message.card.card_type === "clarifying_question" ? <ClarifyingQuestionView card={message.card} disabled={isStreaming} onChoose={handleQuestionOption} /> : null}
                        {message.card.card_type === "status_update" ? <StatusUpdateView card={message.card} disabled={isStreaming} onChoose={handleQuestionOption} /> : null}
                        {message.card.card_type === "sprint_proposal" ? (
                          <SprintProposalView
                            card={message.card}
                            busy={proposalActionId === message.id}
                            resolved={resolvedProposalIds.includes(message.id)}
                            onApprove={(card) => handleSprintApproval(message.id, card)}
                          />
                        ) : null}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={message.id}
                      className={
                        message.role === "board"
                          ? "ml-auto max-w-[85%] rounded-lg border border-[var(--swiss-gray-200)] bg-[var(--swiss-gray-50)] px-4 py-3 text-[0.8125rem]"
                          : message.role === "ceo"
                            ? "max-w-[90%] rounded-lg border border-[var(--swiss-gray-100)] px-4 py-3 text-[0.8125rem]"
                            : "max-w-[90%] rounded-lg border-l-2 border-[var(--swiss-gray-200)] py-2 pl-3 text-[0.8125rem] text-[var(--swiss-gray-400)]"
                      }
                    >
                      <div className="swiss-caption mb-1 opacity-70">
                        {message.role === "board" ? "Board" : message.role === "ceo" ? "CEO" : "System"}
                      </div>
                      <p className="whitespace-pre-wrap leading-6">{message.content}</p>
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          {/* Composer (pinned to bottom) */}
          <div className="shrink-0 border-t border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] p-4">
            <Textarea
              placeholder="Tell the CEO what to build or what should happen next…"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              className="min-h-[72px] resize-none rounded-lg bg-[var(--swiss-white)] text-[0.8125rem]"
              disabled={isStreaming}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (composer.trim() && !isPending && !isStreaming) {
                    startTransition(() => void sendMessage());
                  }
                }
              }}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleQuickExecute()}
                disabled={isPending || isStreaming || quickExecuting || !composer.trim()}
              >
                {quickExecuting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Quick Execute
              </Button>
              <Button
                size="sm"
                onClick={() => startTransition(() => void sendMessage())}
                disabled={isPending || isStreaming || !composer.trim()}
              >
                {isPending || isStreaming ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                Send
              </Button>
            </div>
          </div>
        </div>

        {/* ── Company View (right) ──────────────────────── */}
        {showCompanyView ? (
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            <div className="flex-1 space-y-5 p-6">
              {/* ── Inbox ────────────────────────────────── */}
              {inboxCount > 0 ? (
                <section className="rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)]">
                  <button
                    className="flex w-full items-center justify-between px-5 py-3 text-left"
                    onClick={() => setInboxOpen((prev) => !prev)}
                  >
                    <div className="flex items-center gap-2">
                      <Inbox className="h-4 w-4 text-[var(--swiss-gray-400)]" />
                      <span className="text-[0.8125rem] font-semibold">Inbox</span>
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--swiss-blue)] px-1.5 text-[0.625rem] font-semibold text-white">
                        {inboxCount}
                      </span>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 text-[var(--swiss-gray-400)] transition-transform ${inboxOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {inboxOpen ? (
                    <div className="border-t border-[var(--swiss-gray-100)]">
                      {inboxItems.map((item, idx) => {
                        const inner = (
                          <>
                            <span className="shrink-0">{inboxKindIcon(item.kind)}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[0.8125rem] font-medium">{item.title}</span>
                                {item.time ? (
                                  <span className="shrink-0 text-[0.625rem] text-[var(--swiss-gray-300)]">{item.time}</span>
                                ) : null}
                              </div>
                              <div className="mt-0.5 truncate text-[0.75rem] leading-relaxed text-[var(--swiss-gray-400)]">
                                {item.detail}
                              </div>
                            </div>
                            {item.actionLabel && item.onAction ? (
                              <Button
                                size="sm"
                                className="shrink-0"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); item.onAction!(); }}
                              >
                                {item.actionLabel}
                              </Button>
                            ) : null}
                          </>
                        );

                        const cls = `flex items-start gap-3 px-5 py-3 transition hover:bg-[var(--swiss-gray-50)] ${idx < inboxItems.length - 1 ? "border-b border-[var(--swiss-gray-100)]" : ""}`;

                        return item.href ? (
                          <Link key={item.id} href={item.href} className={cls}>{inner}</Link>
                        ) : (
                          <div key={item.id} className={cls}>{inner}</div>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* ── Product Preview (hero) ───────────────── */}
              <section className="overflow-hidden rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)]">
                <div className="flex items-center justify-between border-b border-[var(--swiss-gray-100)] px-5 py-3">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-[var(--swiss-gray-400)]" />
                    <span className="text-[0.8125rem] font-semibold">Product Preview</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {productOverview.preview.framework ? (
                      <Badge variant="outline" className="text-[0.625rem]">{productOverview.preview.framework}</Badge>
                    ) : null}
                    <Badge
                      variant={previewStatus === "ready" ? "secondary" : previewStatus === "error" ? "destructive" : "outline"}
                      className="text-[0.625rem]"
                    >
                      {previewStatus === "ready" ? "✓ Live" : previewStatus === "starting" ? "Starting…" : previewStatus === "error" ? "Error" : "Waiting"}
                    </Badge>
                  </div>
                </div>
                {previewHref ? (
                  <div className="relative bg-[var(--arc-preview-bg)]">
                    <iframe
                      src={previewHref}
                      className="w-full border-0"
                      style={{ height: "380px" }}
                      title="Product preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    />
                    <a
                      href={previewHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute right-3 top-3 flex h-7 items-center gap-1.5 rounded-md bg-[var(--swiss-gray-50)]/90 px-2.5 text-[0.6875rem] font-medium text-[var(--swiss-gray-400)] backdrop-blur-sm transition hover:text-[var(--swiss-black)]"
                    >
                      Open <ArrowUpRight className="h-3 w-3" />
                    </a>
                  </div>
                ) : (
                  <div className="flex h-48 flex-col items-center justify-center gap-2 bg-[var(--arc-preview-bg)] text-[var(--swiss-gray-300)]">
                    <Monitor className="h-8 w-8 opacity-30" />
                    <span className="text-[0.8125rem]">No preview available yet</span>
                    {executionStatus !== "idle" ? (
                      <span className="text-[0.6875rem] text-[var(--swiss-gray-400)]">The team is building — preview will appear when ready</span>
                    ) : null}
                  </div>
                )}
              </section>

              {/* ── Current Sprint (collapsible) ────────── */}
              <section className="rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)]">
                <button
                  className="flex w-full items-center justify-between px-5 py-3 text-left"
                  onClick={() => setSprintOpen((prev) => !prev)}
                >
                  <span className="text-[0.8125rem] font-semibold">
                    {currentSprint?.title || (snapshot.strategy.title !== "CEO workspace is waiting for your first message" ? snapshot.strategy.title : "Current Workload")}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[0.75rem] text-[var(--swiss-gray-400)]">{completedTaskCount}/{totalTaskCount} tasks</span>
                    {totalTaskCount > 0 ? (
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--swiss-gray-200)]">
                        <div
                          className="h-full rounded-full bg-[var(--swiss-blue)] transition-all duration-500"
                          style={{ width: `${(completedTaskCount / totalTaskCount) * 100}%` }}
                        />
                      </div>
                    ) : null}
                    <ChevronDown
                      className={`h-4 w-4 text-[var(--swiss-gray-400)] transition-transform ${sprintOpen ? "rotate-180" : ""}`}
                    />
                  </div>
                </button>
                {sprintOpen ? (
                  <div className="border-t border-[var(--swiss-gray-100)] px-5 py-4">
                    {/* Task list */}
                    {sprintTasks.length > 0 ? (
                      <div className="space-y-0.5">
                        {sprintTasks.map((task) => (
                          <Link
                            key={task.id}
                            href="/tasks"
                            className="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-[var(--swiss-gray-100)] cursor-pointer"
                          >
                            <span className={`font-mono text-[0.8125rem] font-semibold ${getTaskStatusColor(task.status)}`}>
                              {getTaskStatusIcon(task.status)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{task.title}</span>
                            <span className="shrink-0 text-[0.6875rem] text-[var(--swiss-gray-400)]">{getAgentName(task)}</span>
                            <Badge
                              variant={task.status === "completed" ? "secondary" : task.status === "in_progress" ? "outline" : task.status === "failed" || task.status === "blocked" ? "destructive" : "outline"}
                              className="shrink-0 text-[0.5625rem]"
                            >
                              {task.status.replace(/_/g, " ")}
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <div className="py-6 text-center text-[0.8125rem] text-[var(--swiss-gray-300)]">
                        No tasks yet — start by chatting with the CEO
                      </div>
                    )}
                  </div>
                ) : null}
              </section>

              {/* ── Team (collapsible) ───────────────────── */}
              {snapshot.agents.length > 0 ? (
                <section className="rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)]">
                  <button
                    className="flex w-full items-center justify-between px-5 py-3 text-left"
                    onClick={() => setTeamOpen((prev) => !prev)}
                  >
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-[var(--swiss-gray-400)]" />
                      <span className="text-[0.8125rem] font-semibold">Team</span>
                      <span className="text-[0.6875rem] text-[var(--swiss-gray-400)]">{snapshot.agents.length} members</span>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 text-[var(--swiss-gray-400)] transition-transform ${teamOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {teamOpen ? (
                    <div className="border-t border-[var(--swiss-gray-100)] px-5 py-3">
                      <div className="space-y-1">
                        {snapshot.agents.map((agent) => {
                          const session = orchestratorStatus?.agentSessions?.[agent.sessionBindingId];
                          return (
                            <Link key={agent.id} href="/employees" className="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-[var(--swiss-gray-100)] cursor-pointer">
                              <span className={`h-2 w-2 shrink-0 rounded-full ${getAgentStatusColor(session?.status)}`} />
                              <span className="text-[0.8125rem] font-medium">{agent.name}</span>
                              <Badge variant="outline" className="text-[0.5625rem]">{agent.role}</Badge>
                              <span className="ml-auto max-w-[200px] truncate text-[0.6875rem] text-[var(--swiss-gray-400)]">
                                {session?.lastEventSummary || session?.status || "idle"}
                              </span>
                              <span className="text-[0.625rem] text-[var(--swiss-gray-300)]">
                                {session?.lastEventAt ? formatRelativeTime(session.lastEventAt) : "—"}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

            </div>
          </div>
        ) : null}
        </div>

        {/* ── Status bar ────────────────────────────────── */}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-5 font-mono text-[0.6875rem] text-[var(--swiss-gray-400)]">
        {currentSprint ? <span>Sprint {currentSprint.number}</span> : null}
        {totalTaskCount > 0 ? <span>{completedTaskCount}/{totalTaskCount} tasks</span> : null}
        {activeAgentCount > 0 ? (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--arc-success)]" />
            {activeAgentCount} active
          </span>
        ) : null}
        <span>Preview: {previewStatus === "ready" ? "✓ running" : previewStatus === "starting" ? "starting…" : "—"}</span>
        <span className="ml-auto text-[var(--swiss-gray-300)]">{snapshot.company.name || "Arceus"}</span>
      </footer>

      {/* ── Artifact modal ──────────────────────────────── */}
      {expandedArtifact ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--swiss-gray-100)] bg-[var(--swiss-white)]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--swiss-gray-100)] px-5 py-4">
              <div>
                <div className="text-[0.9375rem] font-semibold">{expandedArtifact.title}</div>
                <div className="swiss-caption mt-1 text-[var(--swiss-gray-400)]">
                  {expandedArtifact.agent} · {expandedArtifact.kind} · {new Date(expandedArtifact.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setExpandedArtifact(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              <div className="markdown-content text-[0.8125rem] leading-7 text-[var(--swiss-gray-500)]">
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
    </div>
  );
}
