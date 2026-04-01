# Heartbeat Service Modularization Plan

> **Goal**: Break `server/src/services/heartbeat.ts` (3,922 lines) into a `heartbeat/` folder with domain modules and an `index.ts` facade. Zero consumer changes. Zero behavior changes.

## Current State

- **File**: `server/src/services/heartbeat.ts` — 3,922 lines
- **Sibling**: `server/src/services/heartbeat-run-summary.ts` — 36 lines
- **Pattern**: Single `heartbeatService(db)` factory function returning a public API object
- **Consumers**: 19 files import from heartbeat; only 6 use direct `import` statements

## Target Structure

```
server/src/services/heartbeat/
├── index.ts                  # Facade + executeRun + releaseIssueExecutionAndPromote (~1,350 lines)
├── types.ts                  # Shared types, interfaces, constants (~100 lines)
├── helpers.ts                # Pure utility functions, no db (~200 lines)
├── org-context.ts            # Org position, delegation depth/context (~120 lines)
├── sessions.ts               # Session compaction, task sessions, codec (~350 lines)
├── workspace.ts              # Workspace resolution for runs (~270 lines)
├── run-ops.ts                # Run/wakeup DB CRUD, event appending (~400 lines)
├── process-recovery.ts       # Orphan reaping, process-loss retry (~230 lines)
├── wakeup.ts                 # enqueueWakeup, context enrichment (~520 lines)
├── cancellation.ts           # Cancel run/agent/budget-scope (~370 lines)
└── run-summary.ts            # Moved from heartbeat-run-summary.ts (~36 lines)
```

## Key Design Decisions

1. **`executeRun` (945 lines) stays in `index.ts`** — it is the core orchestrator; splitting it adds risk with minimal readability gain once its helpers are extracted.
2. **`releaseIssueExecutionAndPromote` (160 lines) stays in `index.ts`** — called exclusively from `executeRun`, tightly coupled to run finalization, small extraction payoff.
3. **Node resolves `./heartbeat.js` to `./heartbeat/index.js`** — existing `import { heartbeatService } from "./heartbeat.js"` paths work unchanged.
4. **Each module exports a factory** accepting `db: Db` and a narrow `deps` interface — no closure-based coupling.

## Import Path Changes

Only 3 test files need updates:

| File | Before | After |
|------|--------|-------|
| `__tests__/heartbeat-process-recovery.test.ts` | `../services/heartbeat.ts` | `../services/heartbeat/index.ts` |
| `__tests__/heartbeat-workspace-session.test.ts` | `../services/heartbeat.ts` | `../services/heartbeat/index.ts` |
| `__tests__/heartbeat-run-summary.test.ts` | `../services/heartbeat-run-summary.js` | `../services/heartbeat/run-summary.js` |

All other consumers (`services/index.ts`, `services/routines.ts`, `services/chat.ts`, `services/plugin-host-services.ts`) use `./heartbeat.js` which resolves to the folder index automatically.

---

## Phases

Each phase is an independent, mergeable commit. Run `pnpm test` after every phase.

---

### Phase 0: Create folder scaffold and move files

**Risk: None**

**Steps:**
1. Create directory `server/src/services/heartbeat/`
2. Move `server/src/services/heartbeat.ts` to `server/src/services/heartbeat/index.ts`
3. Move `server/src/services/heartbeat-run-summary.ts` to `server/src/services/heartbeat/run-summary.ts`
4. Update the import in the new `index.ts`: change `from "./heartbeat-run-summary.js"` to `from "./run-summary.js"`
5. Update 3 test file imports:
   - `__tests__/heartbeat-process-recovery.test.ts`: `../services/heartbeat.ts` → `../services/heartbeat/index.ts`
   - `__tests__/heartbeat-workspace-session.test.ts`: `../services/heartbeat.ts` → `../services/heartbeat/index.ts`
   - `__tests__/heartbeat-run-summary.test.ts`: `../services/heartbeat-run-summary.js` → `../services/heartbeat/run-summary.js`
6. Run `pnpm test` — must pass with zero changes to behavior

**Verification:** `pnpm test` passes. `git diff --stat` shows only file moves and import path updates.

---

### Phase 1: Extract `types.ts` and `helpers.ts`

**Risk: Near zero — pure functions and type declarations**

#### 1a. Create `server/src/services/heartbeat/types.ts`

Move these from `index.ts`:

**Constants (lines 64-80):**
- `MAX_LIVE_LOG_CHUNK_BYTES`
- `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT`
- `HEARTBEAT_MAX_CONCURRENT_RUNS_MAX`
- `DEFERRED_WAKE_CONTEXT_KEY`
- `DETACHED_PROCESS_ERROR_CODE`
- `REPO_ONLY_CWD_SENTINEL`
- `MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS`
- `SESSIONED_LOCAL_ADAPTERS`

**Types/interfaces (lines 208-265):**
- `WakeupOptions` (interface, line 208)
- `UsageTotals` (type, line 219)
- `SessionCompactionDecision` (type, line 225)
- `ParsedIssueAssigneeAdapterOverrides` (interface, line 232)
- `ResolvedWorkspaceForRun` (exported type, line 237)
- `ProjectWorkspaceCandidate` (type, line 253)

**Column definitions (lines 146-179):**
- `heartbeatRunListColumns`

#### 1b. Create `server/src/services/heartbeat/helpers.ts`

Move these pure functions from `index.ts`:

- `deriveRepoNameFromRepoUrl` (line 82)
- `appendExcerpt` (line 181)
- `normalizeMaxConcurrentRuns` (line 185)
- `readNonEmptyString` (line 267)
- `formatOrgRoleLabel` (line 271)
- `normalizeLedgerBillingType` (line 281)
- `resolveLedgerBiller` (line 301)
- `normalizeBilledCostCents` (line 305)
- `normalizeUsageTotals` (line 342)
- `readRawUsageTotals` (line 351)
- `deriveNormalizedUsageDelta` (line 379)
- `formatCount` (line 400)
- `truncateDisplayId` (line 641)
- `normalizeAgentNameKey` (line 646)
- `isTrackedLocalChildProcessAdapter` (line 621)
- `isProcessAlive` (line 628)
- `isSameTaskScope` (line 617)
- `runTaskKey` (line 613)
- `normalizeSessionParams` (line 674)

#### 1c. Update `index.ts`

Replace moved code with:
```typescript
import { /* all constants */ } from "./types.js";
import { /* all helpers */ } from "./helpers.js";
export type { ResolvedWorkspaceForRun } from "./types.js";
```

**Verification:** `pnpm test` passes. Removed lines from `index.ts` match added lines in new files.

---

### Phase 2: Extract `org-context.ts`

**Risk: Low — self-contained org/delegation queries**

Move these functions (currently inside `heartbeatService` closure, lines 756-853):
- `resolveOrgPosition` (~27 lines)
- `computeDelegationDepth` (~21 lines)
- `resolveDelegationRunContext` (~47 lines)
- `parseIssueAssigneeAdapterOverrides` (top-level, line 477, ~17 lines)

**New file signature:**
```typescript
export function createOrgContextOps(db: Db) {
  return {
    resolveOrgPosition,
    computeDelegationDepth,
    resolveDelegationRunContext,
  };
}
export { parseIssueAssigneeAdapterOverrides };
```

**Wire in `index.ts`:**
```typescript
const orgContext = createOrgContextOps(db);
```

**Verification:** `pnpm test` passes.

---

### Phase 3: Extract `sessions.ts`

**Risk: Low — session logic has clear inputs/outputs**

Move these functions:

**From top-level (currently outside `heartbeatService`):**
- `getAdapterSessionCodec` (line 669)
- `resolveNextSessionState` (line 679)
- `parseSessionCompactionPolicy` (exported, line 405)
- `resolveRuntimeSessionParamsForWorkspace` (exported, line 409)
- `shouldResetTaskSessionForWake` (exported, line 510)
- `deriveTaskKey` (line 495)
- `describeSessionResetReason` (line 527)

**From inside `heartbeatService`:**
- `evaluateSessionCompaction` (~111 lines, line 956)
- `resolveSessionBeforeForWakeup` (~25 lines, line 1068)
- `upsertTaskSession` (~46 lines, line 1297)
- `clearTaskSessions` (~22 lines, line 1344)
- `getTaskSession` (~19 lines, line 878)
- `getLatestRunForSession` (~20 lines, line 898)
- `getOldestRunForSession` (~12 lines, line 919)
- `resolveNormalizedUsageForSession` (~23 lines, line 932)

**New file signature:**
```typescript
export function createSessionOps(db: Db) {
  return {
    evaluateSessionCompaction,
    resolveSessionBeforeForWakeup,
    upsertTaskSession,
    clearTaskSessions,
    getTaskSession,
    getLatestRunForSession,
    getOldestRunForSession,
    resolveNormalizedUsageForSession,
  };
}

// Re-export standalone functions
export {
  parseSessionCompactionPolicy,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  getAdapterSessionCodec,
  deriveTaskKey,
  describeSessionResetReason,
  resolveNextSessionState,
};
```

**Wire in `index.ts`:**
```typescript
const sessions = createSessionOps(db);
```

**Re-export from `index.ts`:**
```typescript
export {
  parseSessionCompactionPolicy,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
} from "./sessions.js";
```

**Verification:** `pnpm test` passes. Grep for moved function names in `index.ts` returns only import/usage, not definition.

---

### Phase 4: Extract `workspace.ts`

**Risk: Low — workspace resolution is self-contained**

Move these functions:

**From top-level:**
- `ensureManagedProjectWorkspace` (line 95, ~50 lines)
- `prioritizeProjectWorkspaceCandidatesForRun` (exported, line 257)
- `formatRuntimeWorkspaceWarningLog` (exported, line 520)

**From inside `heartbeatService`:**
- `resolveWorkspaceForRun` (~202 lines, line 1094)

**New file signature:**
```typescript
export function createWorkspaceOps(db: Db) {
  return {
    resolveWorkspaceForRun,
  };
}

export {
  ensureManagedProjectWorkspace,
  prioritizeProjectWorkspaceCandidatesForRun,
  formatRuntimeWorkspaceWarningLog,
};
```

**Re-export from `index.ts`:**
```typescript
export {
  prioritizeProjectWorkspaceCandidatesForRun,
  formatRuntimeWorkspaceWarningLog,
} from "./workspace.js";
```

**Verification:** `pnpm test` passes.

---

### Phase 5: Extract `run-ops.ts`

**Risk: Low — thin DB wrappers**

Move these functions from inside `heartbeatService`:

- `getAgent` (~7 lines, line 854)
- `getRun` (~7 lines, line 862)
- `getRuntimeState` (~7 lines, line 870)
- `ensureRuntimeState` (~15 lines, line 1367)
- `setRunStatus` (~32 lines, line 1383)
- `setWakeupStatus` (~11 lines, line 1416)
- `appendRunEvent` (~49 lines, line 1428)
- `nextRunEventSeq` (~7 lines, line 1478)
- `persistRunProcessMetadata` (~16 lines, line 1486)
- `clearDetachedRunWarning` (~21 lines, line 1503)
- `claimQueuedRun` (~54 lines, line 1648)
- `countRunningRunsForAgent` (~7 lines, line 1640)
- `updateRuntimeState` (~54 lines, line 1861)
- `finalizeAgentStatus` (~45 lines, line 1703)
- `startNextQueuedRunForAgent` (~35 lines, line 1916)
- `withAgentStartLock` (top-level, line 191)

Also move the module-level mutable state:
- `startLocksByAgent` map (line 69)
- `activeRunExecutions` set (line 750) — pass into `index.ts` and share via deps

**New file signature:**
```typescript
export function createRunOps(db: Db, deps: {
  activeRunExecutions: Set<string>;
  publishLiveEvent: typeof publishLiveEvent;
  getCurrentUserRedactionOptions: () => Promise<{ enabled: boolean }>;
}) {
  return {
    getAgent, getRun, getRuntimeState, ensureRuntimeState,
    setRunStatus, setWakeupStatus,
    appendRunEvent, nextRunEventSeq,
    persistRunProcessMetadata, clearDetachedRunWarning,
    claimQueuedRun, countRunningRunsForAgent,
    updateRuntimeState, finalizeAgentStatus,
    startNextQueuedRunForAgent, withAgentStartLock,
  };
}
```

**Verification:** `pnpm test` passes.

---

### Phase 6: Extract `process-recovery.ts`

**Risk: Medium — calls into run-ops and wakeup functions**

Move from inside `heartbeatService`:
- `enqueueProcessLossRetry` (~114 lines, line 1525)
- `reapOrphanedRuns` (~99 lines, line 1749)
- `resumeQueuedRuns` (~11 lines, line 1849)

**New file signature:**
```typescript
export function createProcessRecoveryOps(db: Db, deps: {
  runOps: ReturnType<typeof createRunOps>;
  enqueueWakeup: (...args: any[]) => Promise<any>;
  executeRun: (runId: string) => Promise<void>;
}) {
  return {
    enqueueProcessLossRetry,
    reapOrphanedRuns,
    resumeQueuedRuns,
  };
}
```

**Note:** `enqueueWakeup` and `executeRun` dependencies create a circular reference between modules. Resolve by passing them as callbacks in the `deps` object — `index.ts` wires them after all factories are created.

**Verification:** `pnpm test` passes. Specifically verify `heartbeat-process-recovery.test.ts` passes.

---

### Phase 7: Extract `wakeup.ts`

**Risk: Medium — largest extraction, complex coalescing logic**

Move from inside `heartbeatService`:
- `enqueueWakeup` (~477 lines, line 3050)

Move from top-level:
- `enrichWakeContextSnapshot` (line 549, ~47 lines)
- `mergeCoalescedContextSnapshot` (line 596, ~17 lines)
- `deriveCommentId` (line 537, ~12 lines)

**New file signature:**
```typescript
export function createWakeupOps(db: Db, deps: {
  runOps: ReturnType<typeof createRunOps>;
  sessions: ReturnType<typeof createSessionOps>;
  workspace: ReturnType<typeof createWorkspaceOps>;
  orgContext: ReturnType<typeof createOrgContextOps>;
  executeRun: (runId: string) => Promise<void>;
  secretsSvc: ReturnType<typeof secretService>;
  companySkills: ReturnType<typeof companySkillService>;
  budgets: ReturnType<typeof budgetService>;
  roleDefs: ReturnType<typeof roleDefinitionService>;
  spawnGovernance: ReturnType<typeof spawnGovernanceService>;
  instanceSettings: ReturnType<typeof instanceSettingsService>;
}) {
  return {
    enqueueWakeup,
  };
}

export { enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, deriveCommentId };
```

**Verification:** `pnpm test` passes.

---

### Phase 8: Extract `cancellation.ts`

**Risk: Medium — budget scope cancellation is complex but self-contained**

Move from inside `heartbeatService`:
- `cancelRunInternal` (~42 lines, line 3627)
- `cancelActiveForAgentInternal` (~28 lines, line 3670)
- `cancelBudgetScopeWork` (~223 lines, line 3699)
- `cancelPendingWakeupsForBudgetScope` (~47 lines, line 3579)
- `listProjectScopedRunIds` (~24 lines, line 3528)
- `listProjectScopedWakeupIds` (~25 lines, line 3553)

**New file signature:**
```typescript
export function createCancellationOps(db: Db, deps: {
  runOps: ReturnType<typeof createRunOps>;
  activeRunExecutions: Set<string>;
  getServerAdapter: typeof getServerAdapter;
  runningProcesses: typeof runningProcesses;
}) {
  return {
    cancelRunInternal,
    cancelActiveForAgentInternal,
    cancelBudgetScopeWork,
  };
}
```

**Important:** `cancelBudgetScopeWork` is passed to `budgetService` as a hook. After extraction, `index.ts` still creates the hook reference:
```typescript
const budgetHooks = { cancelWorkForScope: cancellation.cancelBudgetScopeWork };
```

**Verification:** `pnpm test` passes.

---

## Post-Extraction Checklist

After all 9 phases are complete:

- [ ] `server/src/services/heartbeat/index.ts` is ~1,350 lines (down from 3,922)
- [ ] `server/src/services/heartbeat-run-summary.ts` no longer exists (moved to `heartbeat/run-summary.ts`)
- [ ] All 19 consumer files work without import changes (except 3 test files updated in Phase 0)
- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm build` (or `tsc --noEmit`) passes with zero type errors
- [ ] No function signatures changed — only moved
- [ ] `export { heartbeatService } from "./heartbeat.js"` in `services/index.ts` still works
- [ ] Git history: each phase is a separate commit for easy bisect/revert

## Files Changed Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `heartbeat/index.ts`, `heartbeat/run-summary.ts` | 3 test files |
| 1 | `heartbeat/types.ts`, `heartbeat/helpers.ts` | `heartbeat/index.ts` |
| 2 | `heartbeat/org-context.ts` | `heartbeat/index.ts` |
| 3 | `heartbeat/sessions.ts` | `heartbeat/index.ts` |
| 4 | `heartbeat/workspace.ts` | `heartbeat/index.ts` |
| 5 | `heartbeat/run-ops.ts` | `heartbeat/index.ts` |
| 6 | `heartbeat/process-recovery.ts` | `heartbeat/index.ts` |
| 7 | `heartbeat/wakeup.ts` | `heartbeat/index.ts` |
| 8 | `heartbeat/cancellation.ts` | `heartbeat/index.ts` |

**Deleted after Phase 0:** `server/src/services/heartbeat.ts`, `server/src/services/heartbeat-run-summary.ts`
