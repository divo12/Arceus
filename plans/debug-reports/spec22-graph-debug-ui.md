# Spec 22 — Graph Execution Debug UI: Change Summary

**Date:** 2026-04-18  
**Branch:** dev/meeting-pipeline  
**Base commit:** 3f7b40d  

## New Files

| File | Purpose |
|------|---------|
| `apps/api/src/graph-store.ts` | In-memory `ExecutionGraphStore` — nodes, edges, beats, decisions, file changes, meetings, memory writes. SSE event bus. |
| `apps/api/src/graph-emitter.ts` | Thin emission helpers called from orchestrator to translate runtime events into graph mutations. |
| `apps/web/app/debug/page.tsx` | Debug graph page route. |
| `apps/web/components/debug-graph.tsx` | React Flow DAG with dagre auto-layout, SSE streaming, 10s periodic re-sync, legend overlay, edge click handler. |
| `apps/web/components/debug-node.tsx` | Custom node renderer — sprint planning (amber), meeting (teal), regular task nodes. Status-colored badges, beat/file/meeting/memory counters. |
| `apps/web/components/debug-edge.tsx` | Custom edge renderer — 4 edge styles (dependency, artifact_flow, rework, escalation) with arrow markers. |
| `apps/web/components/debug-detail-panel.tsx` | Bottom detail panel — Overview, Beats, Decisions, Files tabs + inline Meetings block with memory-write down-arrows. |
| `plans/specs/22-graph-execution-debug-ui.md` | Spec document. |

## Modified Files

### `apps/api/src/orchestrator.ts` (+931 / -164)
- **Graph instrumentation:** Sprint start/complete, node creation, status transitions, beat start/complete, decisions, file changes, meetings, memory writes — all emitted to graph store.
- **Artifact flow edges:** When `setTaskStatus("completed")` propagates artifacts to children or dependency-met tasks, `emitGraphArtifactConsumed()` creates `artifact_flow` edges on the graph (PM→Dev, UIDesigner→Dev, etc.).
- **Workspace file writing:** New `writeArtifactToWorkspace()` helper writes specialist reports as markdown files to `workspace/docs/`:
  - PM acceptance spec → `docs/pm-acceptance-spec.md`
  - UI design direction → `docs/ui-design-direction.md`
  - Tester verification report → `docs/tester-report.md`
  - Marketing launch readiness → `docs/marketing-report.md`
- **File change recording for artifact writes:** `writeArtifactToWorkspace` calls `emitGraphFileChanges()` so report files appear in graph nodes' Files tab.

### `apps/api/src/graph-store.ts`
- Added `addEdge()` public method for creating artifact_flow edges with deduplication and SSE notification.

### `apps/api/src/graph-emitter.ts`
- Added `emitGraphArtifactConsumed()` — creates `artifact_flow` edges when downstream tasks consume upstream artifacts.
- Fixed `emitGraphArtifactProduced()` — removed dead "lazy edge creation" code that never executed.
- All meetings now create graph nodes (not just key ceremonies).
- `emitGraphMemoryWrite` fires synchronously before hippocampus to avoid lost events.

### `apps/api/src/company-state.ts` (+18 / -1)
- **New `ARCEUS_PERSISTENCE_MODE` flag:** Gates company state DB reads/writes.
  - `local` (default): in-memory only — no DB hydration or persistence. Prevents cofounder state pollution across shared Supabase.
  - `db`: original behavior — hydrate from DB on startup, persist mutations.
- Replaced `isDatabaseConfigured()` guards with `isCompanyStatePersistenceEnabled()` in all 4 exported functions.

### `apps/api/src/server.ts` (+66)
- SSE streaming endpoint `/api/debug/graph/stream`.
- Full graph snapshot endpoint `/api/debug/graph/:sprintId`.
- Startup log for persistence mode.

### `apps/api/src/router.ts` (+16)
- Graph debug API routes registration.

### `apps/api/src/preview.ts` (+40 / -40)
- Preview evidence URL and probe health exports for graph instrumentation.

### `apps/web/components/sidebar.tsx` / `sidebar.js`
- Added Debug Graph navigation link.

### `apps/web/package.json` / `package-lock.json`
- Added `@xyflow/react`, `dagre`, `@types/dagre` dependencies.

## Bug Fixes

1. **No artifact_flow edges between PM→Dev, UIDesigner→Dev, Tester→Dev** — `emitGraphArtifactProduced` always passed `edge: null`. Fixed by creating edges at consumption time in `setTaskStatus`.
2. **PM spec / tester report / design direction not written to workspace** — `addArtifact` only persisted to DB/Supabase. Now writes markdown files to `workspace/docs/`.
3. **No file changes recorded on specialist tasks** — Only developer workspace polling tracked files. Now artifact writes emit file changes.
4. **Meetings tab hidden useful info** — Redesigned: meetings are inline blocks showing participants; memory writes appear as down-arrow connectors from their trigger.
5. **Stale company state after reset (cofounder pollution)** — Shared Supabase DB caused hydration of another developer's sprint. Fixed with `ARCEUS_PERSISTENCE_MODE=local` flag (default).
6. **Missing memory write events** — `emitGraphMemoryWrite` was inside `.then()` callback; moved to fire synchronously.
7. **Node status stuck / not updating** — Added 10s periodic re-sync from server.
