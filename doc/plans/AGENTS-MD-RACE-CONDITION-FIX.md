# Fix: AGENTS.md Race Condition — Per-Run Isolation

> **Date**: 2026-04-05 | **Priority**: Critical
> **Status**: Plan — ready for implementation

## Problem

All agents share a single `AGENTS.md` at `OPENCODE_DIR/AGENTS.md` (e.g. `/app/AGENTS.md`).

```
CEO run starts  → writes /app/AGENTS.md (CEO JWT, CEO context)
CTO run starts  → writes /app/AGENTS.md (CTO JWT, CTO context)  ← overwrites CEO's
CEO's OpenCode session reads AGENTS.md → gets CTO's JWT ← WRONG IDENTITY
```

This causes:
- Agents using wrong JWTs (auth failures or acting as wrong agent)
- Agents reading stale context from a different company/agent
- Unpredictable behavior when multiple heartbeats run concurrently

## Root Cause

`execute.ts:295`: `const agentsMdPath = path.join(OPENCODE_DIR, "AGENTS.md")` — single shared path.

`execute.ts:38`: `x-opencode-directory` header always sends the same `OPENCODE_DIR` — all sessions share one working directory.

## Fix: Per-Run Working Directory

Create a unique directory per run, write AGENTS.md there, and point OpenCode at that directory.

### Changes to `execute.ts`

**1. Create per-run directory before writing AGENTS.md:**
```typescript
const runDir = path.join(OPENCODE_DIR, ".runs", runId);
await fsP.mkdir(runDir, { recursive: true });
```

**2. Write AGENTS.md to run directory:**
```typescript
// In writeAgentsMd(), accept runDir parameter
const agentsMdPath = path.join(runDir, "AGENTS.md");
await fsP.writeFile(agentsMdPath, md, "utf8");
```

**3. Pass run directory to OpenCode via `x-opencode-directory`:**
```typescript
// ocRequest() accepts optional workDir parameter
function ocRequest(method, urlPath, body?, workDir?) {
  headers: {
    "x-opencode-directory": encodeURIComponent(workDir ?? OPENCODE_DIR),
  }
}
```

**4. Thread `runDir` through all ocRequest calls in execute():**
```typescript
session = await ocRequest("POST", "/session", {}, runDir);
result = await ocRequest("POST", `/session/${sessionId}/message`, { ... }, runDir);
```

**5. Cleanup after run completes:**
```typescript
// In finally block at end of execute()
try {
  await fsP.rm(runDir, { recursive: true, force: true });
} catch {
  // Non-fatal — stale dirs cleaned up on next run
}
```

### Modifications Summary

| File | Line | Change |
|------|------|--------|
| `execute.ts:24-25` | `ocRequest` signature | Add optional `workDir` parameter |
| `execute.ts:38` | `x-opencode-directory` header | Use `workDir ?? OPENCODE_DIR` |
| `execute.ts:234` | `writeAgentsMd` signature | Add `runDir` parameter |
| `execute.ts:295` | `agentsMdPath` | Use `path.join(runDir, "AGENTS.md")` |
| `execute.ts:303+` | `execute()` function | Create `runDir`, pass to all calls, cleanup in finally |

### Directory Structure During Concurrent Runs

```
/app/
├── .runs/
│   ├── run-abc-123/          ← CEO's run
│   │   └── AGENTS.md         ← CEO's JWT + context
│   ├── run-def-456/          ← CTO's run
│   │   └── AGENTS.md         ← CTO's JWT + context
│   └── run-ghi-789/          ← Engineer's run
│       └── AGENTS.md         ← Engineer's JWT + context
├── AGENTS.md                 ← no longer used (can delete)
└── ...
```

Each run is fully isolated. No race conditions.

## Edge Cases

- **Disk space**: `.runs/` dirs are small (~5KB each) and cleaned up immediately. Add a periodic sweep for orphaned dirs older than 1 hour as safety net.
- **OpenCode caching**: If OpenCode caches AGENTS.md by directory, per-run dirs guarantee fresh reads.
- **Concurrent runs for same agent**: `maxConcurrentRuns: 1` in heartbeat config already prevents this, but even if it happens, each run gets its own dir.

## Verification

1. Start two agent runs concurrently (CEO + CTO)
2. Verify each run's AGENTS.md contains the correct agent's JWT and context
3. Verify OpenCode sessions read from their own run directory
4. Verify cleanup happens after run completes
5. Verify no stale .runs/ directories accumulate
