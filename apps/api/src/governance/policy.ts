/**
 * Governance policy violations — record denied tool calls in the
 * `policy_violations` table.
 *
 * Phase 5 PR #10: spec-32 already emits `tool.denied` events to pino +
 * Langfuse + the inspector ring buffer. This module adds the durable
 * Postgres mirror so the dashboard can paginate violations across
 * sessions without replaying the event stream.
 *
 * Always fire-and-forget: governance enforcement happens in the request
 * path; recording is telemetry.
 */
import { getDb } from "@arceus/db";
import * as policyRepo from "@arceus/db/src/repos/policy_violations.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { toDbId as companyToDbId } from "@arceus/db/src/repos/companies.js";
import postgres from "postgres";

export type DenyReason = "not_in_allowlist" | "role_gate" | "governance_block";
type DenySeverity = "low" | "medium" | "high" | "critical";

interface RecordPolicyDenyInput {
  companyId: string;
  role: string;
  tool: string;
  reason: DenyReason;
  severity?: DenySeverity;
  detail?: string;
  beatId?: string | null;
}

const SEVERITY_FOR_REASON: Record<DenyReason, DenySeverity> = {
  not_in_allowlist: "medium",
  role_gate: "medium",
  governance_block: "high",
};

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

/**
 * Record a governance/allowlist denial. Resolves agent_id by (company, role)
 * lookup; falls back to NULL agent_id + populated agent_role when the agent
 * isn't yet persisted (e.g. pre-strategy denials).
 */
export async function recordPolicyDeny(input: RecordPolicyDenyInput): Promise<void> {
  const db = getDb();
  try {
    const dbCompanyId = companyToDbId(input.companyId);
    const agentDbId = await agentsRepo.resolveAgentDbId(db, dbCompanyId, input.role);
    await policyRepo.recordViolation(db, {
      companyId: dbCompanyId,
      agentId: agentDbId,
      agentRole: input.role,
      ruleId: input.reason,
      tool: input.tool,
      decision: "deny",
      severity: input.severity ?? SEVERITY_FOR_REASON[input.reason],
      detail: input.detail ?? "",
      // beatId stays NULL until run-beat dual-writes heartbeat_runs (PR #11).
      beatId: null,
    });
  } catch (err) {
    console.warn(
      `[policy] deny record skipped for ${input.companyId}/${input.role}/${input.tool} (pg=${pgErrorCode(err)})`,
    );
  }
}
