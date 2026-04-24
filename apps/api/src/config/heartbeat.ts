/**
 * Heartbeat scheduler configuration.
 * Controls beat intervals, concurrency, budgets, and pause rules per role.
 */
import type { AgentIdentity } from "@arceus/contracts";
import { readOptionalEnv, readNumberEnv, readListEnv } from "./env";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const defaults = require("./heartbeat.json");

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
    developer:   readNumberEnv("ARCEUS_HEARTBEAT_DEV_INTERVAL_MS", defaults.roleIntervals.developer),
    tester:      readNumberEnv("ARCEUS_HEARTBEAT_TEST_INTERVAL_MS", defaults.roleIntervals.tester),
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

  /** Manually paused roles. */
  pauseRoles: readListEnv("ARCEUS_HEARTBEAT_PAUSE_ROLES", defaults.pauseRoles) as AgentIdentity["role"][],

  /** Feature flag: enable/disable the meeting scheduler entirely. */
  meetingsEnabled: readOptionalEnv("ARCEUS_MEETINGS_ENABLED", "true") === "true",
};
