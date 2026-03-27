import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  AlertTriangle,
  RefreshCw,
  Users,
  Clock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Zap,
  MessageSquare,
  ArrowUp,
  BookOpen,
} from "lucide-react";
import { meetingsApi } from "../api/meetings";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn, relativeTime } from "../lib/utils";
import type {
  MeetingDetail as MeetingDetailType,
  MeetingParticipant,
  MeetingEvent,
  MeetingType,
  MeetingStatus,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const meetingTypeConfig: Record<
  string,
  { label: string; icon: typeof Calendar; color: string; bgColor: string }
> = {
  standup: { label: "Standup", icon: Calendar, color: "text-blue-500", bgColor: "bg-blue-500/10" },
  escalation: { label: "Escalation", icon: AlertTriangle, color: "text-amber-500", bgColor: "bg-amber-500/10" },
  sync: { label: "Sync", icon: RefreshCw, color: "text-emerald-500", bgColor: "bg-emerald-500/10" },
};

const statusConfig: Record<
  string,
  { label: string; color: string; bgColor: string }
> = {
  scheduled: { label: "Scheduled", color: "text-blue-500", bgColor: "bg-blue-500/10" },
  in_progress: { label: "In Progress", color: "text-amber-500", bgColor: "bg-amber-500/10" },
  completed: { label: "Completed", color: "text-emerald-500", bgColor: "bg-emerald-500/10" },
  cancelled: { label: "Cancelled", color: "text-muted-foreground", bgColor: "bg-muted/50" },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MeetingHeader({ meeting }: { meeting: MeetingDetailType }) {
  const typeConf = meetingTypeConfig[meeting.type] ?? meetingTypeConfig.sync;
  const statusConf = statusConfig[meeting.status] ?? statusConfig.scheduled;
  const TypeIcon = typeConf.icon;

  const duration =
    meeting.startedAt && meeting.completedAt
      ? Math.round(
          (new Date(meeting.completedAt).getTime() - new Date(meeting.startedAt).getTime()) /
            60000,
        )
      : null;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={cn("rounded-xl p-2.5", typeConf.bgColor)}>
            <TypeIcon className={cn("h-6 w-6", typeConf.color)} />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{meeting.title}</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              <Badge variant="outline" className="text-[10px]">
                {typeConf.label}
              </Badge>
              <span>·</span>
              <span>{relativeTime(new Date(meeting.scheduledAt))}</span>
              <span>·</span>
              <Users className="h-3.5 w-3.5" />
              <span>{meeting.participants.length} participants</span>
              {duration != null && (
                <>
                  <span>·</span>
                  <Clock className="h-3.5 w-3.5" />
                  <span>{duration} min</span>
                </>
              )}
            </div>
          </div>
        </div>
        <Badge className={cn("text-xs", statusConf.color, statusConf.bgColor)} variant="outline">
          {statusConf.label}
        </Badge>
      </div>
      {meeting.description && (
        <p className="text-sm text-muted-foreground pl-[52px]">{meeting.description}</p>
      )}
    </div>
  );
}

function ExecutiveSummary({ meeting }: { meeting: MeetingDetailType }) {
  if (meeting.status !== "completed" || !meeting.meetingNotes) return null;

  const decisions = meeting.events.filter((e) => e.kind === "decision");
  const actionItems = meeting.events.filter((e) => e.kind === "task_modification");

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Executive Summary
        </h2>
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{meeting.meetingNotes}</p>
      {decisions.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold text-muted-foreground">Key Decisions</h3>
          <ul className="text-sm space-y-1">
            {decisions.map((d) => (
              <li key={d.id} className="flex items-start gap-2">
                <Zap className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                <span>{d.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {actionItems.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold text-muted-foreground">Action Items</h3>
          <ul className="text-sm space-y-1">
            {actionItems.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
                <span>
                  {a.agentName && <strong>[{a.agentName}]</strong>} {a.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ContributionCard({ participant }: { participant: MeetingParticipant }) {
  const c = participant.contribution;
  if (!c) return null;

  const sections = [
    { label: "What I did", value: c.whatIDid },
    { label: "What I'm doing", value: c.whatImDoing },
    { label: "Blockers", value: c.blockers },
    { label: "Learnings", value: c.learnings },
  ].filter((s) => s.value);

  if (!sections.length) return null;

  return (
    <div className="rounded-xl border border-border p-4 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center h-7 w-7 rounded-full bg-secondary text-xs font-bold">
          {(participant.agentName ?? "?")[0]?.toUpperCase()}
        </div>
        <div>
          <span className="text-sm font-semibold">
            {participant.agentName ?? participant.agentId.slice(0, 8)}
          </span>
          {participant.agentRole && (
            <span className="text-xs text-muted-foreground ml-1.5">
              {participant.agentRole}
            </span>
          )}
          <Badge variant="outline" className="text-[10px] ml-2">
            {participant.role}
          </Badge>
        </div>
        {participant.joinedAt && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {new Date(participant.joinedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <div className="space-y-1.5 pl-9">
        {sections.map((s) => (
          <div key={s.label}>
            <span className="text-xs font-semibold text-muted-foreground">{s.label}: </span>
            <span className="text-sm">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventHighlight({ event }: { event: MeetingEvent }) {
  const configs: Record<string, { icon: typeof Zap; border: string; bg: string; label: string }> = {
    decision: { icon: Zap, border: "border-l-primary", bg: "bg-primary/5", label: "DECISION" },
    escalation: { icon: ArrowUp, border: "border-l-amber-500", bg: "bg-amber-500/5", label: "ESCALATION" },
    learning: { icon: BookOpen, border: "border-l-emerald-500", bg: "bg-emerald-500/5", label: "LEARNING" },
    memory_transfer: { icon: RefreshCw, border: "border-l-violet-500", bg: "bg-violet-500/5", label: "MEMORY TRANSFER" },
  };

  const conf = configs[event.kind];
  if (!conf) return null;
  const Icon = conf.icon;

  return (
    <div className={cn("rounded-lg border-l-4 p-3", conf.border, conf.bg)}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[10px] font-bold uppercase tracking-wider">{conf.label}</span>
        {event.agentName && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {event.agentName}
          </span>
        )}
      </div>
      <p className="text-sm">{event.content}</p>
    </div>
  );
}

function TranscriptTimeline({ meeting }: { meeting: MeetingDetailType }) {
  // Interleave contributions and highlight events chronologically by seq
  const contributions = meeting.participants.filter((p) => p.contribution);
  const highlightEvents = meeting.events.filter(
    (e) => e.kind === "decision" || e.kind === "escalation" || e.kind === "learning" || e.kind === "memory_transfer",
  );
  const noteEvents = meeting.events.filter((e) => e.kind === "note" || e.kind === "task_modification");

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <MessageSquare className="h-4 w-4" />
        Transcript
      </h2>

      {/* First show contributions (the core meeting content) */}
      {contributions.length > 0 && (
        <div className="space-y-3">
          {contributions.map((p) => (
            <ContributionCard key={p.id} participant={p} />
          ))}
        </div>
      )}

      {/* Then show highlight events inline */}
      {highlightEvents.length > 0 && (
        <div className="space-y-3 mt-4">
          <Separator />
          {highlightEvents.map((event) => (
            <EventHighlight key={event.id} event={event} />
          ))}
        </div>
      )}

      {/* Note events as simple items */}
      {noteEvents.length > 0 && (
        <div className="space-y-2 mt-4">
          <Separator />
          {noteEvents.map((event) => (
            <div key={event.id} className="flex items-start gap-2 text-sm text-muted-foreground">
              <span className="text-[10px] font-mono bg-secondary px-1.5 py-0.5 rounded shrink-0">
                #{event.seq}
              </span>
              {event.agentName && <span className="font-medium text-foreground">{event.agentName}:</span>}
              <span>{event.content}</span>
            </div>
          ))}
        </div>
      )}

      {contributions.length === 0 && meeting.events.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          message={
            meeting.status === "scheduled"
              ? "Meeting hasn't started yet. Contributions will appear once the meeting begins."
              : "No contributions or events recorded."
          }
        />
      )}
    </div>
  );
}

function MemoryImpactPanel({ meeting }: { meeting: MeetingDetailType }) {
  const memoryEvents = meeting.events.filter((e) => e.kind === "memory_transfer");
  if (!memoryEvents.length) return null;

  // Group by agent
  const byAgent = new Map<string, MeetingEvent[]>();
  for (const e of memoryEvents) {
    const key = e.agentId ?? "unknown";
    const list = byAgent.get(key) ?? [];
    list.push(e);
    byAgent.set(key, list);
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <RefreshCw className="h-4 w-4" />
        Memory Impact
      </h2>
      <div className="space-y-2">
        {[...byAgent.entries()].map(([agentId, events]) => (
          <MemoryAgentCard key={agentId} agentId={agentId} events={events} />
        ))}
      </div>
    </div>
  );
}

function MemoryAgentCard({ agentId, events }: { agentId: string; events: MeetingEvent[] }) {
  const [open, setOpen] = useState(false);
  const agentName = events[0]?.agentName ?? agentId.slice(0, 8);

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-accent/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-6 w-6 rounded-full bg-violet-500/10 text-violet-500 text-xs font-bold">
            {agentName[0]?.toUpperCase()}
          </div>
          <span className="text-sm font-medium">{agentName}</span>
          <span className="text-xs text-muted-foreground">
            — gained {events.length} {events.length === 1 ? "memory" : "memories"}
          </span>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t border-border divide-y divide-border">
          {events.map((e) => {
            const tier = (e.payload?.tier as string) ?? "episodic";
            const quality = (e.payload?.quality as number) ?? null;
            const tierEmoji = tier === "semantic" ? "\u{1F4D8}" : tier === "priming" ? "\u{1F4D9}" : "\u{1F4D7}";
            return (
              <div key={e.id} className="px-4 py-2.5 space-y-0.5">
                <div className="flex items-center gap-2 text-xs">
                  <span>{tierEmoji}</span>
                  <span className="font-medium capitalize">{tier}</span>
                  {quality != null && (
                    <span className="text-muted-foreground">· q: {quality.toFixed(2)}</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{e.content}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgendaPanel({ meeting }: { meeting: MeetingDetailType }) {
  if (!meeting.agenda?.length) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agenda
      </h2>
      <div className="space-y-2">
        {meeting.agenda.map((item, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            <span className="text-xs font-mono bg-secondary px-1.5 py-0.5 rounded shrink-0 mt-0.5">
              {i + 1}
            </span>
            <div>
              <span className="font-medium">{item.topic}</span>
              {item.content && (
                <p className="text-muted-foreground text-xs mt-0.5">{item.content}</p>
              )}
            </div>
            <Badge variant="outline" className="text-[10px] ml-auto shrink-0">
              {item.type}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

function ParticipantsList({ meeting }: { meeting: MeetingDetailType }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Users className="h-4 w-4" />
        Participants
      </h2>
      <div className="flex flex-wrap gap-2">
        {meeting.participants.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
          >
            <div className="flex items-center justify-center h-6 w-6 rounded-full bg-secondary text-xs font-bold">
              {(p.agentName ?? "?")[0]?.toUpperCase()}
            </div>
            <div className="text-sm">
              <span className="font-medium">{p.agentName ?? p.agentId.slice(0, 8)}</span>
              {p.agentRole && (
                <span className="text-muted-foreground ml-1">({p.agentRole})</span>
              )}
            </div>
            <Badge variant="outline" className="text-[10px]">
              {p.role}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function MeetingActions({ meeting }: { meeting: MeetingDetailType }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const startMeeting = useMutation({
    mutationFn: () => meetingsApi.start(meeting.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.meetings.detail(meeting.id) });
      pushToast({ title: "Meeting started", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: `Failed to start meeting: ${err.message}`, tone: "error" }),
  });

  const completeMeeting = useMutation({
    mutationFn: () => meetingsApi.complete(meeting.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.meetings.detail(meeting.id) });
      pushToast({ title: "Meeting completed", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: `Failed to complete meeting: ${err.message}`, tone: "error" }),
  });

  const cancelMeeting = useMutation({
    mutationFn: () => meetingsApi.cancel(meeting.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.meetings.detail(meeting.id) });
      pushToast({ title: "Meeting cancelled", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: `Failed to cancel meeting: ${err.message}`, tone: "error" }),
  });

  return (
    <div className="flex items-center gap-2">
      {meeting.status === "scheduled" && (
        <>
          <Button
            size="sm"
            onClick={() => startMeeting.mutate()}
            disabled={startMeeting.isPending}
          >
            Start Meeting
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => cancelMeeting.mutate()}
            disabled={cancelMeeting.isPending}
          >
            Cancel
          </Button>
        </>
      )}
      {meeting.status === "in_progress" && (
        <Button
          size="sm"
          onClick={() => completeMeeting.mutate()}
          disabled={completeMeeting.isPending}
        >
          Complete Meeting
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MeetingDetail() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: meeting, isLoading } = useQuery({
    queryKey: queryKeys.meetings.detail(meetingId!),
    queryFn: () => meetingsApi.get(meetingId!),
    enabled: !!meetingId,
  });

  useEffect(() => {
    if (meeting) {
      setBreadcrumbs([
        { label: "Meetings", href: "/meetings" },
        { label: meeting.title },
      ]);
    }
  }, [meeting, setBreadcrumbs]);

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (!meeting) {
    return (
      <EmptyState
        icon={MessageSquare}
        message="Meeting not found."
      />
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header + actions */}
      <div className="flex items-start justify-between">
        <MeetingHeader meeting={meeting} />
        <MeetingActions meeting={meeting} />
      </div>

      {/* Executive summary (completed only) */}
      <ExecutiveSummary meeting={meeting} />

      {/* Agenda (scheduled / in progress) */}
      {meeting.status !== "completed" && <AgendaPanel meeting={meeting} />}

      {/* Participants */}
      <ParticipantsList meeting={meeting} />

      <Separator />

      {/* Transcript */}
      <TranscriptTimeline meeting={meeting} />

      {/* Memory impact (completed with transfers) */}
      <MemoryImpactPanel meeting={meeting} />
    </div>
  );
}
