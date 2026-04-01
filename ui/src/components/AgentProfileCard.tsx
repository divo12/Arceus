import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  Database,
  Shield,
  Sparkles,
  UserRound,
  Zap,
} from "lucide-react";
import type { EmployeeProfile, MemorySummary } from "../api/memory";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface AgentProfileCardProps {
  profile: EmployeeProfile | null;
  summary?: MemorySummary | null;
  loading?: boolean;
  errorMessage?: string | null;
  variant?: "full" | "sidebar";
  emptyTitle?: string;
  emptyDescription?: string;
}

const SECTION_TITLE =
  "text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground";

function HealthBar({
  color,
  label,
  maxValue,
  value,
}: {
  color: string;
  label: string;
  maxValue: number;
  value: number;
}) {
  const width = Math.max(8, Math.round((value / Math.max(maxValue, 1)) * 100));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${width}%`,
            backgroundColor: `var(${color})`,
          }}
        />
      </div>
    </div>
  );
}

function HabitConfidence({
  confidence,
}: {
  confidence: number;
}) {
  const width = Math.round(confidence * 100);

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--memory-procedural)] transition-all"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">
        {confidence.toFixed(2)}
      </span>
    </div>
  );
}

function EmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center text-muted-foreground">
      <UserRound className="mb-3 h-9 w-9" />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="mt-2 max-w-lg text-sm">{description}</p>
    </div>
  );
}

export function AgentProfileCard({
  profile,
  summary,
  loading = false,
  errorMessage,
  variant = "full",
  emptyTitle = "Profile builds as the agent accumulates memories.",
  emptyDescription = "No profile signals are available yet. Static knowledge, current context, habits, and priming will appear here as the agent learns.",
}: AgentProfileCardProps) {
  const [knowledgeExpanded, setKnowledgeExpanded] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const primingPrompt = typeof profile?.state?.priming_prompt === "string"
    ? profile.state.priming_prompt
    : "";

  const healthItems = useMemo(() => {
    const items = [
      {
        label: "Static",
        value: summary?.total_static ?? profile?.core_knowledge.length ?? 0,
        color: "--memory-static",
        icon: Shield,
      },
      {
        label: "Dynamic",
        value: summary?.total_dynamic ?? profile?.current_context.length ?? 0,
        color: "--memory-dynamic",
        icon: Zap,
      },
      {
        label: "Habits",
        value: profile?.habits.length ?? summary?.active_habits.length ?? 0,
        color: "--memory-procedural",
        icon: Database,
      },
      {
        label: "Priming",
        value: primingPrompt ? 1 : 0,
        color: "--memory-priming",
        icon: Brain,
      },
    ];

    const maxValue = Math.max(1, ...items.map((item) => item.value));
    return { items, maxValue };
  }, [primingPrompt, profile?.core_knowledge.length, profile?.current_context.length, profile?.habits.length, summary?.active_habits.length, summary?.total_dynamic, summary?.total_static]);

  const displayedKnowledge = knowledgeExpanded
    ? profile?.core_knowledge ?? []
    : (profile?.core_knowledge ?? []).slice(0, 5);
  const displayedContext = contextExpanded
    ? profile?.current_context ?? []
    : (profile?.current_context ?? []).slice(0, 4);
  const remainingKnowledge = Math.max(0, (profile?.core_knowledge.length ?? 0) - displayedKnowledge.length);
  const remainingContext = Math.max(0, (profile?.current_context.length ?? 0) - displayedContext.length);
  const partial = Boolean(profile?.state?.partial);
  const hasContent = Boolean(
    profile &&
    (
      profile.core_knowledge.length ||
      profile.current_context.length ||
      profile.habits.length ||
      primingPrompt ||
      summary?.total_static ||
      summary?.total_dynamic
    ),
  );

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="space-y-4">
          <Skeleton className="h-16 rounded-lg" />
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.95fr]">
            <div className="space-y-3">
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-28 rounded-lg" />
              <Skeleton className="h-20 rounded-lg" />
            </div>
            <div className="space-y-3">
              <Skeleton className="h-36 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
        <h3 className="mt-3 text-sm font-medium text-foreground">Profile unavailable</h3>
        <p className="mt-2 text-sm text-muted-foreground">{errorMessage}</p>
      </div>
    );
  }

  if (!hasContent) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[var(--memory-priming)]" />
              <h3 className="text-lg font-semibold text-foreground">
                {profile?.role || "Agent"}
              </h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Memory-built persona assembled from current knowledge, context, and habits.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {summary?.total_static ? <Badge variant="outline">{summary.total_static} static</Badge> : null}
            {summary?.total_dynamic ? <Badge variant="outline">{summary.total_dynamic} dynamic</Badge> : null}
            {(profile?.habits.length ?? 0) > 0 ? (
              <Badge variant="outline">{profile?.habits.length} habits</Badge>
            ) : null}
          </div>
        </div>

        {partial ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium text-foreground">Partial profile</p>
              <p className="text-muted-foreground">
                Some memory subsystems did not respond, so this profile may be incomplete.
              </p>
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            "grid gap-4",
            variant === "sidebar" ? "grid-cols-1" : "grid-cols-1 xl:grid-cols-[1.2fr_0.9fr]",
          )}
        >
          <div className="space-y-4">
            <section className="rounded-lg border border-border p-4">
              <h4 className={SECTION_TITLE}>Core Knowledge</h4>
              {displayedKnowledge.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {displayedKnowledge.map((item, index) => (
                    <Badge
                      key={`${item}-${index}`}
                      variant="secondary"
                      className="max-w-full whitespace-normal break-words px-2 py-1 text-left"
                    >
                      {item}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  Static knowledge has not been formed yet.
                </p>
              )}
              {remainingKnowledge > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-3 px-0 text-xs text-muted-foreground"
                  onClick={() => setKnowledgeExpanded((value) => !value)}
                >
                  {knowledgeExpanded ? (
                    <>
                      <ChevronUp className="mr-1.5 h-3.5 w-3.5" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="mr-1.5 h-3.5 w-3.5" />+{remainingKnowledge} more
                    </>
                  )}
                </Button>
              ) : null}
            </section>

            <section className="rounded-lg border border-border p-4">
              <h4 className={SECTION_TITLE}>Current Context</h4>
              {displayedContext.length ? (
                <div className="mt-3 space-y-2">
                  {displayedContext.map((item, index) => (
                    <div
                      key={`${item}-${index}`}
                      className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-foreground"
                    >
                      {item}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  No active dynamic context is available right now.
                </p>
              )}
              {remainingContext > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-3 px-0 text-xs text-muted-foreground"
                  onClick={() => setContextExpanded((value) => !value)}
                >
                  {contextExpanded ? (
                    <>
                      <ChevronUp className="mr-1.5 h-3.5 w-3.5" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="mr-1.5 h-3.5 w-3.5" />+{remainingContext} more
                    </>
                  )}
                </Button>
              ) : null}
            </section>

            {primingPrompt ? (
              <section className="rounded-lg border border-border p-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[var(--memory-priming)]" />
                  <h4 className={SECTION_TITLE}>Priming Signal</h4>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                  {primingPrompt}
                </p>
              </section>
            ) : null}
          </div>

          <div className="space-y-4">
            <section className="rounded-lg border border-border p-4">
              <h4 className={SECTION_TITLE}>Habits</h4>
              {profile?.habits.length ? (
                <div className="mt-3 space-y-3">
                  {profile.habits.slice(0, 6).map((habit, index) => (
                    <div
                      key={`${habit.trigger}-${habit.action}-${index}`}
                      className="rounded-md border border-border bg-muted/20 p-3"
                    >
                      <p className="text-sm font-medium text-foreground">
                        When: {habit.trigger}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Do: {habit.action}
                      </p>
                      <div className="mt-2">
                        <HabitConfidence confidence={habit.confidence} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  Habit suggestions will appear after repeated successful behavior.
                </p>
              )}
            </section>

            <section className="rounded-lg border border-border p-4">
              <h4 className={SECTION_TITLE}>Memory Health</h4>
              <div className="mt-3 space-y-3">
                {healthItems.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Icon className="h-3.5 w-3.5" style={{ color: `var(${item.color})` }} />
                        <span>{item.label}</span>
                      </div>
                      <HealthBar
                        color={item.color}
                        label={item.label}
                        maxValue={healthItems.maxValue}
                        value={item.value}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
