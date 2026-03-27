# Layer 1: Organization — Phase 3: AI Engineering

> **Parent**: See `00-overview.md` for gap analysis, execution order, risks, success criteria, and file reference.
> **Branch**: `dev/agent-framework`
> **Package names**: `@paperclipai/db`, `@paperclipai/shared`
> **Codebase patterns**: Factory functions taking `Db`, Express Router factories, Zod validation via `validate()` middleware, `throw HttpError` caught by centralized `errorHandler`, flat JSON responses.

---

## Phase 3: AI Engineering

> The agent harness shapes how agents plan, call tools, recover from errors, and converge on completion. This phase injects **role-aware context** into the existing harness: identity (who am I?), action space (what can I do?), observation quality (what did I see?), and recovery (what went wrong?).

### 3.1 Context budget allocation

The existing `writeAgentsMd()` (`execute.ts:138-188`) injects identity, env vars, session handoff, and memory context into AGENTS.md. Role context must fit **within** this budget — not balloon it.

**Design principle**: Keep the invariant system prompt minimal. Move large guidance into on-demand skills and per-run memory recall. Only inject what the agent needs for the *current* heartbeat.

**Context budget per section**:

| Section | Target tokens | Source | Frequency |
|---------|--------------|--------|-----------|
| Identity (role prompt) | 200–400 | `role_definitions.system_prompt` | Every run |
| Action space (delegation/spawn) | 100–200 | Computed from role definition | Every run |
| Organizational context | 50–100 | Computed from agents table | Every run |
| Delegation style guidance | 50–150 | Static per style | Only on delegation runs |
| Recovery hints | 30–80 | Static per error class | Only on error recovery |

**Total budget**: ≤ 800 tokens for all role context. This preserves headroom for memory recall, session handoff, and task-specific context which already consume the majority of AGENTS.md.

### 3.2 AGENTS.md role context injection

**File**: `server/src/adapters/arceus/execute.ts` — extend `writeAgentsMd` (~line 138)

The existing template includes Identity, Environment Variables, Quick Reference, Instructions, Session Handoff, and Memory Context sections. Add three new sections **after** Quick Reference and **before** Instructions:

```markdown
## Your Role: CTO
You are the Chief Technology Officer. You translate business goals into
technical architecture and manage the engineering team.
{role_definitions.system_prompt — max 400 tokens, truncated with "…" if longer}

## Action Space
Delegation authority: Engineer, PM, Designer
  Style: collaborative — share context and goals, let delegatees own approach
  Chain depth limit: 3 (you are at depth 1)
Spawn authority: researcher, qa, devops (ephemeral only — employee roles are never spawned)
  Budget: 2/5 active (3 remaining)

## Org Position
Reports to: CEO (Atlas)
Direct reports: Engineer (Nova), Designer (Pixel)
```

**Key harness patterns applied**:

- **Narrow action space**: Explicitly list what the agent *cannot* do alongside what it can. This reduces hallucinated tool calls and invalid delegation attempts.
- **Observation-ready format**: Budget numbers use `active/max (remaining)` format — the agent can directly compare without arithmetic.
- **Stop condition**: Chain depth limit is stated so the agent knows when to stop delegating.

**Implementation** — new helper function in `execute.ts`:

```typescript
function buildRoleContextBlock(
  roleDef: RoleDefinition | null,
  orgPosition: { reportsTo: string | null; directReports: string[] },
  spawnBudget: { active: number; max: number; remaining: number },
  delegationDepth: number,
): string {
  if (!roleDef) return ""; // Graceful fallback for legacy agents

  const lines: string[] = [];

  // Identity — capped at 400 tokens (~1600 chars)
  const prompt = roleDef.systemPrompt.length > 1600
    ? roleDef.systemPrompt.slice(0, 1600) + "…"
    : roleDef.systemPrompt;
  lines.push(`## Your Role: ${roleDef.label}`, prompt, "");

  // Action space — explicit allow + deny lists
  const canDelegate = roleDef.canDelegateTo;
  const canSpawn = roleDef.spawnRules.allowedAgentTypes;
  lines.push("## Action Space");
  if (canDelegate.length > 0) {
    lines.push(`Delegation authority: ${canDelegate.join(", ")}`);
    lines.push(`  Style: ${roleDef.delegationStyle} — ${DELEGATION_STYLE_HINTS[roleDef.delegationStyle]}`);
    lines.push(`  Chain depth limit: 3 (you are at depth ${delegationDepth})`);
  } else {
    lines.push("Delegation authority: none — you execute tasks directly");
  }
  if (canSpawn.length > 0) {
    lines.push(`Spawn authority: ${canSpawn.join(", ")}`);
    lines.push(`  Budget: ${spawnBudget.active}/${spawnBudget.max} active (${spawnBudget.remaining} remaining)`);
  } else {
    lines.push("Spawn authority: none");
  }
  lines.push("");

  // Org position — minimal, just names
  lines.push("## Org Position");
  lines.push(`Reports to: ${orgPosition.reportsTo ?? "Board (no manager)"}`);
  if (orgPosition.directReports.length > 0) {
    lines.push(`Direct reports: ${orgPosition.directReports.join(", ")}`);
  }

  return lines.join("\n");
}

const DELEGATION_STYLE_HINTS: Record<DelegationStyle, string> = {
  directive: "provide specific instructions, retain control of decisions",
  collaborative: "share context and goals, let delegatees own approach",
  autonomous: "state the goal and definition of done, then step back",
};
```

**Injection point** — in `writeAgentsMd()`, insert role block between Quick Reference and Instructions:

```typescript
// After existing Quick Reference section (~line 172)
const roleBlock = buildRoleContextBlock(
  context.paperclipRoleDefinition ?? null,
  context.paperclipOrgPosition ?? { reportsTo: null, directReports: [] },
  context.paperclipSpawnBudget ?? { active: 0, max: 0, remaining: 0 },
  context.paperclipDelegationDepth ?? 0,
);
if (roleBlock) {
  sections.push(roleBlock);
}
```

### 3.3 Heartbeat context assembly

**File**: `server/src/services/heartbeat.ts` — extend context assembly (~lines 2139-2443)

Add role-aware fields to the `context` object before it reaches the adapter:

```typescript
// After workspace assembly (~line 2155), before session handoff (~line 2184)

// Role context injection
const roleDefs = roleDefinitionService(db);
const spawnGov = spawnGovernanceService(db);

const [roleDef, spawnBudget, orgPosition] = await Promise.all([
  roleDefs.getForAgent(agent.id),
  spawnGov.checkSpawnBudget(agent.id),
  resolveOrgPosition(db, agent.id), // new helper
]);

if (roleDef) {
  context.paperclipRoleDefinition = {
    label: roleDef.label,
    slug: roleDef.slug,
    systemPrompt: roleDef.systemPrompt,
    canDelegateTo: roleDef.canDelegateTo,
    delegationStyle: roleDef.delegationStyle,
    spawnRules: roleDef.spawnRules,
  };
}
context.paperclipSpawnBudget = spawnBudget;
context.paperclipOrgPosition = orgPosition;
context.paperclipDelegationDepth = await computeDelegationDepth(db, agent.id);
```

**New helper** — `resolveOrgPosition`:

```typescript
async function resolveOrgPosition(db: Db, agentId: string) {
  const [agent, reports] = await Promise.all([
    db.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, agentId)).then(r => r[0]),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.reportsTo, agentId)),
  ]);

  let reportsToLabel: string | null = null;
  if (agent?.reportsTo) {
    const manager = await db.select({ name: agents.name, role: agents.role })
      .from(agents).where(eq(agents.id, agent.reportsTo)).then(r => r[0]);
    if (manager) reportsToLabel = `${manager.role.toUpperCase()} (${manager.name})`;
  }

  return {
    reportsTo: reportsToLabel,
    directReports: reports.map(r => r.name),
  };
}
```

**New helper** — `computeDelegationDepth`:

```typescript
/** Walk reportsTo chain upward, counting hops. Max 10 iterations to prevent cycles. */
async function computeDelegationDepth(db: Db, agentId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = agentId;
  const seen = new Set<string>();
  while (currentId && depth < 10) {
    if (seen.has(currentId)) break; // cycle guard
    seen.add(currentId);
    const parent = await db.select({ reportsTo: agents.reportsTo })
      .from(agents).where(eq(agents.id, currentId)).then(r => r[0]);
    if (!parent?.reportsTo) break;
    currentId = parent.reportsTo;
    depth++;
  }
  return depth;
}
```

### 3.4 Role-specific onboarding bundles

**Current state**: `DEFAULT_AGENT_BUNDLE_FILES` maps `"default"` → `[AGENTS.md]` and `"ceo"` → `[AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md]`. Role resolution falls back to `"default"` for all non-CEO roles.

**Change**: Extend to all management roles. Leaf roles (engineer, designer) get a lighter bundle — they don't need delegation/spawn playbooks.

**File**: `server/src/services/default-agent-instructions.ts`

```typescript
const DEFAULT_AGENT_BUNDLE_FILES = {
  default:  ["AGENTS.md"],
  ceo:      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  cto:      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md"],
  pm:       ["AGENTS.md", "HEARTBEAT.md", "SOUL.md"],
  engineer: ["AGENTS.md", "SOUL.md"],
  designer: ["AGENTS.md", "SOUL.md"],
} as const;

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  if (role in DEFAULT_AGENT_BUNDLE_FILES) return role as DefaultAgentBundleRole;
  return "default";
}
```

**New onboarding asset files**:

| File | Purpose | Harness principle |
|------|---------|-------------------|
| `server/src/onboarding-assets/cto/SOUL.md` | Technical identity, architecture bias, code review posture | Identity context — who am I |
| `server/src/onboarding-assets/cto/HEARTBEAT.md` | 6-step checklist: identity → assignments → delegate → review → extract → exit | Action sequence — deterministic flow |
| `server/src/onboarding-assets/pm/SOUL.md` | Requirements focus, stakeholder communication, scope discipline | Identity context |
| `server/src/onboarding-assets/pm/HEARTBEAT.md` | 6-step checklist: identity → backlog → prioritize → delegate → track → extract | Action sequence |
| `server/src/onboarding-assets/engineer/SOUL.md` | Implementation focus, test-first, quality bar, autonomous execution | Identity context |
| `server/src/onboarding-assets/designer/SOUL.md` | Design system adherence, prototyping, user-centered decisions | Identity context |

**SOUL.md template structure** (each role follows this skeleton):

```markdown
# {Role} — Soul

## Strategic Posture
{2-3 sentences: what this role optimizes for}

## Decision Framework
- {2-3 decision heuristics specific to the role}
- When uncertain: {escalation rule — who to ask, when to stop}

## Constraints
- {Hard boundaries: what this role must never do}
- {Reversibility check: one-way vs two-way doors}

## Recovery Protocol
- On blocked: {what to do when stuck — specific to role}
- On failure: {how to report, what context to include}
- On ambiguity: {ask for clarification vs. make a call — threshold}

## Voice
{Communication style — 1-2 sentences}
```

**Key harness patterns applied**:

- **Error recovery contract**: Every SOUL.md includes explicit recovery protocol — root cause hint, retry instruction, stop condition. This eliminates the anti-pattern of opaque failure with no next steps.
- **Granularity matching**: Management roles (CEO, CTO, PM) get HEARTBEAT.md with macro-level step sequences. Leaf roles (Engineer, Designer) skip it — they receive micro-level task instructions per-issue instead.
- **Stop conditions**: Decision framework includes escalation rules so agents know when to stop acting and ask.

### 3.5 Delegation style in memory context

**File**: `server/src/services/memory-lifecycle.ts` — extend `buildMemoryContextForRun()` (~line 47)

Add `delegationStyle` and `delegatorContext` to the input signature:

```typescript
export async function buildMemoryContextForRun(input: {
  agentId: string;
  issueTitle: string | null;
  issueId: string | null;
  wakeReason: string | null;
  delegationStyle?: DelegationStyle;       // NEW
  delegatorAgentId?: string;               // NEW
}): Promise<string | null>
```

**Context depth by delegation style** — controls how much memory the Hippocampus bridge returns:

| Style | Priming | Recall depth | Habits | Delegator context |
|-------|---------|-------------|--------|-------------------|
| **directive** | Full identity | Deep (top 10 memories) | All matched | Full: goal chain + decisions + constraints |
| **collaborative** | Full identity | Medium (top 5 memories) | Matched | Shared: goal + relevant facts |
| **autonomous** | Full identity | Shallow (top 3 memories) | Role-specific only | Minimal: task description + DoD only |

**Implementation** — adjust recall parameters based on style:

```typescript
const recallLimit = input.delegationStyle === "directive" ? 10
  : input.delegationStyle === "autonomous" ? 3
  : 5; // collaborative or unset

const habits = await hippocampus.getHabits(input.agentId, query);
const recall = await hippocampus.recall(input.agentId, query, { limit: recallLimit });

// Delegator context injection — only when this run was triggered by delegation
if (input.delegatorAgentId && input.delegationStyle) {
  const delegatorMemory = await hippocampus.getDelegationContext(
    input.delegatorAgentId,
    input.agentId,
    input.delegationStyle,
  );
  if (delegatorMemory) {
    sections.push("## Delegator Context", delegatorMemory);
  }
}
```

**Observation quality**: The memory context sections use structured headers (`## Agent Memory — Priming`, `## Agent Memory — Relevant Recall`, `## Delegator Context`) so the agent can identify what each block represents and act on it appropriately. Each recalled memory includes its `[kind]` tag for provenance.

### 3.6 Delegation event recording

**File**: `server/src/services/memory-lifecycle.ts` — new export

When an agent delegates a task (via issue assignment or spawn), record the event as a memory so both delegator and delegatee can recall it later:

```typescript
export async function recordDelegationEvent(input: {
  fromAgentId: string;
  toAgentId: string;
  taskDescription: string;
  style: DelegationStyle;
  issueId: string | null;
}): Promise<void> {
  await hippocampus.extract(input.fromAgentId, [{
    role: "system",
    content: `Delegated task to ${input.toAgentId}: "${input.taskDescription}" (style: ${input.style})`,
  }]);
}
```

**Integration point**: Call from the delegation guard's `assertCanDelegate` success path in `server/src/routes/issues.ts` (task assignment) and `server/src/routes/agents.ts` (agent hire).

### 3.7 SOUL.md vs Hippocampus — evolution path

**Short answer**: Hippocampus can *subsume* SOUL.md — but not *replace* it on day 1.

**The bootstrap problem**: An agent needs identity context *before* its first heartbeat — before Hippocampus has any memories. SOUL.md solves cold-start.

**The evolution path**:

```
Layer 1 (now):   SOUL.md = static file per role
                 role_definitions.system_prompt = DB-stored, editable via Role Editor
                 ↓ seeds Hippocampus STATIC tier on first boot

Layer 2 (soon):  Hippocampus STATIC memories grow from experience
                 SOUL.md becomes a seed template, not the source of truth
                 Profile engine generates richer identity

Layer 3 (later): Hippocampus IS the identity
                 STATIC tier: core persona + accumulated knowledge
                 PROCEDURAL tier: learned habits ("always run tests first")
                 PRIMING tier: current morale/confidence state
                 No SOUL.md file needed — identity emerges from memory
```

**Recommendation for this plan**: Use `role_definitions.system_prompt` (DB) as the source of truth. Seed it from SOUL.md templates. On each heartbeat, inject the system_prompt into AGENTS.md via `buildRoleContextBlock()`. On first boot, store the system_prompt as a STATIC memory in Hippocampus. Over time, the profile engine generates richer identity from accumulated memories, and the static system_prompt becomes just the seed.

### 3.8 Anti-patterns to avoid

| Anti-pattern | Risk in this plan | Mitigation |
|---|---|---|
| **Context overloading** | Role prompt + delegation rules + org chart + memory recall could exceed useful context | Budget cap: ≤ 800 tokens for role context. Memory recall adapts to delegation style. |
| **Overlapping action semantics** | "Delegate" vs "Assign" vs "Spawn" could confuse agents | Clear terminology in AGENTS.md: "delegate" = reassign existing task, "spawn" = create new agent, "assign" = attach issue |
| **Opaque observation on governance failure** | Agent tries to spawn but gets 403 — no explanation | Error response includes `reason` field + AGENTS.md states budget/limits upfront so agent can self-check |
| **No recovery hints** | Agent fails to delegate → stuck | SOUL.md recovery protocol + delegation guard returns `{ allowed: false, reason: "..." }` — agent sees why and can try alternative |
| **Identity drift** | Long-running agent forgets its role constraints | System prompt re-injected every heartbeat. Hippocampus STATIC tier reinforces core identity on every recall. |

---

