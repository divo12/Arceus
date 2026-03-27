# Layer 1: Organization — Overview & Cross-Cutting Concerns

> **Date**: 2026-03-27 | **Status**: Draft
> **Scope**: Hierarchy, Roles, SpawnRules, Delegation Authority, DelegationStyle
> **Branch**: `dev/agent-framework`
> **Design system**: Paperclip — dark-first, dense, keyboard-driven, OKLCH tokens
> **Package names**: `@paperclipai/db`, `@paperclipai/shared` (NOT `@paperclip/`)

---

## Companion Documents

| Doc | Contents |
|-----|----------|
| `01-data-model.md` | Phase 1: Shared types, Zod validators, Drizzle schema, migration |
| `02-backend-services.md` | Phase 2: Role definitions, delegation guard, spawn governance, hierarchy service |
| `03-ai-engineering.md` | Phase 3: AGENTS.md injection, heartbeat context, onboarding bundles, memory delegation |
| `04-api-routes.md` | Phase 4: REST endpoints, Zod schemas, route implementations |
| `05-frontend.md` | Phase 5: Data layer, components, pages, navigation, interaction, responsive |
| `06-memory-and-testing.md` | Phase 6: Memory integration + Phase 7: Testing |

---

## Agent Kinds (CRITICAL — cross-cutting concept)

There are two fundamentally different kinds of agents. Every service, route, UI component, and test must respect this distinction.

| | **Employee** | **Spawned** |
|---|---|---|
| **Roles** | `ceo`, `cto`, `engineer`, `designer`, `pm` | Any role slug (typically `researcher`, `qa`, `devops`, `general`, or custom) |
| **Lifecycle** | Permanent — hired by Board, persists across sessions | Ephemeral — created at runtime by an employee for a specific task, terminated when done |
| **Creation** | Board-only via `/companies/:companyId/agent-hires` | Employee agents via spawn governance (`spawnGovernanceService`) |
| **Org chart** | Part of the hierarchy — `reportsTo` chain, hierarchy proposals | NOT part of the hierarchy — linked to spawning parent only |
| **Task flow** | Receive work via **delegation** through hierarchy (`delegationGuardService`) | Receive work at spawn time — task is baked into spawn context |
| **Delegation** | Can delegate to other employees per `canDelegateTo` matrix | Cannot delegate — they execute and terminate |
| **Spawn authority** | Employees can spawn ephemeral agents per `spawnRules` | Spawned agents cannot spawn other agents |
| **Memory** | Full Hippocampus lifecycle (priming, habits, recall, extraction) | Minimal memory — inherit parent's delegation context, no long-term storage |
| **SOUL.md** | Yes — role-specific persona | No — receives task prompt from parent |

**Key rules**:
1. Employee roles **cannot** be spawned — they are always Board-hired
2. Spawned agents **cannot** delegate — they execute directly
3. Delegation flows **only** between employees, governed by hierarchy
4. Spawn governance controls **only** ephemeral agent creation by employees
5. The Board bypasses all governance (can hire employees, can spawn anything)

---

## 1. Gap Analysis

### What EXISTS Today

| Concept | Implementation | Location |
|---------|---------------|----------|
| **Company** (≈ Startup) | Full: name, status, budget, issue tracking | `packages/db/src/schema/companies.ts` |
| **Agent roles** | Enum only: `ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general` | `packages/shared/src/constants.ts:38` |
| **`reportsTo`** | Single FK on `agents` table — flat self-reference | `packages/db/src/schema/agents.ts:23` |
| **OrgChart UI** | Tree layout from `reportsTo` links, visual cards with status | `ui/src/pages/OrgChart.tsx` |
| **Memory delegation** | `DelegationMemoryManager` — copies memories between scopes | `backend/arceus/core/delegation_memory.py` |
| **Agent adapter** | OpenCode (+ 8 others) — heartbeat-based execution | `packages/adapters/opencode-local/` |
| **CEO SOUL.md** | Static persona file for CEO only | `server/src/onboarding-assets/ceo/SOUL.md` |

### What's MISSING (spec gap)

| Spec Construct | Gap | Impact |
|---|---|---|
| **Role entity** (system_prompt, tools, skills_seed, can_delegate_to, delegation_style) | Roles are just strings — no behavioral definition | Agents have no role-specific behavior, delegation rules, or tool profiles |
| **Agent kind** (employee vs spawned) | Not modeled — all agents are treated the same | No distinction between permanent org members and ephemeral task agents |
| **SpawnRule** (allowed_agent_types, max_concurrent_spawns, spawn_depth) | Does not exist | No governance over ephemeral agent spawning |
| **Hierarchy lifecycle** (proposed → approved → active) | Implicit from `reportsTo` FK | No LLM-proposed org charts, no approval flow for structure changes |
| **HierarchyEdge types** (reports_to vs delegates_to) | Only `reportsTo` FK | No distinction between reporting chain and delegation authority |
| **DelegationStyle** (directive / collaborative / autonomous) | Not modeled | All delegation is identical — no behavioral variation |
| **Delegation authority matrix** | Not enforced | Any agent can theoretically delegate to any other |
| **Per-role SOUL.md** | Only CEO has one | CTO, PM, Engineer, Designer have no persona guidance |

---


---

## Execution Order

```
Phase 1 (Data Model)
    │
    ▼
Phase 2 (Services) ────────────────────────────┐
    │                                           │
    ├──→ Phase 3 (AI Eng: AGENTS.md + SOUL.md)  │
    │                                           │
    ├──→ Phase 4 (API Routes)                   │
    │         │                                 │
    │         ▼                                 │
    │    Phase 5 (Frontend: Components →        │
    │           Pages → Navigation)             │
    │                                           │
    └──→ Phase 6 (Memory Integration) ──────────┘

Phase 7 (Testing) runs alongside each phase
```

**Recommended start**: Phase 1 → Phase 2 → Phase 3 (immediate value: governed agents with role-aware prompts in OpenCode)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Breaking existing hire/assignment flows** | High | Governance checks return `{allowed, reason}` — when `roleDefinitionId` is null, fall back to permissive. Board always bypasses. |
| **heartbeat.ts complexity (130KB)** | Medium | Only change: add role definition to execution context object (single const). AGENTS.md changes are in isolated adapter file. |
| **Hierarchy snapshot ↔ `agents.reportsTo` desync** | Medium | Activation runs in DB transaction: update all `reportsTo` + mark snapshot active + supersede old. Rollback on failure. |
| **Python sidecar lagging Node.js changes** | Low | Phase 6 is independently deliverable. Services work without Hippocampus enrichment. |
| **Role definitions diverging across companies** | Low | Built-in roles seeded from canonical definitions. `isBuiltIn: true` flag. "Reset to Default" UI action. |

---

## Success Criteria

- [ ] `role_definitions` table seeded on company creation with canonical roles
- [ ] Employee roles (ceo, cto, engineer, designer, pm) can only be hired by Board — never spawned
- [ ] Employees can spawn ephemeral agents per their `spawnRules` (e.g. CEO spawns researcher)
- [ ] CEO can delegate to CTO/PM/Engineer/Designer; Engineer cannot delegate to CEO (delegation guard)
- [ ] Spawned agents cannot delegate — they execute and terminate
- [ ] Delegation flows only between employees, governed by `canDelegateTo` matrix
- [ ] Board user bypasses all governance
- [ ] AGENTS.md includes role context: system prompt, delegation authority, spawn authority
- [ ] OrgChart shows `reports_to` (solid) and `delegates_to` (dashed) edges
- [ ] Role Editor page allows Board to customize prompts, tools, delegation matrices
- [ ] Hierarchy proposal lifecycle: propose → approve → activate → org chart updates
- [ ] DelegationStyleBadge, RoleTagChip, AuthorityMatrix, SpawnBudgetBar, HierarchyEdgeLegend in design guide
- [ ] NewAgent form enforces spawn rules and shows delegation style selector
- [ ] Agent Detail shows Authority section with delegation/spawn info
- [ ] Backward compatibility: existing agents without `roleDefinitionId` work unchanged
- [ ] Unit test coverage ≥ 80% for delegation-guard, spawn-governance, role-definitions, hierarchy
- [ ] E2E test passes for role editing + hierarchy proposal

---

## File Reference

### New Files (39)

| File | Phase | Type |
|------|-------|------|
| `packages/shared/src/types/role.ts` | 1 | Types |
| `packages/shared/src/types/hierarchy.ts` | 1 | Types |
| `packages/shared/src/validators/role.ts` | 1 | Validation |
| `packages/shared/src/validators/hierarchy.ts` | 1 | Validation |
| `packages/db/src/schema/role_definitions.ts` | 1 | Schema |
| `packages/db/src/schema/hierarchy_snapshots.ts` | 1 | Schema |
| `packages/db/src/schema/hierarchy_edges.ts` | 1 | Schema |
| `server/src/services/role-definitions.ts` | 2 | Service |
| `server/src/services/role-definition-seeds.ts` | 2 | Service |
| `server/src/services/delegation-guard.ts` | 2 | Service |
| `server/src/services/spawn-governance.ts` | 2 | Service |
| `server/src/services/hierarchy.ts` | 2 | Service |
| `server/src/onboarding-assets/cto/SOUL.md` | 3 | AI |
| `server/src/onboarding-assets/pm/SOUL.md` | 3 | AI |
| `server/src/onboarding-assets/engineer/SOUL.md` | 3 | AI |
| `server/src/onboarding-assets/designer/SOUL.md` | 3 | AI |
| `server/src/routes/roles.ts` | 4 | API |
| `server/src/routes/hierarchy.ts` | 4 | API |
| `ui/src/api/roles.ts` | 5 | API client |
| `ui/src/api/hierarchy.ts` | 5 | API client |
| `ui/src/hooks/useRoles.ts` | 5 | Hook (useRoles, useUpdateRole, useCreateRole) |
| `ui/src/hooks/useHierarchy.ts` | 5 | Hook (useHierarchyProposals, useApprove/Activate/Reject) |
| `ui/src/hooks/useDelegationAuthority.ts` | 5 | Hook (delegation data for agent) |
| `ui/src/hooks/useSpawnGovernance.ts` | 5 | Hook (spawn budget + allowed roles for parent) |
| `ui/src/components/DelegationStyleBadge.tsx` | 5 | Component |
| `ui/src/components/RoleTagChip.tsx` | 5 | Component |
| `ui/src/components/HierarchyEdgeLegend.tsx` | 5 | Component |
| `ui/src/components/AuthorityMatrix.tsx` | 5 | Component |
| `ui/src/components/SpawnBudgetBar.tsx` | 5 | Component |
| `ui/src/pages/RoleEditor.tsx` | 5 | Page |
| `ui/src/pages/HierarchyProposals.tsx` | 5 | Page |
| `server/src/__tests__/delegation-guard.test.ts` | 7 | Test |
| `server/src/__tests__/spawn-governance.test.ts` | 7 | Test |
| `server/src/__tests__/role-definitions.test.ts` | 7 | Test |
| `server/src/__tests__/hierarchy.test.ts` | 7 | Test |
| `server/src/__tests__/agent-hire-governance.test.ts` | 7 | Test |
| `tests/e2e/roles-and-hierarchy.spec.ts` | 7 | Test |

### Modified Files (20)

| File | Phase | Change |
|------|-------|--------|
| `packages/shared/src/constants.ts` | 1 | New enums: AgentKind, DelegationStyle, HierarchyStatus, HierarchyEdgeType, EMPLOYEE_ROLES |
| `packages/shared/src/types/index.ts` | 1 | Re-exports |
| `packages/shared/src/index.ts` | 1 | Re-exports |
| `packages/db/src/schema/agents.ts` | 1 | New columns: roleDefinitionId, delegationStyle, kind, spawnedByAgentId |
| `packages/db/src/schema/index.ts` | 1 | New exports |
| `server/src/services/index.ts` | 2 | New service exports |
| `server/src/services/companies.ts` | 2 | Seed roles on creation |
| `server/src/routes/agents.ts` | 2, 4 | Governance + delegation query endpoints |
| `server/src/routes/issues.ts` | 2 | Delegation guard on assignment |
| `server/src/routes/index.ts` | 4 | Mount new routers |
| `server/src/services/heartbeat.ts` | 3 | Pass role context |
| `server/src/services/memory-lifecycle.ts` | 3 | Delegation style metadata |
| `server/src/services/default-agent-instructions.ts` | 3 | Per-role bundles |
| `server/src/adapters/arceus/execute.ts` | 3 | AGENTS.md role injection |
| `server/src/services/hippocampus-contract.ts` | 6 | Delegation bridge methods |
| `ui/src/lib/queryKeys.ts` | 5 | New keys: roles, hierarchy, delegation |
| `ui/src/api/agents.ts` | 5 | Add delegationAuthority(), canDelegateTo() |
| `ui/src/pages/OrgChart.tsx` | 5 | Delegation edges, style badges, banner, legend |
| `ui/src/pages/AgentDetail.tsx` | 5 | Authority tab with lazy-loaded delegation data |
| `ui/src/pages/NewAgent.tsx` | 5 | Governed role picker, delegation style chip, spawn warning |
| `ui/src/App.tsx` | 5 | New routes: /roles, /hierarchy/proposals |
| `ui/src/components/Sidebar.tsx` | 5 | Organization nav section with pending badge |
| `ui/src/pages/DesignGuide.tsx` | 5 | Organization component showcase section |
