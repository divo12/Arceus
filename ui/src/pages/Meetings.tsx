import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { meetingsApi } from "../api/meetings";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  MessageSquare,
  Users,
  AlertTriangle,
  Clock,
  CheckCircle2,
  ArrowUpRight,
  Calendar,
  Megaphone,
  RefreshCw,
} from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import type { MeetingListItem, MeetingType, MeetingStatus } from "@paperclipai/shared";

const meetingTypeConfig: Record<
  MeetingType,
  { label: string; icon: typeof Clock; color: string; bgColor: string }
> = {
  standup: {
    label: "Standup",
    icon: Calendar,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
  },
  escalation: {
    label: "Escalation",
    icon: AlertTriangle,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
  },
  sync: {
    label: "Sync",
    icon: RefreshCw,
    color: "text-emerald-500",
    bgColor: "bg-emerald-500/10",
  },
};

const statusConfig: Record<
  MeetingStatus,
  { label: string; color: string }
> = {
  scheduled: { label: "Scheduled", color: "text-blue-500" },
  in_progress: { label: "In Progress", color: "text-amber-500" },
  completed: { label: "Completed", color: "text-emerald-500" },
  cancelled: { label: "Cancelled", color: "text-muted-foreground" },
};

function MeetingCard({ meeting, onClick }: { meeting: MeetingListItem; onClick: () => void }) {
  const typeConf = meetingTypeConfig[meeting.type] ?? meetingTypeConfig.sync;
  const statusConf = statusConfig[meeting.status] ?? statusConfig.scheduled;
  const TypeIcon = typeConf.icon;

  return (
    <div
      className="group relative rounded-xl border border-border p-4 hover:shadow-md transition-all duration-200 cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={cn("rounded-lg p-2", typeConf.bgColor)}>
            <TypeIcon className={cn("h-4 w-4", typeConf.color)} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {typeConf.label}
              </Badge>
              <span className={cn("text-[10px] font-medium", statusConf.color)}>
                {statusConf.label}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {relativeTime(meeting.scheduledAt)}
            </p>
          </div>
        </div>
      </div>

      <p className="text-sm font-medium mb-3">{meeting.title}</p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {meeting.participants.length} participants
          </span>
        </div>
        {meeting.status === "completed" && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{meeting.decisionCount} decisions</span>
            <span>{meeting.learningCount} learnings</span>
          </div>
        )}
      </div>

      {/* Participants */}
      <div className="mt-2.5 flex items-center gap-1 flex-wrap">
        {meeting.participants.map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium"
          >
            {p.agentName ?? p.agentId.slice(0, 8)}
          </span>
        ))}
      </div>
    </div>
  );
}

function MeetingProtocol() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Meeting Protocol</CardTitle>
        <CardDescription>
          Structured communication — the only way employees share knowledge
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Calendar className="h-4 w-4 text-blue-500" />
              <h4 className="text-sm font-semibold">Standup</h4>
              <Badge variant="outline" className="text-[10px] ml-auto">
                Periodic
              </Badge>
            </div>
            <ul className="text-xs text-muted-foreground space-y-1 ml-6">
              <li>1. What I did (completed tasks, outcomes)</li>
              <li>2. What I&apos;m doing (active tasks)</li>
              <li>3. Blockers (unresolvable at my level)</li>
              <li>4. Learnings &amp; pattern observations</li>
            </ul>
            <p className="text-[10px] text-muted-foreground/70 mt-2 ml-6">
              Triggers deep consolidation → patterns evolve, habits form
            </p>
          </div>

          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <h4 className="text-sm font-semibold">Escalation</h4>
              <Badge variant="outline" className="text-[10px] ml-auto">
                Immediate
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              Unresolvable blocker → instant meeting with manager → chains up
              hierarchy until resolved → eventually reaches the Board (you)
            </p>
          </div>

          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <RefreshCw className="h-4 w-4 text-emerald-500" />
              <h4 className="text-sm font-semibold">Sync</h4>
              <Badge variant="outline" className="text-[10px] ml-auto">
                On-demand
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              Peer information exchange between employees at the same level —
              for cross-functional alignment
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Meetings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  useEffect(() => {
    setBreadcrumbs([{ label: "Meetings" }]);
  }, [setBreadcrumbs]);

  const { data: meetings, isLoading } = useQuery({
    queryKey: queryKeys.meetings.list(selectedCompanyId!),
    queryFn: () => meetingsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const items = meetings ?? [];
  const scheduledCount = items.filter((m) => m.status === "scheduled").length;
  const completedCount = items.filter((m) => m.status === "completed").length;
  const totalDecisions = items.reduce((s, m) => s + m.decisionCount, 0);
  const totalLearnings = items.reduce((s, m) => s + m.learningCount, 0);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={MessageSquare}
        message="Select a startup to view its meetings."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-500/5 p-2.5">
            <MessageSquare className="h-6 w-6 text-blue-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Meetings</h1>
            <p className="text-sm text-muted-foreground">
              Structured protocols — the only inter-employee communication
              channel
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Scheduled
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{scheduledCount}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Completed
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{completedCount}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Megaphone className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Decisions Made
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{totalDecisions}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUpRight className="h-4 w-4 text-violet-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Learnings Captured
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{totalLearnings}</p>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Meeting list */}
        <div className="md:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Recent &amp; Upcoming
          </h2>
          {items.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              message="No meetings yet. Meetings will appear once employees start collaborating."
            />
          ) : (
            <div className="grid gap-3">
              {items.map((meeting) => (
                <MeetingCard
                  key={meeting.id}
                  meeting={meeting}
                  onClick={() => navigate(`/meetings/${meeting.id}`)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Protocol reference */}
        <div>
          <MeetingProtocol />
        </div>
      </div>
    </div>
  );
}
