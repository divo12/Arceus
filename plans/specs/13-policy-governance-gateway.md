# Spec 13: Policy-as-Code Governance Gateway

> Status: DRAFT
> Last updated: 2026-04-14
> Depends on: Spec 11 (Control Plane — Audit Ledger, Service Registry), Spec 12 (Heartbeat)
> Enables: Spec 14 (Self-Evolution — policy-gated mutation), Spec 15 (Long-Horizon — auto-approval)

## Carried Forward from Spec 12

> The following items were deferred from Spec 12 (Heartbeat) because they require
> the Governance Gateway to be meaningful:
>
> 1. **Tool call routing through Governance Gateway** — Spec 12 Phase 3 (Execute) states
>    "All tool calls go through Governance Gateway (Spec 13)". Currently tool calls go
>    directly to OpenCode/service registry with no policy enforcement. Wire the gateway
>    as an interceptor between agent LLM sessions and tool execution.
>
> 2. **trustFactor refinement** — `AgentBeatContext.trustFactor` is hardcoded to `1.0` in
>    `cpLoadAgentContext()`. Populate from the Governance Gateway's trust scoring system
>    based on agent policy violation history.
>
> 3. **checkBuildStatus integration** — CTO and Developer checklists have a stub
>    `checkBuildStatus()` that returns "Build check not yet wired". This needs workspace
>    integration (shell exec `npm run build`) which should route through the gateway.

## What This Is

Today, agent authority is enforced by prompt text. The CEO's SOUL says "you cannot write code" — but nothing actually stops the LLM from emitting a `file_write` tool call. The PM "can't run shell commands" — but that's a gentleman's agreement with a probabilistic text generator.

This spec replaces prompt-based guardrails with **deterministic, compiled policy enforcement**. A Governance Gateway sits between every agent and every tool. The agent proposes a tool call; the gateway evaluates typed policy rules; the tool either executes or gets blocked. The LLM cannot "sweet-talk" past a TypeScript function that returns `false`.

## Why This Matters

```
WITHOUT governance gateway:
  CEO agent → LLM hallucinates "rm -rf /workspace" → executes → catastrophe

WITH governance gateway:
  CEO agent → LLM proposes "rm -rf /workspace"
  → Gateway: role=ceo, tool=shell_exec → DENY (ceo.canRunShell = false)
  → Tool blocked. Agent receives structured error.
  → AuditLedger: policy_violation recorded.
  → TrustFactor: CEO trust score decremented.
```

The gateway doesn't just protect against hallucinations. It enforces:
- **Least privilege**: Agents only have tools they need
- **Blast-radius containment**: Dangerous tools require approval before execution
- **Accountability**: Every allow/deny is recorded in the Audit Ledger
- **Adaptive trust**: Agents who violate policies lose tool access over time

## Architecture

```
Agent LLM Session (OpenCode)
    │
    │ Agent wants to invoke: file_write("/workspace/src/auth.ts", content)
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│                    GOVERNANCE GATEWAY                             │
│                                                                  │
│   Step 1: IDENTIFY                                               │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ Who: agentId=jules, role=developer                      │   │
│   │ What: tool=file_write, path="/workspace/src/auth.ts"    │   │
│   │ Beat: beatId=abc123                                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│   Step 2: CLASSIFY (Service Registry)                            │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ file_write → blast_radius: "yellow" (state-changing,    │   │
│   │              reversible via git)                         │   │
│   │ Allowed roles: [developer, cto, tester, ui_designer,    │   │
│   │                  skills_lead]                            │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│   Step 3: EVALUATE POLICIES                                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ Rule 1: developer CAN file_write → MATCH                │   │
│   │ Rule 2: path must start with /workspace → PASS          │   │
│   │ Rule 3: file not in protected list → PASS               │   │
│   │ Rule 4: agent trust >= 0.3 → PASS (trust=0.8)          │   │
│   │ Decision: ALLOW                                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│   Step 4: AUDIT                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ AuditLedger.append({                                    │   │
│   │   category: "policy_eval",                              │   │
│   │   toolName: "file_write",                               │   │
│   │   policyDecision: "allow",                              │   │
│   │   policyRule: "developer.canEditFiles"                  │   │
│   │ })                                                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│   Step 5: EXECUTE or BLOCK                                       │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ Decision: ALLOW → forward tool call to Execution        │   │
│   │           DENY  → return structured error to agent      │   │
│   │           ESCALATE → pause beat, create approval        │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                               ▼
                    Tool Execution (OpenCode)
```

## Policy Engine

### Policy Rule Schema

Policies are TypeScript objects, not natural language. They compile, they type-check, they're deterministic.

```typescript
// packages/company-runtime/src/governance-gateway.ts

interface PolicyRule {
  id: string;
  name: string;
  description: string;
  priority: number;                     // lower number = higher priority

  /** Which roles this rule applies to. Empty = all roles. */
  roles: RoleSoul["role"][];

  /** Which tools this rule governs. Empty = all tools. */
  tools: string[];

  /** Condition function. Receives full context, returns boolean.
   *  If returns true, the effect applies. */
  condition: (ctx: PolicyEvalContext) => boolean;

  /** What happens when condition is true. */
  effect: "allow" | "deny" | "escalate";

  /** Human-readable reason (for audit log and agent error messages). */
  reason: string;
}

interface PolicyEvalContext {
  // Who
  agentId: string;
  agentRole: RoleSoul["role"];
  agentTrust: number;                   // 0.0 - 1.0

  // What
  toolName: string;
  toolParameters: Record<string, unknown>;
  blastRadius: "green" | "yellow" | "red";

  // When
  beatId: string;
  companyId: string;
  currentSprintStatus: string;

  // Environment
  companyBudgetRemainingCents: number;
  companyStatus: string;
}

type PolicyDecision = {
  effect: "allow" | "deny" | "escalate";
  matchedRule: PolicyRule;
  evaluatedRules: number;
  evaluationTimeMs: number;
};
```

### Built-in Policy Rules

These are the baseline rules that enforce what SOUL prompts today only suggest:

```typescript
// packages/company-runtime/src/policies/base-policies.ts

export const BASE_POLICIES: PolicyRule[] = [

  // ─── ROLE-BASED TOOL ACCESS ───────────────────────────────

  {
    id: "ceo-no-code",
    name: "CEO cannot write code",
    description: "CEO role has no file editing or shell access",
    priority: 1,
    roles: ["ceo"],
    tools: ["file_write", "file_edit", "file_delete", "shell_exec", "git_commit"],
    condition: () => true,  // always applies for CEO + these tools
    effect: "deny",
    reason: "CEO role does not have code/file/shell authority. Delegate to CTO or Developer."
  },

  {
    id: "pm-no-code",
    name: "PM cannot write code or run shell",
    description: "PM role focuses on specs and acceptance criteria",
    priority: 1,
    roles: ["pm"],
    tools: ["file_write", "file_edit", "file_delete", "shell_exec"],
    condition: () => true,
    effect: "deny",
    reason: "PM role does not have code or shell authority. Delegate to Developer."
  },

  {
    id: "marketing-no-shell",
    name: "Marketing cannot run shell commands",
    priority: 1,
    roles: ["marketing"],
    tools: ["shell_exec"],
    condition: () => true,
    effect: "deny",
    reason: "Marketing role cannot run shell commands."
  },

  // ─── PATH CONTAINMENT ─────────────────────────────────────

  {
    id: "workspace-boundary",
    name: "File operations must stay within /workspace",
    description: "Prevents agents from modifying system files",
    priority: 0,  // highest priority
    roles: [],    // all roles
    tools: ["file_write", "file_edit", "file_delete"],
    condition: (ctx) => {
      const path = ctx.toolParameters["path"] as string || "";
      // Normalize and check path doesn't escape workspace
      const normalized = path.replace(/\\/g, "/");
      return !normalized.startsWith("/workspace") &&
             !normalized.startsWith("workspace/") &&
             normalized !== "workspace";
    },
    effect: "deny",
    reason: "File operations must target /workspace directory."
  },

  {
    id: "protected-files",
    name: "Cannot modify protected configuration files",
    priority: 0,
    roles: [],
    tools: ["file_write", "file_edit", "file_delete"],
    condition: (ctx) => {
      const path = ctx.toolParameters["path"] as string || "";
      const protectedPaths = [
        "package.json",       // only CTO should touch this
        ".env",               // secrets
        ".env.local",
        "tsconfig.json",
      ];
      // Allow CTO to edit package.json
      if (ctx.agentRole === "cto") return false;
      return protectedPaths.some(p => path.endsWith(p));
    },
    effect: "deny",
    reason: "This file is protected. Only CTO can modify configuration files."
  },

  // ─── SHELL COMMAND RESTRICTIONS ────────────────────────────

  {
    id: "dangerous-commands",
    name: "Block destructive shell commands",
    priority: 0,
    roles: [],
    tools: ["shell_exec"],
    condition: (ctx) => {
      const cmd = (ctx.toolParameters["command"] as string || "").toLowerCase();
      const dangerous = [
        "rm -rf /", "rm -rf ~", "rm -rf .",
        "dd if=", "mkfs.", ":(){ :|:& };:",
        "> /dev/sd", "chmod -R 777",
        "curl | sh", "wget | sh",
        "sudo ", "su ",
        "DROP TABLE", "DROP DATABASE", "DELETE FROM",
        "npm publish", "npx publish",
      ];
      return dangerous.some(d => cmd.includes(d));
    },
    effect: "deny",
    reason: "This command is classified as destructive and is blocked by policy."
  },

  {
    id: "install-commands-escalate",
    name: "Package installations require CTO confirmation",
    priority: 5,
    roles: ["developer", "tester"],
    tools: ["shell_exec"],
    condition: (ctx) => {
      const cmd = (ctx.toolParameters["command"] as string || "").toLowerCase();
      return cmd.includes("npm install") || cmd.includes("yarn add") ||
             cmd.includes("pnpm add") || cmd.includes("pip install");
    },
    effect: "escalate",
    reason: "Package installations must be approved. Creating escalation to CTO."
  },

  // ─── BLAST-RADIUS GATES ────────────────────────────────────

  {
    id: "red-tools-require-approval",
    name: "High-impact tools require board approval",
    priority: 2,
    roles: [],
    tools: [],  // applies to all tools classified as "red"
    condition: (ctx) => ctx.blastRadius === "red",
    effect: "escalate",
    reason: "This action has high blast radius and requires board approval."
  },

  // ─── TRUST-BASED RESTRICTIONS ──────────────────────────────

  {
    id: "low-trust-deny-yellow",
    name: "Low-trust agents lose state-changing tool access",
    priority: 3,
    roles: [],
    tools: [],
    condition: (ctx) => ctx.agentTrust < 0.3 && ctx.blastRadius !== "green",
    effect: "deny",
    reason: "Agent trust score too low for state-changing operations. Trust must be above 0.3."
  },

  {
    id: "medium-trust-escalate-yellow",
    name: "Medium-trust agents need confirmation for state changes",
    priority: 4,
    roles: [],
    tools: [],
    condition: (ctx) => ctx.agentTrust < 0.5 && ctx.blastRadius === "yellow",
    effect: "escalate",
    reason: "Agent trust score requires oversight for state-changing operations."
  },

  // ─── BUDGET ENFORCEMENT ────────────────────────────────────

  {
    id: "budget-exhausted",
    name: "Block all actions when budget is exhausted",
    priority: 0,
    roles: [],
    tools: [],
    condition: (ctx) => ctx.companyBudgetRemainingCents <= 0,
    effect: "deny",
    reason: "Company budget exhausted. All agent execution halted. Board must add funds."
  },
];
```

### Policy Evaluation Algorithm

Policies are evaluated in **priority order** (lowest number first). First matching rule wins.

```typescript
function evaluatePolicy(
  ctx: PolicyEvalContext,
  rules: PolicyRule[]
): PolicyDecision {
  const startTime = Date.now();
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  let evaluated = 0;
  for (const rule of sorted) {
    // Skip rules that don't match this role
    if (rule.roles.length > 0 && !rule.roles.includes(ctx.agentRole)) continue;
    // Skip rules that don't match this tool
    if (rule.tools.length > 0 && !rule.tools.includes(ctx.toolName)) continue;

    evaluated++;

    if (rule.condition(ctx)) {
      return {
        effect: rule.effect,
        matchedRule: rule,
        evaluatedRules: evaluated,
        evaluationTimeMs: Date.now() - startTime,
      };
    }
  }

  // No rule matched → default ALLOW (open by default, deny explicitly)
  return {
    effect: "allow",
    matchedRule: { id: "__default__", name: "Default allow" } as PolicyRule,
    evaluatedRules: evaluated,
    evaluationTimeMs: Date.now() - startTime,
  };
}
```

## Blast-Radius Classification

Every tool is classified by its potential impact:

```typescript
// packages/company-runtime/src/blast-radius.ts

type BlastRadius = "green" | "yellow" | "red";

/**
 * Green:  Read-only, no state changes. Auto-execute, minimal audit.
 * Yellow: State-changing but reversible. Execute + full audit.
 * Red:    Irreversible or high-impact. Requires board approval.
 */

const TOOL_BLAST_RADIUS: Record<string, BlastRadius> = {
  // ─── GREEN (read-only) ────────────────────────────────
  "file_read":          "green",
  "directory_list":     "green",
  "search_files":       "green",
  "grep":               "green",
  "git_log":            "green",
  "git_diff":           "green",
  "git_status":         "green",

  // ─── YELLOW (state-changing, reversible) ──────────────
  "file_write":         "yellow",
  "file_edit":          "yellow",
  "file_delete":        "yellow",
  "shell_exec":         "yellow",   // most commands, elevated by content policies
  "git_commit":         "yellow",
  "git_branch":         "yellow",
  "npm_install":        "yellow",
  "npm_run":            "yellow",

  // ─── RED (irreversible or high-impact) ────────────────
  "git_push":           "red",     // pushes to remote — irreversible
  "git_force_push":     "red",
  "deploy":             "red",     // production deployment
  "database_migrate":   "red",     // schema changes
  "external_api_call":  "red",     // calls to external services (email, payment, etc.)
  "agent_hire":         "red",     // creating new agent identity
  "agent_terminate":    "red",     // removing agent
  "budget_modify":      "red",     // changing company budget
  "strategy_approve":   "red",     // auto-approving strategy (should be board)
};
```

## Trust Factor System

Each agent has a dynamic trust score that influences what they're allowed to do.

```typescript
// packages/company-runtime/src/trust-factor.ts

interface TrustFactor {
  agentId: string;
  companyId: string;
  score: number;                        // 0.0 - 1.0
  history: TrustEvent[];                // last 50 events
  updatedAt: string;
}

interface TrustEvent {
  type: "policy_violation" | "policy_compliance" | "task_success" | "task_failure"
      | "manual_adjustment";
  delta: number;                        // positive or negative
  reason: string;
  occurredAt: string;
}

const TRUST_CONFIG = {
  /** Starting trust for new agents. */
  initialTrust: 0.7,                    // medium-high — assume good faith

  /** Trust delta for events. */
  deltas: {
    policy_violation:  -0.15,           // significant drop
    policy_compliance:  0.01,           // slow recovery (builds trust gradually)
    task_success:       0.02,           // small positive
    task_failure:      -0.05,           // moderate negative
    manual_adjustment:  0.0,            // set explicitly by board
  },

  /** Trust floor and ceiling. */
  min: 0.0,
  max: 1.0,

  /** Trust thresholds for policy effects. */
  thresholds: {
    /** Below this: denied all non-green tools. Agent effectively read-only. */
    critical: 0.3,
    /** Below this: yellow tools require escalation. */
    restricted: 0.5,
    /** Above this: full access within role permissions. */
    trusted: 0.7,
    /** Above this: eligible for expanded autonomy (Spec 15 auto-approvals). */
    autonomous: 0.9,
  },

  /** Max events to retain in history. */
  maxHistory: 50,
};

function adjustTrust(
  current: TrustFactor,
  event: Omit<TrustEvent, "occurredAt">
): TrustFactor {
  const newScore = Math.max(
    TRUST_CONFIG.min,
    Math.min(TRUST_CONFIG.max, current.score + event.delta)
  );
  return {
    ...current,
    score: newScore,
    history: [
      ...current.history.slice(-(TRUST_CONFIG.maxHistory - 1)),
      { ...event, occurredAt: new Date().toISOString() }
    ],
    updatedAt: new Date().toISOString(),
  };
}
```

### Trust Tier Behaviors

```
┌─────────────────────────────────────────────────────────────────────┐
│ Score  │ Tier       │ Green Tools │ Yellow Tools │ Red Tools        │
├────────┼────────────┼─────────────┼──────────────┼──────────────────┤
│ 0.9+   │ Autonomous │ ✅ Allow    │ ✅ Allow     │ ⚠️ Escalate      │
│ 0.7-0.9│ Trusted    │ ✅ Allow    │ ✅ Allow     │ ⚠️ Escalate      │
│ 0.5-0.7│ Standard   │ ✅ Allow    │ ✅ Allow     │ ⚠️ Escalate      │
│ 0.3-0.5│ Restricted │ ✅ Allow    │ ⚠️ Escalate  │ 🚫 Deny          │
│ 0.0-0.3│ Critical   │ ✅ Allow    │ 🚫 Deny      │ 🚫 Deny          │
└─────────────────────────────────────────────────────────────────────┘
```

## Escalation Protocol

When a policy evaluates to `escalate`, the gateway doesn't just log a warning. It **hard-pauses** the agent's heartbeat and creates a first-class approval:

```typescript
async function handleEscalation(
  ctx: PolicyEvalContext,
  decision: PolicyDecision,
  auditLedger: AuditLedger,
  controlPlane: ControlPlane
): Promise<void> {
  // 1. Record the escalation in audit
  await auditLedger.append({
    companyId: ctx.companyId,
    agentId: ctx.agentId,
    category: "policy_eval",
    eventType: "policy_checked",
    toolName: ctx.toolName,
    toolParameters: ctx.toolParameters,
    policyRule: decision.matchedRule.id,
    policyDecision: "escalate",
    policyReason: decision.matchedRule.reason,
    summary: `${ctx.agentRole} attempted ${ctx.toolName} — escalated to board`,
    correlationId: ctx.beatId,
    causationId: null,
    occurredAt: new Date().toISOString(),
  });

  // 2. Create a board approval request
  await controlPlane.applyMutations(
    ctx.companyId,
    [{
      type: "approval_create",
      approval: {
        companyId: ctx.companyId,
        type: "external_action",
        status: "pending",
        title: `${ctx.agentRole} requests: ${ctx.toolName}`,
        description: [
          `Agent ${ctx.agentId} (${ctx.agentRole}) wants to execute:`,
          `Tool: ${ctx.toolName}`,
          `Parameters: ${JSON.stringify(ctx.toolParameters, null, 2)}`,
          ``,
          `Policy rule: ${decision.matchedRule.name}`,
          `Reason: ${decision.matchedRule.reason}`,
          ``,
          `Agent trust score: ${ctx.agentTrust.toFixed(2)}`,
        ].join("\n"),
        requestedByAgentId: ctx.agentId,
      }
    }],
    {
      eventId: crypto.randomUUID(),
      companyId: ctx.companyId,
      eventType: "escalation_created",
      summary: `Escalation: ${ctx.agentRole} → ${ctx.toolName}`,
      occurredAt: new Date().toISOString(),
    } as EventEnvelope
  );

  // 3. Notify CEO to inform the board
  // CEO's next heartbeat will see the pending approval and communicate it

  // 4. Agent's current beat ends with status "escalated"
  // The tool call is NOT executed
  // When board approves, an event trigger wakes the agent
}
```

## Dashboard Integration

The board needs to see policy events without cognitive overload:

```
┌──────────────────────────────────────────────────────────────┐
│  GOVERNANCE PANEL (collapsible, below CEO chat)              │
│                                                              │
│  🟢 Trust Scores                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Lin (CTO)       ████████████████████░░   0.91       │    │
│  │ Mina (PM)       ██████████████████░░░░   0.85       │    │
│  │ Jules (Dev)     ████████████████░░░░░░   0.78       │    │
│  │ Quinn (Tester)  ██████████████████████   0.95       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ⚠️ Pending Approvals (1)                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Jules wants to run: npm install jsonwebtoken         │    │
│  │ Policy: install-commands-escalate                    │    │
│  │ [Approve] [Deny]                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  📋 Recent Policy Events (last 10)                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 10:23 ✅ Jules file_write auth.ts       [allowed]   │    │
│  │ 10:22 ✅ Jules file_write routes.ts     [allowed]   │    │
│  │ 10:21 ⚠️ Jules npm install jwt          [escalated] │    │
│  │ 10:20 ✅ Lin   file_read package.json   [allowed]   │    │
│  │ 10:15 🚫 Avery file_write README.md    [denied]    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Database Changes

```sql
-- Agent trust scores
CREATE TABLE trust_scores (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  score REAL NOT NULL DEFAULT 0.7,          -- initial trust
  history JSONB NOT NULL DEFAULT '[]',      -- last 50 TrustEvent entries
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policy violation log (denormalized from audit_events for fast querying)
CREATE TABLE policy_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL,
  beat_id UUID,
  tool_name TEXT NOT NULL,
  tool_parameters JSONB,
  policy_rule_id TEXT NOT NULL,
  decision TEXT NOT NULL,                   -- deny|escalate
  reason TEXT NOT NULL,
  trust_score_before REAL NOT NULL,
  trust_score_after REAL NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()

## Deferred from Spec 11

The following were specified in Spec 11 but deferred because they require the Governance Gateway to produce them.

### 1. Policy Rule Binding on Service Registry Entries

Spec 11 states that `ServiceRegistryEntry` should reference governance rules ("Policy-as-code (S13)"). The registry currently has `requiresApproval` as a boolean but no `policyRuleIds` field linking to specific policy rules. This spec must:

- Add `policyRuleIds: string[]` (or equivalent) to `ServiceRegistryEntry`
- Populate it during gateway initialization from compiled policy rules
- Ensure the registry's `isToolAvailable()` check considers policy state, not just role membership

### 2. Policy Evaluation Audit Recording

Spec 11's `AuditEvent` schema includes `category: "policy_eval"` with fields `policyRule`, `policyDecision` (allow | deny | escalate), and `policyReason`. The audit ledger infrastructure exists but no code path emits these events. This spec must:

- Emit `audit({ category: "policy_eval", ... })` for every gateway evaluation
- Include `policyRule`, `policyDecision`, `policyReason` in the event detail
- Record `tool_denied` events when the gateway blocks a tool call

### 3. Tool-Call-Level Audit Columns

Spec 11 specifies dedicated columns on `audit_events` for tool calls: `tool_name`, `tool_parameters`, `tool_result_status`, `tool_duration_ms`. Currently these are stored inside the `detail` JSONB field. This spec should add these as top-level columns (ALTER TABLE migration) for fast querying of tool call patterns across agents.
);

CREATE INDEX idx_violations_agent ON policy_violations(agent_id, occurred_at DESC);
CREATE INDEX idx_violations_company ON policy_violations(company_id, occurred_at DESC);
```

## How Governance Integrates With Heartbeat (Spec 12)

```
Beat Phase 1 (Context Assembly):
  → Load trust score from Control Plane
  → Load available tools from Service Registry (filtered by role + trust)
  → Inject permitted tool list into agent prompt

Beat Phase 3 (Execution):
  → Agent proposes tool call
  → GovernanceGateway.evaluate(ctx)
    → ALLOW → execute tool → continue
    → DENY → return error to agent → agent reasons around it
    → ESCALATE → create approval → end beat early (status: escalated)

Beat Phase 4 (Serialization):
  → All policy evaluations already in Audit Ledger (from Step 4 in gateway)
  → Trust score updates (positive for compliance)
  → Beat record includes: toolCalls, deniedCalls, escalations
```

## CEO Governs Through Beats, Not Direct Intervention

Today, the CEO's authority is implicit — it's in the SOUL prompt and the orchestrator's hardcoded pipeline. With the governance gateway:

```
CEO's authority is explicit policy:

1. CEO can:
   - Chat with board (tool: chat_send)
   - Read any company state (all green tools)
   - Propose strategies (tool: strategy_propose)
   - Create meeting records (tool: meeting_record)
   - View workspace files (tool: file_read)

2. CEO cannot:
   - Write files (DENIED by ceo-no-code)
   - Run shell commands (DENIED by ceo-no-code)
   - Modify tasks directly (must delegate through meetings)
   - Approve its own strategies (ESCALATED to board)

3. CEO can request:
   - Agent hiring/firing (ESCALATED — requires board approval)
   - Budget adjustments (ESCALATED — requires board approval)
   - Sprint auto-initiation (only when trust > 0.9 AND board pre-approved roadmap)
```

This is the same CEO behavior, but now it's enforced by code, not by hoping the LLM follows instructions.

## Extending Policies

New policies can be added without modifying core code. This is critical for Spec 14 (Self-Evolution) and Spec 15 (Long-Horizon):

```typescript
// Custom company policies (stored in DB, loaded at beat start)
interface CompanyCustomPolicy {
  companyId: string;
  rules: PolicyRule[];
  addedBy: string;              // "system" | "board"
  addedAt: string;
}

// Example: Board adds a policy that prohibits external API calls during Sprint 1
const sprintOnePolicy: PolicyRule = {
  id: "sprint1-no-external",
  name: "Sprint 1: No external API calls",
  priority: 1,
  roles: [],
  tools: ["external_api_call", "http_request"],
  condition: (ctx) => ctx.currentSprintStatus === "executing",
  effect: "deny",
  reason: "Board directive: No external API calls during Sprint 1. Focus on core functionality."
};
```

## Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| Policy engine | TypeScript native (not OPA/Rego) | Stay in ecosystem. No external runtime dependency. Typed rules get IDE support, compile-time checks. Equivalent enforcement power for our scale. |
| Default stance | Allow (deny explicitly) | Open by default avoids blocking legitimate work. The base policy set covers all dangerous cases. |
| Trust cold start | 0.7 (trusted tier) | Assume good faith. Agents start with full role access. Trust degrades on violations. |
| Trust recovery | Slow (+0.01 per compliant action) | Trust is hard to earn, easy to lose. Mirrors real employment dynamics. |
| Escalation model | Hard pause (not soft warning) | Soft warnings don't stop LLMs. Hard pause means the tool literally doesn't execute until approved. |
| Policy storage | Base in code + custom in DB | Base policies are version-controlled with the codebase. Company-specific policies are board-configurable. |
| Protected files | CTO exempted from config files | CTO role is "architect" — they need to modify package.json, tsconfig, etc. Others can't. |

## Files Changed

| File | Change |
|------|--------|
| NEW: `packages/company-runtime/src/governance-gateway.ts` | Gateway implementation (evaluate + intercept) |
| NEW: `packages/company-runtime/src/policies/base-policies.ts` | Built-in policy rules |
| NEW: `packages/company-runtime/src/blast-radius.ts` | Tool blast-radius classification |
| NEW: `packages/company-runtime/src/trust-factor.ts` | Trust scoring system |
| MODIFY: `packages/company-runtime/src/roles.ts` | Add typed capabilities (not just SOUL prompts) |
| MODIFY: `packages/contracts/src/domain.ts` | Add PolicyRule, PolicyEvalContext, PolicyDecision, TrustFactor, BlastRadius types |
| NEW: `packages/db/src/schema/governance.ts` | trust_scores, policy_violations tables |
| MODIFY: `apps/api/src/server.ts` | Add governance panel API endpoints |
| MODIFY: `apps/api/src/orchestrator.ts` | Wire gateway into tool call execution path |
