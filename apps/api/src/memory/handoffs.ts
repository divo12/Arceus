import type { AgentIdentity, Approval, Task } from "@arceus/contracts";
import { getAgentByRole, uniqueStrings } from "@arceus/task-engine";
import { getSnapshot, upsertApproval, updateApproval } from "../persistence/store.js";
import { enrichRoleMemory } from "./operations.js";
import { emitReactive } from "../orchestration/reactive.js";
import { artifacts } from "../orchestration/state.js";

// ─────────────────────────────────────────────────────────────────────────────
// Post-specialist memory handoffs
// ─────────────────────────────────────────────────────────────────────────────

/** Inject UI Designer design specs into developer and tester memory after delivery. */
export function deliverUiDesignerMemoryHandoff(task: Task, artifactId: string) {
  const artifact = artifacts.find((a) => a.id === artifactId);
  const designContent = artifact?.content
    ? artifact.content.slice(0, 4000)
    : `(Design artifact ${artifactId} content not available — request review from UI Designer.)`;

  const guidance = [
    `UI Designer delivered design direction for "${task.title}".`,
    `IMPORTANT: Follow these design specs exactly when implementing UI components.`,
    `--- BEGIN DESIGN SPECS ---`,
    designContent,
    `--- END DESIGN SPECS ---`,
  ].join("\n");

  const qaGuidance = `Verify UI implementation matches the design direction in artifact ${artifactId} for ${task.title}. Check: layout structure, color tokens, component states, responsive behavior.`;

  enrichRoleMemory("developer", {
    currentFocus: [guidance],
    recentLearnings: [guidance],
    activePatterns: ["Follow UI Designer design specs exactly — use specified colors, spacing, typography, and component hierarchy."],
  });
  enrichRoleMemory("tester", {
    currentFocus: [qaGuidance],
    recentLearnings: [qaGuidance],
    activePatterns: ["QA should include design-direction checks alongside functional verification."],
  });
}

/** Inject Skills Lead skill-package availability into CTO, developer, and tester memory. */
export function deliverSkillsLeadMemoryHandoff(task: Task, artifactId: string, skillPath: string) {
  const handoff = `Reusable skill package ${skillPath} was authored from ${task.title}. Supporting artifact: /api/artifacts/${artifactId}.`;

  enrichRoleMemory("cto", {
    currentFocus: [handoff],
    recentLearnings: [handoff],
    activePatterns: ["Codify repeated specialist work into reusable internal skills before scaling execution."],
  });
  enrichRoleMemory("developer", {
    recentLearnings: [handoff],
    activePatterns: ["Check .arceus/skills for reusable delivery workflows before starting implementation."],
  });
  enrichRoleMemory("tester", {
    recentLearnings: [handoff],
    activePatterns: ["Check .arceus/skills for reusable QA workflows before verification."],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketing external approval flow
// ─────────────────────────────────────────────────────────────────────────────

/** Create a pending board approval for marketing external/outbound actions. */
export function createMarketingExternalApproval(task: Task, artifactId: string, meetingId: string | null) {
  const snapshot = getSnapshot();
  const marketingAgent = getAgentByRole(snapshot, "marketing");
  if (!marketingAgent) {
    return null;
  }

  const approval: Approval = {
    id: `approval_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    type: "external_action",
    status: "pending",
    title: `Board approval required for ${task.title}`,
    description: `Marketing prepared outbound launch or distribution recommendations in /api/artifacts/${artifactId}. No external action has been executed. Board approval is required before any distribution proceeds.`,
    requestedByAgentId: marketingAgent.id,
    meetingId,
    agendaItemId: null,
    resolutionSummary: null,
  };

  upsertApproval(approval);
  return approval;
}

/** Approve all pending board approvals and emit reactive events to requestors. */
export function approvePendingBoardApprovals() {
  const pendingApprovals = getSnapshot().approvals.filter((approval) => approval.status === "pending");

  for (const approval of pendingApprovals) {
    updateApproval(approval.id, (current) => ({
      ...current,
      status: current.type === "external_action" ? "approved" : "applied",
      resolutionSummary: current.type === "external_action"
        ? "Board approved the recommended external action. No automated outbound action was executed by Arceus."
        : "Board approved the pending request during CTO handoff review.",
    }));

    const snap = getSnapshot();
    const requestor = snap.agents.find((a: { id: string; role: AgentIdentity["role"] }) => a.id === approval.requestedByAgentId);
    if (requestor) {
      emitReactive(requestor.role, "approval_granted");
    }
  }

  return pendingApprovals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Specialist meeting context (shapes data for recordMeeting after specialist)
// ─────────────────────────────────────────────────────────────────────────────

/** Build participant roles and learning entries for a post-specialist handoff meeting. */
export function getSpecialistMeetingContext(role: AgentIdentity["role"], task: Task, artifactId: string) {
  if (role === "ui_designer") {
    return {
      participantRoles: uniqueStrings([role, "developer", "tester", "cto"]) as AgentIdentity["role"][],
      managerRole: "cto" as const,
      learnings: [
        {
          role: "developer" as const,
          content: `UI Designer attached design direction artifact /api/artifacts/${artifactId} for ${task.title}.`,
        },
        {
          role: "tester" as const,
          content: `QA should verify ${task.title} against UI direction artifact /api/artifacts/${artifactId}.`,
        },
        {
          role: "cto" as const,
          content: `Design direction artifact /api/artifacts/${artifactId} is available for downstream implementation and QA.`,
        },
      ],
    };
  }

  if (role === "marketing") {
    return {
      participantRoles: uniqueStrings([role, "pm", "ceo"]) as AgentIdentity["role"][],
      managerRole: "ceo" as const,
      learnings: [
        {
          role: "pm" as const,
          content: `Marketing attached launch-readiness artifact /api/artifacts/${artifactId} for ${task.title}.`,
        },
        {
          role: "ceo" as const,
          content: task.kind === "distribution_campaign"
            ? `Outbound distribution recommendations in /api/artifacts/${artifactId} require board approval before execution.`
            : `Launch-readiness content in /api/artifacts/${artifactId} is ready for release planning review.`,
        },
      ],
    };
  }

  if (role === "skills_lead") {
    return {
      participantRoles: uniqueStrings([role, "cto", "developer", "tester"]) as AgentIdentity["role"][],
      managerRole: "cto" as const,
      learnings: [
        {
          role: "cto" as const,
          content: `Skills Lead authored a reusable skill package for ${task.title}.`,
        },
        {
          role: "developer" as const,
          content: `A new reusable skill package is available for downstream implementation support from ${task.title}.`,
        },
        {
          role: "tester" as const,
          content: `A new reusable skill package is available for downstream QA support from ${task.title}.`,
        },
      ],
    };
  }

  if (role === "tester") {
    const participantRoles = uniqueStrings([role, "developer", "pm", "cto"]) as AgentIdentity["role"][];
    return {
      participantRoles,
      managerRole: "cto" as const,
      learnings: [
        {
          role: "developer" as const,
          content: `Tester attached verification artifact /api/artifacts/${artifactId} for ${task.title}.`,
        },
        {
          role: "pm" as const,
          content: `Tester produced verification evidence for ${task.title} and highlighted release readiness implications.`,
        },
        {
          role: "cto" as const,
          content: `Tester verification artifact /api/artifacts/${artifactId} is available for technical review.`,
        },
      ],
    };
  }

  const managerRole: AgentIdentity["role"] = "cto";
  return {
    participantRoles: [role, managerRole],
    managerRole,
    learnings: [
      {
        role: managerRole,
        content: `${role.replace(/_/g, " ")} delivered artifact ${task.title} for downstream review.`,
      },
    ],
  };
}
