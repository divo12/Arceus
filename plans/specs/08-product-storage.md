# Spec 08 — Product Storage

> **Status**: Draft
> **Depends on**: Spec 02 (Agent Execution), Spec 04 (Persistence), Spec 06 (Sprint Cycle)
> **Unlocks**: Spec 09 (Product Verification), Spec 10 (Deployment), Spec 11 (Product Hosting)

---

## Problem

Today everything dies on restart. Company state is a module-level variable. Artifacts live in a plain array. The workspace is a bare directory wiped on bootstrap. A hosted Arceus cannot be built on top of volatile memory.

The product code that agents generate — the entire point of Arceus — has no versioning, no rollback, no backup, and no export path.

---

## Design Principle

> **Local disk is a cache. Supabase is the source of truth.**

Agents need a real POSIX filesystem to work — you can't `npm install` against an object store. But the local disk doesn't need to be permanent. It just needs to be fast. Supabase provides durable Postgres and S3-compatible Storage. If the server restarts, the workspace is rebuilt from Supabase in seconds.

This eliminates the need for persistent volumes. Ephemeral containers work. The cold-start penalty is 2-5 seconds per company on first access after restart.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│            ARCEUS SERVER (ephemeral)              │
│                                                   │
│  WorkspaceManager                                │
│    ├── provision()     create git repo            │
│    ├── ensureLocal()   restore from Supabase      │
│    ├── commitAndSync() git commit + upload bundle │
│    ├── tagSprint()     git tag + snapshot to DB   │
│    ├── rollback()      restore sprint-N state     │
│    └── export()        tarball + signed URL       │
│                                                   │
│  /tmp/workspaces/{companyId}/                    │
│    .git/   src/   package.json   ...             │
│                                                   │
│  This is a CACHE — rebuilt from Supabase          │
│  on cold start via ensureLocal()                  │
└──────────────────┬───────────────────────────────┘
                   │  fire-and-forget sync
                   ▼
┌──────────────────────────────────────────────────┐
│               SUPABASE                            │
│                                                   │
│  Postgres:                                       │
│    workspaces       — registry of active repos    │
│    artifacts        — reasoning chain (text)      │
│    sprint_snapshots — state at sprint boundaries  │
│    assets           — binary file catalog         │
│                                                   │
│  Storage (S3-compatible):                        │
│    arceus-workspaces/                            │
│      {companyId}/bundles/latest.bundle           │
│      {companyId}/bundles/sprint-1.bundle         │
│      {companyId}/bundles/sprint-2.bundle         │
│    arceus-assets/                                │
│      {companyId}/screenshots/                    │
│      {companyId}/exports/                        │
└──────────────────────────────────────────────────┘
```

---

## Git Strategy

Every company gets a local git repository. Git is the versioning layer.

### Auto-Commit After Each Task

When a task completes, the orchestrator calls:

```
git add -A
git commit -m "[Sprint 1] Build menu component (Developer)"
```

Then a git bundle is created and uploaded to Supabase Storage as `latest.bundle`. The upload is **fire-and-forget** — execution never blocks on network I/O.

### Tag After Each Sprint

When the board approves a sprint:

```
git tag sprint-1
```

A sprint-specific bundle is uploaded as `sprint-1.bundle`. A `sprint_snapshots` row is inserted into Postgres with the full `CompanySnapshot` serialized as JSON.

### Rollback

Board says "go back to Sprint 1":

1. Download `sprint-1.bundle` from Supabase Storage
2. Delete local workspace
3. `git clone` from bundle
4. `git checkout sprint-1`
5. Load `snapshot_data` from `sprint_snapshots` row back into memory
6. Rebuild preview

### Cold Start Recovery

Server restarts. User visits dashboard:

1. `ensureLocal(companyId)` checks: does `/tmp/workspaces/{companyId}/.git` exist?
2. If yes — fast path, return immediately
3. If no — download `latest.bundle` from Supabase Storage
4. `git clone` from bundle into local directory
5. Workspace restored. Resume.

Penalty: ~2-5 seconds per company. Only happens on first access after restart.

---

## Supabase Storage Layout

```
Bucket: arceus-workspaces (private, server-only via service role key)

  {companyId}/
    bundles/
      latest.bundle           ← overwritten on every task commit
      sprint-1.bundle         ← immutable, created on sprint completion
      sprint-2.bundle
      sprint-3.bundle
    exports/
      {timestamp}.tar.gz     ← board-requested code exports

Bucket: arceus-assets (private, signed URLs for board download)

  {companyId}/
    screenshots/
      sprint-1-preview.png
      sprint-2-preview.png
```

**Access model:** All operations use the Supabase service role key. No anon key is ever exposed. Board downloads use signed URLs with 60-minute expiry.

---

## Database Schema (Supabase Postgres + Drizzle ORM)

### `workspaces` — Workspace Registry

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `company_id` | text NOT NULL | Owner company |
| `local_path` | text | Filesystem path (nullable — may not be local) |
| `status` | text | `active` \| `archived` \| `restoring` |
| `latest_bundle_key` | text | Supabase Storage key for latest.bundle |
| `latest_bundle_sha256` | text | Integrity check on restore |
| `latest_bundle_bytes` | integer | Size tracking |
| `current_sprint_num` | integer | Current sprint number (default 0) |
| `current_git_ref` | text | HEAD sha after last sync |
| `last_synced_at` | timestamptz | Last successful Supabase upload |
| `created_at` | timestamptz | Creation time |
| `updated_at` | timestamptz | Last update |

### `artifacts` — Agent Reasoning Chain

Replaces the in-memory `artifacts: Artifact[]` array in `orchestrator.ts`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `company_id` | text NOT NULL | Owner company |
| `sprint_id` | text | Sprint this artifact belongs to |
| `task_id` | text | Task that produced this artifact |
| `agent_role` | text | `ceo` \| `cto` \| `developer` \| `tester` \| ... |
| `kind` | text | `plan` \| `code` \| `output` \| `review` \| `spec` |
| `title` | text NOT NULL | Human-readable title |
| `content` | text NOT NULL | The actual artifact content |
| `file_references` | jsonb | Array of file paths this artifact relates to |
| `created_at` | timestamptz | Creation time |

Indexes: `(company_id, created_at)`, `(company_id, task_id)`.

### `sprint_snapshots` — Sprint Boundary State

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `company_id` | text NOT NULL | Owner company |
| `sprint_number` | integer NOT NULL | Sprint number (1, 2, 3...) |
| `git_tag` | text NOT NULL | `sprint-1`, `sprint-2`, ... |
| `bundle_key` | text | Supabase Storage key for sprint bundle |
| `bundle_sha256` | text | Integrity check |
| `bundle_bytes` | integer | Size |
| `snapshot_data` | jsonb | Full CompanySnapshot serialized |
| `file_manifest` | jsonb | `[{path, size}]` — lightweight file index |
| `status` | text | `active` \| `rolled_back` |
| `created_at` | timestamptz | Creation time |

Indexes: `(company_id, sprint_number)`.

### `assets` — Binary File Catalog

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `company_id` | text NOT NULL | Owner company |
| `provider` | text | `supabase` (default) |
| `object_key` | text NOT NULL | Storage key |
| `content_type` | text NOT NULL | MIME type |
| `byte_size` | integer NOT NULL | File size |
| `sha256` | text NOT NULL | Content hash |
| `original_filename` | text | Original name for UX |
| `namespace` | text | `screenshots` \| `exports` \| `misc` |
| `created_by_agent` | text | Agent role that created this |
| `created_at` | timestamptz | Creation time |

Unique constraint: `(company_id, object_key)`.

---

## WorkspaceManager API

```typescript
interface WorkspaceManager {
  // Lifecycle
  provision(companyId: string): Promise<WorkspaceInfo>;
  ensureLocal(companyId: string): Promise<string>;  // returns local path
  archive(companyId: string): Promise<void>;

  // Task-level
  commitAndSync(
    companyId: string,
    taskId: string,
    agentRole: string,
    message: string
  ): Promise<string>;  // returns commit sha

  // Sprint-level
  tagSprint(
    companyId: string,
    sprintNumber: number,
    snapshot: CompanySnapshot
  ): Promise<void>;

  rollbackToSprint(
    companyId: string,
    sprintNumber: number
  ): Promise<CompanySnapshot>;  // returns restored snapshot

  // Export
  exportTarball(companyId: string): Promise<ExportResult>;

  // Query
  getWorkspaceInfo(companyId: string): Promise<WorkspaceInfo | null>;
  getLocalPath(companyId: string): string;
  listSprintSnapshots(companyId: string): Promise<SprintSnapshot[]>;
  getDiff(companyId: string, fromSprint: number, toSprint: number): Promise<string>;
}
```

**Singleton access:** Cached at module level. Configuration read once at creation.

---

## Orchestrator Integration Points

Three surgical insertions into `orchestrator.ts`:

### 1. Execution Start

When `beginExecution()` is called:

```typescript
const localPath = await getWorkspaceManager().ensureLocal(snapshot.company.id);
// Use localPath instead of hardcoded productDir for all file operations
```

This replaces the hardcoded `const productDir = resolve(workspaceRoot, "workspace")`.

### 2. After Task Completion

When a task transitions to `completed` status:

```typescript
await getWorkspaceManager().commitAndSync(
  companyId,
  task.id,
  task.assignedRole,
  `[Sprint ${sprintNum}] ${task.title} (${task.assignedRole})`
);
```

### 3. After Board Approves Sprint

When `approveBoardReview()` is called:

```typescript
await getWorkspaceManager().tagSprint(
  companyId,
  currentSprintNumber,
  getSnapshot()
);
```

---

## Server API Routes

### New Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workspace/status` | Workspace info: path, git ref, sync status, Supabase configured |
| `GET` | `/api/workspace/snapshots` | List all sprint snapshots for active company |
| `POST` | `/api/workspace/rollback/:sprint` | Rollback to sprint N, restore snapshot, rebuild preview |
| `POST` | `/api/workspace/export` | Create tarball, upload to Supabase, return signed URL |
| `GET` | `/api/workspace/diff/:from/:to` | Git diff between two sprints |

### Modified Routes

| Route | Change |
|-------|--------|
| `POST /api/company/bootstrap` | Call `workspaceManager.provision()` instead of `resetProductWorkspace()` |
| `DELETE /api/company` | Call `workspaceManager.archive()` instead of `resetProductWorkspace()` |
| `GET /api/product/overview` | Use `workspaceManager.getLocalPath()` instead of hardcoded `productDir` |
| `GET /api/artifacts` | Read from Postgres (if configured) with in-memory fallback |
| `POST /api/artifacts` | Write to Postgres AND in-memory |

---

## Artifact Persistence

Artifacts move from a plain array to a dual-write pattern:

```typescript
function addArtifact(agent, kind, title, content) {
  const artifact = { id: uuid(), agent, kind, title, content, createdAt: now() };

  // Always: keep in memory for current session (fast reads)
  inMemoryArtifacts.push(artifact);

  // If Supabase: also persist to Postgres (fire-and-forget)
  if (isSupabaseConfigured()) {
    void db.insert(artifacts).values({
      companyId: getSnapshot().company.id,
      taskId: currentTaskId,
      agentRole: agent,
      kind, title, content,
    });
  }

  return artifact;
}
```

On cold start, `getArtifacts()` loads from Postgres if in-memory is empty.

---

## Configuration

All Supabase connection variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`) are defined in **Spec 04 — Infrastructure Provider: Supabase**. This spec adds only workspace-specific config:

### Additional Environment Variables (All Optional)

```env
# Storage buckets (defaults shown)
SUPABASE_STORAGE_BUCKET=arceus-workspaces
SUPABASE_ASSETS_BUCKET=arceus-assets

# Workspace root (default: /tmp/workspaces)
ARCEUS_WORKSPACE_ROOT=/tmp/workspaces
```

### Degradation Modes

| Config Present | Behavior |
|----------------|----------|
| All Supabase vars | Full persistence: git bundles synced, artifacts in Postgres, snapshots in DB, signed URL exports |
| DB URL only | Postgres persistence for artifacts + snapshots. No bundle sync. Local workspace only. |
| Storage vars only | Bundle sync to Supabase. No DB persistence. Artifacts stay in-memory. |
| Nothing | Current behavior — everything in-memory, local filesystem. No data survives restart. |

The universal gate is `isSupabaseConfigured()` which checks for `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Individual features check for their specific dependencies (`SUPABASE_DB_URL` for Postgres, bucket vars for Storage).

---

## File Structure

### New Files

```
packages/db/src/schema/        — (package defined in Spec 04, these files are NEW)
  workspaces.ts
  sprint-snapshots.ts
  assets.ts

apps/api/src/
  git-ops.ts                   — git command wrappers (init, add, commit, tag, bundle, clone)
  workspace-manager.ts         — core workspace lifecycle service
  supabase-storage.ts          — Supabase Storage upload/download/signedUrl helpers
```

### Modified Files

```
apps/api/src/config.ts         — add optional Supabase env vars
apps/api/src/orchestrator.ts   — 3 insertion points for workspace manager
apps/api/src/server.ts         — replace productDir, add 4 routes, wire artifact persistence
apps/api/package.json          — add @arceus/db dependency
packages/contracts/src/domain.ts — add WorkspaceInfo, SprintSnapshot, ExportResult schemas
package.json (root)            — add packages/db to workspaces
```

---

## Implementation Phases

### Phase 1: Git Foundation (No Supabase Required)

Build `git-ops.ts` and `workspace-manager.ts` in local-only mode. Provision creates git repos, commitAndSync creates commits, tagSprint creates tags. Everything works without any Supabase dependency.

**Verify:** Create company, execute sprint, check git log and tags in workspace directory.

### Phase 2: Database Layer

Add Spec 08 schema files (workspaces, sprint_snapshots, assets) to the `packages/db` package defined in Spec 04. Uses the same `getDb()` and `getSupabaseClient()` singletons. Wire artifact persistence with dual-write. Wire sprint snapshot persistence in tagSprint.

**Verify:** Artifacts appear in Supabase Postgres. Sprint snapshots contain serialized state.

### Phase 3: Storage Sync

Build `supabase-storage.ts`. Wire bundle upload into commitAndSync (fire-and-forget). Wire sprint bundle upload into tagSprint. Implement ensureLocal cold-start restore.

**Verify:** Kill server, restart, workspace restores from Supabase bundle. Artifacts load from DB.

### Phase 4: Board Features

Add rollback, export, diff, and snapshot list routes. Wire into dashboard.

**Verify:** Rollback restores Sprint N state. Export returns downloadable tarball.

---

## Cost Estimate

For 100 companies, each with 5 sprints:

| Resource | Calculation | Total |
|----------|-------------|-------|
| Git bundles | 100 companies x 6 bundles x 200KB | ~120 MB |
| Screenshots | 100 companies x 5 sprints x 500KB | ~250 MB |
| Exports | On-demand, cleaned after 24h | ~50 MB |
| **Supabase Storage total** | | **~420 MB** |
| Postgres rows | ~5000 artifacts + ~500 snapshots | **< 50 MB** |

Supabase free tier: 1 GB storage, 500 MB database. **100 companies fit in free tier.**
Supabase Pro ($25/mo): 100 GB storage, 8 GB database. **Handles ~25,000 companies.**

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| Supabase Storage upload fails | Log warning, continue. Retry on next commit. Workspace is still local. |
| Supabase Postgres insert fails | Log warning, continue. In-memory state is authoritative at runtime. |
| Bundle download fails on cold start | Return error to user. Suggest manual company reset. |
| Bundle SHA256 mismatch | Fall back to previous sprint bundle. Log alert. |
| Git command fails | Throw typed `WorkspaceError` with code. Orchestrator catches and logs. |
| Disk full | Check disk usage before provision. Reject with clear error at 90% capacity. |

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Git repo per company, not filesystem snapshots | Git gives versioning, rollback, diff, and tags for free |
| 2 | Git bundles to Supabase, not raw file upload | Bundles are compact, self-contained, and restore the full history |
| 3 | Fire-and-forget uploads | Execution speed is sacred. Network I/O never blocks agent work. |
| 4 | Dual-write for artifacts | In-memory for speed during session, Postgres for durability across restarts |
| 5 | ensureLocal() lazy restore | Only pay cold-start cost when workspace is actually needed |
| 6 | No persistent volumes | Supabase Storage replaces the need for volume mounts. Simpler ops. |
| 7 | All Supabase optional | Must run without Supabase for local development. Graceful degradation. |
| 8 | Snapshot serialized as JSON in DB | Avoids normalizing 15 tables in Phase 1. Full normalization is Phase 5. |
| 9 | One Supabase project for everything | Postgres + Storage + (future) Auth from a single provider. One bill. |

---

## Future Extensions (Post-MVP)

- **GitHub push:** "Export to GitHub" creates a repo on user's GitHub with full sprint history
- **Full table normalization:** Replace JSON snapshot column with proper relational tables from Spec 04
- **Multi-company per server:** Workspace LRU cache evicts least-recently-used companies from local disk
- **Supabase Realtime:** Dashboard live updates via Postgres change notifications instead of custom SSE
- **Supabase Auth:** Replace the auth skip with Supabase Auth (email, OAuth, RLS)
- **Supabase Edge Functions:** Run preview builds in Supabase's serverless runtime
