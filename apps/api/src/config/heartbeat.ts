/**
 * Heartbeat scheduler configuration.
 * Controls beat intervals, concurrency, budgets, and pause rules per role.
 */
import type { AgentIdentity } from "@arceus/contracts";
import { filterValidRoles } from "@arceus/contracts";
import { readOptionalEnv, readNumberEnv, readListEnv } from "./env";
import defaultsRaw from "./heartbeat.json" with { type: "json" };

// `resolveJsonModule` + import-attributes give us a typed defaults object
// in place of the legacy `createRequire("./heartbeat.json")` which
// returned `any` and lit up ~35 no-unsafe-member-access errors. The
// shape is fixed by the JSON file at build time.
interface HeartbeatDefaults {
  executionMode: "orchestrator" | "heartbeat";
  schedulerIntervalMs: number;
  maxConcurrentBeats: number;
  roleIntervals: Record<AgentIdentity["role"], number>;
  beatTimeoutMs: number;
  beatTokenBudget: number;
  beatCostCeilingCents: number;
  idleThresholdTokens: number;
  pauseWhenNoActiveSprint: boolean;
  pauseWhenBudgetExhausted: boolean;
  pauseRoles: AgentIdentity["role"][];
}
const defaults = defaultsRaw as HeartbeatDefaults;

export const heartbeatConfig = {
  /** Execution mode: "orchestrator" (legacy loop) | "heartbeat" (spec 12). */
  executionMode: readOptionalEnv("ARCEUS_EXECUTION_MODE", defaults.executionMode) as "orchestrator" | "heartbeat",

  /** Global interval between scheduler tick checks (ms). */
  schedulerIntervalMs: readNumberEnv("ARCEUS_HEARTBEAT_SCHEDULER_INTERVAL_MS", defaults.schedulerIntervalMs),

  /** Max concurrent beats across all agents. */
  maxConcurrentBeats: readNumberEnv("ARCEUS_HEARTBEAT_MAX_CONCURRENT", defaults.maxConcurrentBeats),

  /** Per-role beat intervals. How often each role wakes up (ms). */
  roleIntervals: {
    ceo:         readNumberEnv("ARCEUS_HEARTBEAT_CEO_INTERVAL_MS", defaults.roleIntervals.ceo),
    cto:         readNumberEnv("ARCEUS_HEARTBEAT_CTO_INTERVAL_MS", defaults.roleIntervals.cto),
    pm:          readNumberEnv("ARCEUS_HEARTBEAT_PM_INTERVAL_MS", defaults.roleIntervals.pm),
    developer:        readNumberEnv("ARCEUS_HEARTBEAT_DEV_INTERVAL_MS", defaults.roleIntervals.developer),
    senior_developer: readNumberEnv("ARCEUS_HEARTBEAT_SENIOR_DEV_INTERVAL_MS", defaults.roleIntervals.senior_developer),
    tester:           readNumberEnv("ARCEUS_HEARTBEAT_TEST_INTERVAL_MS", defaults.roleIntervals.tester),
    ui_designer: readNumberEnv("ARCEUS_HEARTBEAT_UI_INTERVAL_MS", defaults.roleIntervals.ui_designer),
    marketing:   readNumberEnv("ARCEUS_HEARTBEAT_MARKETING_INTERVAL_MS", defaults.roleIntervals.marketing),
    skills_lead: readNumberEnv("ARCEUS_HEARTBEAT_SKILLS_INTERVAL_MS", defaults.roleIntervals.skills_lead),
  } as Record<AgentIdentity["role"], number>,

  /** Max duration for a single beat before timeout (ms). */
  beatTimeoutMs: readNumberEnv("ARCEUS_HEARTBEAT_BEAT_TIMEOUT_MS", defaults.beatTimeoutMs),

  /** Per-beat token budget. Beat must stop if exceeded. */
  beatTokenBudget: readNumberEnv("ARCEUS_HEARTBEAT_BEAT_TOKEN_BUDGET", defaults.beatTokenBudget),

  /** Per-beat cost ceiling (cents). */
  beatCostCeilingCents: readNumberEnv("ARCEUS_HEARTBEAT_BEAT_COST_CEILING_CENTS", defaults.beatCostCeilingCents),

  /** HEARTBEAT_OK token cost threshold. If observation phase uses fewer tokens than this, skip execution. */
  idleThresholdTokens: readNumberEnv("ARCEUS_HEARTBEAT_IDLE_THRESHOLD_TOKENS", defaults.idleThresholdTokens),

  /** Pause heartbeats when no active sprint. */
  pauseWhenNoActiveSprint: readOptionalEnv("ARCEUS_HEARTBEAT_PAUSE_NO_SPRINT", String(defaults.pauseWhenNoActiveSprint)) === "true",

  /** Hard stop at 100% budget. */
  pauseWhenBudgetExhausted: readOptionalEnv("ARCEUS_HEARTBEAT_PAUSE_BUDGET_EXHAUSTED", String(defaults.pauseWhenBudgetExhausted)) === "true",

  /** Manually paused roles. Invalid env values silently dropped (graceful — env vars commonly mistyped). */
  pauseRoles: filterValidRoles(readListEnv("ARCEUS_HEARTBEAT_PAUSE_ROLES", defaults.pauseRoles)),

  /** Feature flag: enable/disable the meeting scheduler entirely. */
  meetingsEnabled: readOptionalEnv("ARCEUS_MEETINGS_ENABLED", "true") === "true",
};
