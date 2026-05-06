/**
 * §Strategy — strategy_apply tool route.
 * Lets the CEO agent provision the org chart after the board approves a hiring slate.
 * The agent reasons about *when* to call this — the orchestrator never triggers it.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyStrategyTx } from "../../sprints/strategy.js";
import { enforceMandatoryRoles, strategyOutputSchema } from "../../agents/ceo.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { failure, success } from "./envelope.js";
import { audit } from "../../observability/audit-ledger.js";

const STRATEGY_BASE = "/api/internal/v1/strategy";

export default async function internalMcpStrategyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /strategy/apply — CEO applies an approved strategy to provision agents.
   *
   * Accepts the same shape as strategyOutputSchema. The route deterministically
   * injects missing mandatory roles via enforceMandatoryRoles before handing
   * off to applyStrategyTx, which is a single-transaction atomic write.
   */
  app.post(`${STRATEGY_BASE}/apply`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(
        failure(
          "Only the CEO role may apply a strategy.",
          "governance",
          "never",
          "role_is_ceo",
        ),
      );
    }

    const parsed = strategyOutputSchema.safeParse(req.body);
    if (!parsed.success) {
      // Echo zod issues so the CEO agent can self-correct on retry —
      // mirrors the self-heal loop in generateStrategy(). Without this,
      // the agent loops forever trying random payload variants because
      // the only feedback is an opaque "Invalid strategy payload."
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .slice(0, 6)
        .join("; ");
      return reply.code(422).send(
        failure(
          `Invalid strategy payload — ${detail}`,
          "validation",
          "never",
          "payload_fixed",
        ),
      );
    }

    const companyId = req.mcp.companyId;
    const input = {
      ...parsed.data,
      roles: enforceMandatoryRoles(parsed.data.roles),
    };

    try {
      const result = await applyStrategyTx(companyId, input);
      audit({
        companyId,
        category: "board",
        eventType: "strategy_applied",
        summary: `Strategy applied — ${result.agents.length} agents provisioned via CEO tool call.`,
      });

      const snapshot = await buildSnapshotView(companyId);
      return reply.code(200).send(
        success(`Team provisioned: ${result.agents.length} agents created.`, {
          agentCount: result.agents.length,
          agents: result.agents.map((a) => ({ role: a.role, title: a.title, name: a.name })),
          companyStatus: snapshot.company.status,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log?.error?.(err, "strategy_apply failed");
      return reply.code(500).send(
        failure(`Strategy application failed: ${msg}`, "internal", "safe", "root_cause_fixed"),
      );
    }
  });
}
