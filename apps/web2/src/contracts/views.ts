/** Per-view shapes. UI components consume these — never raw API responses. */
import { z } from "zod";
import { narrativeTextSchema, tabIdSchema } from "./view.js";

// ── Shell ───────────────────────────────────────────────
export const shellSchema = z.object({
  brand: z.object({ initial: z.string(), name: z.string() }).nullable(),
  tabs: z.array(
    z.object({
      id: tabIdSchema,
      label: z.string(),
      group: z.enum(["company", "knowledge", "for-you"]),
      count: z.string().nullable(),
      live: z.boolean().default(false),
    }),
  ),
  ceo: z.object({ initials: z.string(), name: z.string() }),
  version: z.string(),
});
export type Shell = z.infer<typeof shellSchema>;

// ── Common pip ──────────────────────────────────────────
export const pipSchema = z.enum(["green", "amber", "none"]);
export type Pip = z.infer<typeof pipSchema>;

// ── Today ───────────────────────────────────────────────
export const todayDecisionSchema = z.object({
  id: z.string(),
  who: z.string(),                   // "Marketing · Lila · 11 minutes"
  ask: narrativeTextSchema,
  why: narrativeTextSchema,
  pip: pipSchema,
  primaryAction: z.string(),         // label
});
export const todayWorkingSchema = z.object({
  agentId: z.string(),
  who: z.string(),
  ask: narrativeTextSchema,
  why: narrativeTextSchema,
  pip: pipSchema,
});
export const todayMemorySchema = z.object({
  text: z.string(),
  cite: z.string(),
});
export const todayViewSchema = z.object({
  kicker: z.string(),                // "Thursday, Sprint 14, day 4"
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  mode: z.enum(["bootstrap", "chat"]),
  companyName: z.string().nullable(),
  needs: z.array(todayDecisionSchema),
  working: z.array(todayWorkingSchema),
  forming: z.array(todayMemorySchema),
});
export type TodayView = z.infer<typeof todayViewSchema>;

// ── Sprint ──────────────────────────────────────────────
export const sprintTaskRowSchema = z.object({
  id: z.string(),
  status: z.enum(["done", "now", "next"]),
  title: z.string(),
  role: z.string(),                  // "Engineering" — inline, not a section
  agent: z.string().nullable(),      // "Ada" or null if unassigned
  verb: z.string(),                  // "shipped", "writing", "queued"…
});
export const sprintViewSchema = z.object({
  kicker: z.string(),                // "Sprint 14, day 4 of 7"
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  progressPct: z.number().min(0).max(100),
  rows: z.array(sprintTaskRowSchema),
  foot: z.string(),
});
export type SprintView = z.infer<typeof sprintViewSchema>;

// ── Team ────────────────────────────────────────────────
export const teamWorkingSchema = z.object({
  agentId: z.string(),
  who: z.string(),                   // "Engineering · Ada · 3 minutes"
  ask: narrativeTextSchema,
  why: narrativeTextSchema,
  pip: pipSchema,
});
export const teamRestingSchema = z.object({
  agentId: z.string(),
  role: z.string(),
  name: z.string(),
  idleFor: z.string(),               // "idle 47m"
});
export const teamViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  working: z.array(teamWorkingSchema),
  resting: z.array(teamRestingSchema),
  foot: z.string(),
});
export type TeamView = z.infer<typeof teamViewSchema>;

// ── Memory ──────────────────────────────────────────────
export const memoryRowSchema = z.object({
  id: z.string(),
  role: z.string(),                  // "Otto"
  text: z.string(),
  verb: z.string(),                  // "filed 2h ago"
});
export const memoryFormingSchema = z.object({
  id: z.string(),
  text: z.string(),
  cite: z.string(),
});
export const memoryViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  forming: z.array(memoryFormingSchema),
  recent: z.array(memoryRowSchema),
  foot: z.string(),
});
export type MemoryView = z.infer<typeof memoryViewSchema>;

// ── Skills ──────────────────────────────────────────────
export const skillFormingSchema = z.object({
  id: z.string(),
  who: z.string(),                   // "Drafting · Quality · tried 4 times"
  ask: narrativeTextSchema,
  why: narrativeTextSchema,
  pip: pipSchema,
  canPromote: z.boolean(),
});
export const skillLibraryRowSchema = z.object({
  id: z.string(),
  version: z.string(),               // "v3 · new" or "v2"
  name: z.string(),
  usage: z.string(),                 // "used 14×"
});
export const skillLifecycleStageSchema = z.object({
  step: z.string(),                  // "1. Try"
  what: z.string(),
  state: z.string(),                 // "draft" / "v1" / "archived"
});
export const skillsViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  forming: z.array(skillFormingSchema),
  library: z.array(skillLibraryRowSchema),
  lifecycle: z.array(skillLifecycleStageSchema),
  foot: z.string(),
});
export type SkillsView = z.infer<typeof skillsViewSchema>;

// ── Meetings ────────────────────────────────────────────
export const meetingRowSchema = z.object({
  id: z.string(),
  who: z.string(),                   // "Tue · 09:30 · Ada, Otto, Lila, June"
  ask: narrativeTextSchema,
  why: narrativeTextSchema,          // the decision
  hasTranscript: z.boolean(),
});
export const meetingsViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  meetings: z.array(meetingRowSchema),
  foot: z.string(),
});
export type MeetingsView = z.infer<typeof meetingsViewSchema>;

// ── Inbox ───────────────────────────────────────────────
export const inboxWaitingSchema = z.object({
  id: z.string(),
  who: z.string(),
  ask: narrativeTextSchema,
  why: narrativeTextSchema,
  pip: pipSchema,
});
export const inboxClearedSchema = z.object({
  id: z.string(),
  ts: z.string(),                    // "11:42"
  what: z.string(),
  verb: z.string(),                  // "approved" / "held"
});
export const inboxViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  waiting: z.array(inboxWaitingSchema),
  cleared: z.array(inboxClearedSchema),
  foot: z.string(),
});
export type InboxView = z.infer<typeof inboxViewSchema>;

// ── Preview ─────────────────────────────────────────────
export const previewBuildSchema = z.object({
  id: z.string(),
  who: z.string(),                   // "Production · build 482"
  ask: narrativeTextSchema,
  why: narrativeTextSchema,
  publicUrl: z.string().nullable(),
  canRollback: z.boolean(),
  pip: pipSchema,
});
export const previewDeploySchema = z.object({
  id: z.string(),
  ts: z.string(),
  what: z.string(),
  verb: z.string(),
});
export const previewViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  live: z.array(previewBuildSchema),
  recent: z.array(previewDeploySchema),
  foot: z.string(),
});
export type PreviewView = z.infer<typeof previewViewSchema>;

// ── Logs ────────────────────────────────────────────────
export const logRowSchema = z.object({
  id: z.string(),
  ts: z.string(),
  what: z.string(),
  tool: z.string(),                  // "tool: web_search" — already lowercased
});
export const logsViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  rows: z.array(logRowSchema),
  nextCursor: z.string().nullable(),
  foot: z.string(),
});
export type LogsView = z.infer<typeof logsViewSchema>;

// ── Settings ────────────────────────────────────────────
export const settingsRowSchema = z.object({
  id: z.string(),
  group: z.enum(["company", "budget", "trust"]),
  label: z.string(),
  value: z.string(),
  verb: z.string(),                  // "edit"
});
export const settingsViewSchema = z.object({
  kicker: z.string(),
  headline: narrativeTextSchema,
  subline: narrativeTextSchema,
  rows: z.array(settingsRowSchema),
  foot: z.string(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;
