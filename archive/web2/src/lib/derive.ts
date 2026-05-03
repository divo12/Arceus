/**
 * Derivations: raw API → view envelopes.
 *
 * Every string the user reads is produced here. AI-authored prose is
 * wrapped in `narrativeText({ kind: "ai" })`; deterministic strings
 * built from raw counts/state are `template(...)`; fixed UI labels are
 * `label(...)`. The UI components never compute or format strings.
 */
import type {
  RawAgent, RawAuditEvent, RawCompany, RawHeartbeat, RawMeeting,
  RawMemory, RawSkill, RawSprint, RawTask, RawWorkspace,
} from "./api.js";
import { label, template, type NarrativeText } from "../contracts/view.js";
import type {
  InboxView, LogsView, MeetingsView, MemoryView, PreviewView,
  SettingsView, Shell, SkillsView, SprintView, TeamView, TodayView, Pip,
} from "../contracts/views.js";

// ── small utils ─────────────────────────────────────────
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function idleFor(iso?: string | null): string {
  if (!iso) return "idle";
  const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (sec < 60) return `idle ${Math.round(sec)}s`;
  if (sec < 3600) return `idle ${Math.round(sec / 60)}m`;
  if (sec < 86400) return `idle ${Math.round(sec / 3600)}h`;
  return `idle ${Math.round(sec / 86400)}d`;
}

function todayKicker(): string {
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return days[new Date().getDay()]!;
}

function isAgentWorking(a: RawAgent): boolean {
  const s = a.session?.runtimeStatus;
  return s === "running" || s === "active" || a.status === "running";
}

function pipFor(a: RawAgent): Pip {
  if (!isAgentWorking(a)) return "none";
  if (a.session?.awaiting) return "amber";
  return "green";
}

function agentInitials(name: string): string {
  return name.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

// ── Shell ───────────────────────────────────────────────
export function deriveShell(input: {
  company: RawCompany;
  sprints: RawSprint[];
  agents: RawAgent[];
  memories: RawMemory[];
  skills: RawSkill[];
  meetings: RawMeeting[];
  audit: { total: number };
  heartbeat: RawHeartbeat;
}): Shell {
  const { company, sprints, agents, memories, skills, meetings, audit, heartbeat } = input;

  const lessons = memories.reduce((n, m) => n
    + (m.memory?.recentLearnings?.length ?? 0)
    + (m.memory?.activePatterns?.length ?? 0)
    + (m.memory?.importantDecisions?.length ?? 0), 0);
  const activeSprints = sprints.filter(s => s.status === "executing" || s.status === "planning").length;
  const totalSprints = sprints.length;
  const skillsLib = skills.filter(s => s.status === "active").length;
  const skillsForming = skills.filter(s => s.status === "draft" || s.status === "testing").length;
  const todayMeetings = meetings.filter(m => {
    if (!m.scheduledAt) return false;
    const d = new Date(m.scheduledAt);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  const ceo = agents.find(a => a.role === "ceo") ?? null;

  const realCompany = Boolean(company.company?.id) && company.company?.status !== "ideation";
  const compName = realCompany ? (company.company?.name ?? null) : null;

  const agentLive = agents.filter(isAgentWorking).length;
  const awaitingCount = agents.filter(a => !!a.session?.awaiting).length;

  return {
    brand: compName ? { initial: compName[0]!.toUpperCase(), name: compName } : null,
    tabs: [
      { id: "today",     label: "today",     group: "company",   count: null,                                              live: heartbeat.running },
      { id: "sprint",    label: "sprint",    group: "company",   count: totalSprints ? `${activeSprints}/${totalSprints}` : null, live: false },
      { id: "team",      label: "team",      group: "company",   count: agents.length ? String(agents.length) : null,      live: agentLive > 0 },
      { id: "memory",    label: "memory",    group: "knowledge", count: lessons ? String(lessons) : null,                  live: false },
      { id: "skills",    label: "skills",    group: "knowledge", count: skills.length ? `${skillsLib}·${skillsForming}` : null, live: false },
      { id: "meetings",  label: "meetings",  group: "knowledge", count: todayMeetings ? String(todayMeetings) : null,      live: false },
      { id: "inbox",     label: "inbox",     group: "for-you",   count: null,                                              live: false },
      { id: "preview",   label: "preview",   group: "for-you",   count: null,                                              live: false },
      { id: "logs",      label: "logs",      group: "for-you",   count: audit.total ? audit.total.toLocaleString() : null, live: false },
      { id: "inspector", label: "inspector", group: "for-you",   count: null,                                              live: heartbeat.running },
      { id: "settings",  label: "settings",  group: "for-you",   count: null,                                              live: false },
    ],
    ceo: {
      initials: ceo ? agentInitials(ceo.name) : "—",
      name: ceo?.name ?? "—",
    },
    version: "v0.7",
    pulse: {
      heartbeatRunning: heartbeat.running,
      beatCount: heartbeat.beatCount,
      lastBeatAt: heartbeat.lastBeatAt ?? null,
      lastBeatAgo: timeAgo(heartbeat.lastBeatAt),
      agentTotal: agents.length,
      agentLive,
      awaitingCount,
      auditTotal: audit.total,
    },
  };
}

// ── Today ───────────────────────────────────────────────
export function deriveToday(input: {
  company: RawCompany;
  agents: RawAgent[];
  memories: RawMemory[];
  sprints: RawSprint[];
  heartbeat: RawHeartbeat;
  audit: RawAuditEvent[];
}): TodayView {
  const { company, agents, memories, sprints, heartbeat, audit } = input;
  const compName = company.company?.name;
  const compGoal = company.company?.goal;
  const compId = company.company?.id;
  const compStatus = company.company?.status;
  // The API returns a stub "Untitled Company" (empty id, status "ideation")
  // when no company exists. Treat that as bootstrap so the user sees the
  // QuickExecute composer instead of a misleading "alive" headline.
  const hasCompany = Boolean(compName) && Boolean(compId) && compStatus !== "ideation";

  const working = agents.filter(isAgentWorking);
  const resting = agents.length - working.length;

  const activeSprint = sprints.find(s => s.status === "executing") ?? sprints[0];
  const sprintNum = activeSprint?.number ?? 0;
  const dayOfSprint = activeSprint?.startedAt
    ? Math.max(1, Math.floor((Date.now() - Date.parse(activeSprint.startedAt)) / 86400000) + 1)
    : 0;

  // Headline: prefer company-aware narrative once bootstrapped.
  let headlineText: string;
  if (!hasCompany) {
    headlineText = "No company yet. Describe an idea below to start one.";
  } else if (working.length === 0) {
    headlineText = `${compName} is alive. ${compGoal ? `Goal: ${compGoal}` : "The team is reading."}`;
  } else {
    const first = working[0];
    headlineText = `${cap(first?.role ?? "Someone")} is working. ${working.length === 1 ? "One agent" : `${working.length} agents`} in motion at ${compName}.`;
  }

  const sublineParts = [
    hasCompany ? `${agents.length} agents` : "no agents",
    `${working.length} working`,
    `${resting} resting`,
    heartbeat.running ? "heartbeat live" : "heartbeat paused",
    sprintNum ? `sprint ${sprintNum}` : "no sprint",
  ];

  // Surface the most recent learning across agents as "in flight".
  const learnings = memories.flatMap(m =>
    (m.memory?.recentLearnings ?? []).map(text => ({
      text, agent: m.name ?? m.role ?? "—", at: m.memory?.updatedAt,
    })),
  ).sort((a, b) => Date.parse(b.at ?? "0") - Date.parse(a.at ?? "0"));
  const forming = learnings.slice(0, 1).map(u => ({
    text: u.text,
    cite: `${u.agent.toUpperCase()} · ${timeAgo(u.at)}`,
  }));

  // If memory is empty but there's audit activity, fall back to latest audit
  // line so Today doesn't look frozen on a fresh company.
  const latest = audit
    .slice()
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];

  return {
    kicker: `${todayKicker()}${sprintNum ? `, Sprint ${sprintNum}, day ${dayOfSprint}` : ""}`,
    headline: template(headlineText),
    subline: template(sublineParts.join(" · ")),
    mode: hasCompany ? "chat" : "bootstrap",
    companyName: hasCompany ? (compName ?? null) : null,
    needs: [], // Hooked up once approvals list endpoint exists; see integration-plan §2.7.
    working: working.slice(0, 4).map(a => ({
      agentId: a.id,
      who: `${cap(a.role)} · ${a.name} · ${timeAgo(a.session?.lastEventAt)}`,
      ask: template(a.session?.activeTaskId ? `Working on ${a.session.activeTaskId}.` : `${cap(a.role)} is active.`),
      why: template(a.session?.awaiting ? `Waiting on ${a.session.awaiting}.` : "Live session."),
      pip: pipFor(a),
    })),
    forming: forming.length > 0
      ? forming
      : (latest && hasCompany)
        ? [{ text: latest.summary ?? latest.eventType, cite: `LEDGER · ${timeAgo(latest.occurredAt)}` }]
        : [],
  };
}

// ── Sprint ──────────────────────────────────────────────
export function deriveSprint(input: { sprints: RawSprint[]; tasks: RawTask[] }): SprintView {
  const { sprints, tasks } = input;
  const active = sprints.find(s => s.status === "executing") ?? sprints[0] ?? null;
  if (!active) {
    return {
      kicker: "No active sprint",
      headline: template("The company hasn't started a sprint yet."),
      subline: template("Bootstrap a company to begin."),
      progressPct: 0,
      rows: [],
      foot: "0 tasks",
    };
  }

  const sprintTasks = tasks.filter(t => t.sprintId === active.id);
  const done = sprintTasks.filter(t => t.status === "done" || t.status === "completed");
  const inProgress = sprintTasks.filter(t => t.status === "in_progress" || t.status === "running");
  const queued = sprintTasks.filter(t => !done.includes(t) && !inProgress.includes(t));
  const total = sprintTasks.length;
  const progressPct = total ? Math.round((done.length / total) * 100) : 0;

  // Day-of-sprint
  const day = active.startedAt
    ? Math.max(1, Math.floor((Date.now() - Date.parse(active.startedAt)) / 86400000) + 1)
    : 1;
  const length = active.startedAt && active.endsAt
    ? Math.max(1, Math.round((Date.parse(active.endsAt) - Date.parse(active.startedAt)) / 86400000))
    : 7;

  const statusOf = (t: RawTask): "done" | "now" | "next" =>
    done.includes(t) ? "done" : inProgress.includes(t) ? "now" : "next";
  const verbOf = (t: RawTask): string =>
    done.includes(t) ? "shipped"
    : inProgress.includes(t) ? (t.executionStatus ?? "working")
    : "queued";
  const order: Record<"now" | "next" | "done", number> = { now: 0, next: 1, done: 2 };
  const rows = sprintTasks
    .map(t => ({
      id: t.id,
      status: statusOf(t),
      title: t.title ?? "(untitled)",
      role: cap(t.assignedRole ?? "Unassigned"),
      agent: t.assignedAgentId ?? null,
      verb: verbOf(t),
    }))
    .sort((a, b) => order[a.status] - order[b.status]);

  return {
    kicker: `Sprint ${active.number ?? "—"}, day ${day} of ${length}`,
    headline: template(active.goal ?? `Sprint ${active.number} in flight.`),
    subline: template(`${done.length} done · ${inProgress.length} in flight · ${queued.length} queued`),
    progressPct,
    rows,
    foot: `${total} tasks · ${progressPct}% complete`,
  };
}

// ── Team ────────────────────────────────────────────────
export function deriveTeam(input: { agents: RawAgent[] }): TeamView {
  const { agents } = input;
  const working = agents.filter(isAgentWorking);
  const resting = agents.filter(a => !isAgentWorking(a));

  return {
    kicker: "Team",
    headline: template(`${agents.length} on the roster. ${working.length} working now.`),
    subline: template(working.length ? `${working.length} live · ${resting.length} resting` : "All quiet."),
    working: working.map(a => ({
      agentId: a.id,
      who: `${cap(a.role)} · ${a.name} · ${timeAgo(a.session?.lastEventAt)}`,
      ask: template(a.session?.activeTaskId ? `Working on ${a.session.activeTaskId}.` : `${a.title ?? cap(a.role)}.`),
      why: template(a.session?.awaiting ? `Awaiting ${a.session.awaiting}.` : "Live."),
      pip: pipFor(a),
    })),
    resting: resting.map(a => ({
      agentId: a.id,
      role: cap(a.role),
      name: a.name,
      idleFor: idleFor(a.session?.lastEventAt),
    })),
    foot: `${working.length} working · ${resting.length} resting · ${agents.length} total`,
  };
}

// ── Memory ──────────────────────────────────────────────
export function deriveMemory(input: { memories: RawMemory[] }): MemoryView {
  // Each agent has 5 buckets. Treat `currentFocus` + `openBlockers` as
  // "forming" (live state), `recentLearnings` + `activePatterns` +
  // `importantDecisions` as "recent lessons" (filed knowledge).
  interface Row { id: string; agent: string; text: string; bucket: string; at?: string }
  const rows: Row[] = [];
  for (const m of input.memories) {
    const a = m.name ?? m.role ?? "—";
    const at = m.memory?.updatedAt;
    (m.memory?.currentFocus ?? []).forEach((t, i) => rows.push({ id: `${m.agentId}:f${i}`, agent: a, text: t, bucket: "focus", at }));
    (m.memory?.openBlockers ?? []).forEach((t, i) => rows.push({ id: `${m.agentId}:b${i}`, agent: a, text: t, bucket: "blocker", at }));
    (m.memory?.recentLearnings ?? []).forEach((t, i) => rows.push({ id: `${m.agentId}:l${i}`, agent: a, text: t, bucket: "learning", at }));
    (m.memory?.activePatterns ?? []).forEach((t, i) => rows.push({ id: `${m.agentId}:p${i}`, agent: a, text: t, bucket: "pattern", at }));
    (m.memory?.importantDecisions ?? []).forEach((t, i) => rows.push({ id: `${m.agentId}:d${i}`, agent: a, text: t, bucket: "decision", at }));
  }
  rows.sort((x, y) => Date.parse(y.at ?? "0") - Date.parse(x.at ?? "0"));

  const forming = rows.filter(r => r.bucket === "focus" || r.bucket === "blocker").slice(0, 3).map(r => ({
    id: r.id,
    text: r.text,
    cite: `${r.agent.toUpperCase()} · ${r.bucket} · ${timeAgo(r.at)}`,
  }));
  const recent = rows.filter(r => r.bucket !== "focus" && r.bucket !== "blocker").slice(0, 8).map(r => ({
    id: r.id,
    role: r.agent.toUpperCase().slice(0, 12),
    text: r.text,
    verb: `${r.bucket} · ${timeAgo(r.at)}`,
  }));

  const contributors = input.memories.filter(m =>
    (m.memory?.currentFocus?.length ?? 0)
    + (m.memory?.recentLearnings?.length ?? 0)
    + (m.memory?.activePatterns?.length ?? 0)
    + (m.memory?.openBlockers?.length ?? 0)
    + (m.memory?.importantDecisions?.length ?? 0) > 0
  ).length;

  return {
    kicker: "Memory",
    headline: template(`${rows.length} lessons in store.`),
    subline: template(`${forming.length} forming · ${recent.length} recent`),
    forming,
    recent,
    foot: `${rows.length} lessons · ${contributors} contributors`,
  };
}

// ── Skills ──────────────────────────────────────────────
const LIFECYCLE = [
  { step: "1. Try",      what: "An agent solves a problem in a way worth keeping.",       state: "draft" },
  { step: "2. Practise", what: "It runs three more times. Each run sharpens the steps.",  state: "forming" },
  { step: "3. Promote",  what: "CEO or peer review accepts it into the library.",         state: "v1" },
  { step: "4. Refine",   what: "A better version replaces it. The old one is kept.",      state: "v2, v3…" },
  { step: "5. Retire",   what: "Unused for a sprint — archived, not deleted.",            state: "archived" },
];

export function deriveSkills(input: { skills: RawSkill[] }): SkillsView {
  const { skills } = input;
  const drafting = skills.filter(s => s.status === "draft" || s.status === "testing");
  const library = skills.filter(s => s.status === "active");

  // "new" if active, latest version, created in last 7 days
  const now = Date.now();
  const isNew = (s: RawSkill) =>
    s.createdAt ? now - Date.parse(s.createdAt) < 7 * 86400000 : false;

  return {
    kicker: "Skills",
    headline: template(
      skills.length === 0
        ? "No skills yet. They form as the company works."
        : `What the company can do. ${library.length} skills practised. ${drafting.length} forming.`,
    ),
    subline: template(
      `${library.length} in library · ${drafting.length} forming`,
    ),
    forming: drafting.slice(0, 6).map(s => ({
      id: s.id,
      who: `${cap(s.status)} · ${cap(s.role)} · tried ${s.usageCount ?? 0} times`,
      ask: template(s.name),
      why: template(s.trigger ?? "Drafting from recent work."),
      pip: (s.successRate ?? 0) > 0.66 ? "green" : (s.successRate ?? 0) > 0.33 ? "amber" : "none",
      canPromote: (s.usageCount ?? 0) >= 3,
    })),
    library: library.map(s => ({
      id: s.id,
      version: `v${s.version}${isNew(s) ? " · new" : ""}`,
      name: s.name,
      usage: `used ${s.usageCount ?? 0}×`,
    })),
    lifecycle: LIFECYCLE,
    foot: `${library.length} in library · ${drafting.length} forming · 0 promoted · 0 retired this sprint`,
  };
}

// ── Meetings ────────────────────────────────────────────
export function deriveMeetings(input: { meetings: RawMeeting[]; agents: RawAgent[] }): MeetingsView {
  const { meetings, agents } = input;
  const byId = new Map(agents.map(a => [a.id, a]));
  const day = (iso?: string) => iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "short" }) : "—";
  const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

  const recent = [...meetings]
    .sort((a, b) => Date.parse(b.scheduledAt ?? "0") - Date.parse(a.scheduledAt ?? "0"))
    .slice(0, 6)
    .map(m => {
      const attendees = (m.contributions ?? [])
        .map(c => byId.get(c.agentId)?.name)
        .filter(Boolean)
        .slice(0, 4)
        .join(", ");
      const ask = m.synthesis?.primaryQuestion
        ?? m.synthesis?.topics?.[0]?.title
        ?? `${cap(m.type ?? "meeting")} session.`;
      const why = m.resolution?.decisions?.[0]?.summary
        ?? (m.status === "completed" ? "Concluded." : `Status: ${m.status ?? "scheduled"}.`);
      return {
        id: m.id,
        who: `${day(m.scheduledAt)} · ${time(m.scheduledAt)} · ${attendees || "—"}`,
        ask: template(ask),
        why: template(why),
        hasTranscript: m.status === "completed",
      };
    });

  return {
    kicker: "Meetings",
    headline: template(`${meetings.length} on record.`),
    subline: template(`${recent.length} recent`),
    meetings: recent,
    foot: `${meetings.length} meetings · ${recent.filter(r => r.hasTranscript).length} with transcripts`,
  };
}

// ── Inbox ───────────────────────────────────────────────
/** Inbox is derived from audit events of category=approval. List endpoint is a gap (see integration-plan §2.7). */
export function deriveInbox(input: { audit: RawAuditEvent[] }): InboxView {
  const approvals = input.audit.filter(e => e.category === "approval" || e.eventType.includes("approval"));
  const waiting = approvals.filter(e => e.eventType.includes("requested") || e.eventType.includes("pending")).slice(0, 4);
  const cleared = approvals.filter(e => e.eventType.includes("approved") || e.eventType.includes("rejected")).slice(0, 6);

  return {
    kicker: "Inbox",
    headline: template(waiting.length === 0 ? "Inbox is clear." : `${waiting.length} waiting on you.`),
    subline: template(`${waiting.length} waiting · ${cleared.length} cleared today`),
    waiting: waiting.map(e => ({
      id: e.id,
      who: `${(e.category ?? "decision").toUpperCase()} · ${timeAgo(e.occurredAt)}`,
      ask: template(e.summary ?? e.eventType),
      why: template("Awaiting your call."),
      pip: "amber",
    })),
    cleared: cleared.map(e => ({
      id: e.id,
      ts: new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      what: e.summary ?? e.eventType,
      verb: e.eventType.includes("approved") ? "approved" : "held",
    })),
    foot: `${waiting.length} waiting · ${cleared.length} cleared`,
  };
}

// ── Preview ─────────────────────────────────────────────
export function derivePreview(input: { workspace: RawWorkspace }): PreviewView {
  const { workspace } = input;
  const snaps = workspace.snapshots ?? [];
  const live: PreviewView["live"] = snaps.slice(0, 2).map((s, i) => ({
    id: s.id,
    who: `${i === 0 ? "Production" : "Staging"} · ${s.label ?? s.id.slice(0, 8)}`,
    ask: template(s.label ?? "Workspace snapshot"),
    why: template(`Captured ${timeAgo(s.createdAt)}`),
    publicUrl: null,
    canRollback: i > 0,
    pip: "green",
  }));
  const recent = snaps.slice(2, 8).map(s => ({
    id: s.id,
    ts: new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    what: s.label ?? s.id.slice(0, 12),
    verb: "snapshot",
  }));

  return {
    kicker: "Preview",
    headline: template(snaps.length ? `${snaps.length} workspace snapshots.` : "No snapshots yet."),
    subline: template(`${live.length} live · ${recent.length} recent`),
    live,
    recent,
    foot: `${snaps.length} snapshots · build pipeline pending (see integration-plan §2.8)`,
  };
}

// ── Logs ────────────────────────────────────────────────
export function deriveLogs(input: { audit: RawAuditEvent[] }): LogsView {
  const { audit } = input;
  const sorted = [...audit].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 60);

  return {
    kicker: "Logs",
    headline: template(`${audit.length} events on record.`),
    subline: template("Live tail · audit ledger"),
    rows: sorted.map(e => ({
      id: e.id,
      ts: new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      what: e.summary ?? e.eventType,
      tool: e.detail?.tool ?? e.detail?.toolName ?? e.category ?? "",
    })),
    nextCursor: null,
    foot: `${audit.length} events`,
  };
}

// ── Settings ────────────────────────────────────────────
export function deriveSettings(input: {
  company: RawCompany;
  trustScores?: { agentId: string; score: number; band: string }[];
  heartbeat: RawHeartbeat;
}): SettingsView {
  const c = input.company.company;
  const rows: SettingsView["rows"] = [];
  if (c) {
    rows.push({ id: "company-name", group: "company", label: "Name",   value: c.name,         verb: "edit" });
    rows.push({ id: "company-id",   group: "company", label: "ID",     value: c.id,           verb: "—"    });
    rows.push({ id: "company-stat", group: "company", label: "Status", value: c.status ?? "—", verb: "—"   });
  }
  rows.push({
    id: "hb-status", group: "company", label: "Heartbeat",
    value: input.heartbeat.running ? "live" : "paused",
    verb: `${input.heartbeat.beatCount} beats`,
  });
  // Budget — placeholder until company-level budget exists (integration-plan §2.10).
  rows.push({ id: "budget-month", group: "budget", label: "Monthly cap",     value: "not set", verb: "set" });
  rows.push({ id: "budget-spent", group: "budget", label: "Spent this month", value: "—",       verb: "—"   });

  for (const t of input.trustScores ?? []) {
    rows.push({
      id: `trust-${t.agentId}`,
      group: "trust",
      label: t.agentId,
      value: `${t.band} · ${t.score.toFixed(2)}`,
      verb: "adjust",
    });
  }

  return {
    kicker: "Settings",
    headline: template("Company, budget, and trust."),
    subline: template(`${rows.length} settings`),
    rows,
    foot: "edit takes effect on the next heartbeat",
  };
}

export { type NarrativeText };
