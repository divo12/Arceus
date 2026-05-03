# Spec 36 — Agentic Git Operations + GitHub Publishing

**Status:** Draft
**Owner:** Board
**Date:** 2026-05-03
**Supersedes:** Spec 08 partial (orchestrator-driven `commitAndSync` / `tagSprint`)
**Unblocks:** Spec 37 (Vercel deployment), per-company hosting, multi-tenant Arceus

---

## 1. North-star

The agent who built the change commits and tags it. The founder's GitHub holds the company's full git history. Spec 08 set this up as an orchestrator-driven pipeline; in practice the per-company isolation never landed and the export path is gated on Supabase Storage. Spec 36 finishes the substrate (per-company workspace dirs + local-fallback tarball), exposes commit/tag/publish as MCP tools, and removes the orchestrator-driven hooks.

Two phases. Phase A is the prerequisite: without per-company isolation and agent-authored commits there is nothing meaningful to push. Phase B builds the GitHub publish path on top.

| Phase | Goal | Key tools | Net LoC |
|---|---|---|---:|
| **A. Git operations as employee tools** | Agentic commit + sprint tag, per-company workspace isolation, local export | `workspace_commit`, `workspace_tag_sprint`, `workspace_status` | +400, −40 |
| **B. GitHub MCP** | One-click publish of git history to founder's GitHub repo | `github_publish`, `github_status`, `github_open_pr` | +450 |

Each phase ships independently. Phase A is shippable on its own and immediately useful (real audit trail, multi-tenant readiness, deploy MCP unblocked).

---

## 2. Why the current design isn't working

`apps/api/src/workspace/manager.ts` defines `provision`, `commitAndSync`, `tagSprint`, `exportTarball` per Spec 08. Three load-bearing gaps:

| Issue | Symptom |
|---|---|
| `legacyProductDir` is one shared dir at `repoRoot/workspace` | Multi-company collides on disk; commits cross-pollinate |
| `commitAndSync` fires from orchestrator after task `completed` | Agent has no say in what's committed or how the message reads |
| `exportTarball` throws `"Workspace export is unavailable until the first bundle sync completes."` unless Supabase Storage env vars set | Hard dep on remote storage; deploy pipelines blocked in local dev |
| `tagSprint` runs from `lifecycle.ts:finalizeSprintCompletion` | Tag fires deterministically; no way to skip on cancelled sprints, re-tag after rework, or edit the tag message |
| Commit message is `[${taskId}] ${message} (${agentRole})` | Forensically thin — no scope, no co-authors, no `Refs:` trailer |

**The deeper issue:** versioning is treated as a deterministic backend pipeline coupled to task-status mutations. The agent who built the change doesn't author the commit. Fine for single-tenant demo, broken for hosting.

---

## 3. Phase A — Git operations as employee tools

### 3.1 Per-company workspace isolation (substrate)

```
/tmp/workspaces/                      ⭐ persistenceConfig.workspace.root
├── {companyId-A}/                     ⭐ NEW — live working tree + .git per company
│   ├── .git/
│   ├── package.json
│   └── src/...
├── {companyId-B}/
│   └── ...
└── _cache/{companyId-A}/bundles/      existing — bundle artifacts stay separate
```

Methods that change in `apps/api/src/workspace/manager.ts`:

- `provision(companyId)` → `mkdir` per-company dir + `git init` per-company (was: `ensureGitRepository(legacyProductDir)`)
- `ensureLocal(companyId)` → resolve per-company dir; restore from bundle if missing
- `commitAndSync(companyId, taskId, agentRole, message)` → operate on per-company dir
- `tagSprint(companyId, sprintNumber, ...)` → tag in per-company dir
- `archive(companyId)` → only removes `/tmp/workspaces/{companyId}/` (today: would wipe siblings via shared-dir cleanup)
- `getLegacyProductDir()` → keep as deprecated shim returning `getCompanyWorkspacePath(activeCompanyId)` so existing route callers don't break during migration

### 3.2 Local-fallback `exportTarball`

Today's code throws unless Supabase Storage is configured. Add a local mode:

```typescript
async exportTarball(companyId: string): Promise<ExportResult> {
  if (this.hasRemoteBundle(companyId)) return this.signedUrlFromStorage(companyId);
  // NEW: local fallback — tar the live working tree, exclude .git/node_modules
  return this.tarLocalWorkspace(companyId);
}
```

`tarLocalWorkspace` runs `tar -czf /tmp/workspaces/_exports/{companyId}.tar.gz --exclude=.git --exclude=node_modules .` and returns a `file://` URL or stream. Removes the hard Supabase dep for downstream deploy paths.

### 3.3 MCP tools (in `packages/arceus-mcp/src/tools/workspace.ts`)

```typescript
server.registerTool("workspace_commit", {
  description:
    "Stage all changes in the company workspace and create a git commit. " +
    "Pass a clear message describing WHAT changed and WHY. The server " +
    "auto-stamps your role as a Co-authored-by trailer. Rejects empty " +
    "commits. Available to roles that mutate the workspace (developer, " +
    "ui_designer, marketing).",
  inputSchema: {
    message: z.string().min(8).max(500),
    relatedTaskId: z.string().optional(),
    body: z.string().optional(),
  },
}, async ({ message, relatedTaskId, body }) => {
  /* POST /api/workspace/commit — see route below */
});

server.registerTool("workspace_tag_sprint", {
  description:
    "Tag the current HEAD as sprint-{N}. CTO or PM role only. " +
    "Server enforces: sprint must be `completed`, preview probe must pass, " +
    "at least one new commit since previous sprint tag.",
  inputSchema: {
    sprintNumber: z.number().int().nonnegative(),
    message: z.string().min(8).max(500).optional(),
  },
}, async (...) => { /* POST /api/workspace/tag-sprint */ });

server.registerTool("workspace_status", {
  description:
    "Read-only — returns { branch, dirtyFiles[], lastCommitSha, " +
    "lastTagName, untaggedCommitCount }. Use before workspace_commit " +
    "to confirm there is something to commit.",
  inputSchema: {},
}, async () => { /* GET /api/workspace/status */ });
```

### 3.4 Server-side route invariants

```typescript
// apps/api/src/routes/internal-mcp/workspaces.routes.ts (extend existing)

app.post("/api/workspace/commit", async (req, reply) => {
  const role = req.mcp?.role;
  const caps = ROLE_CAPABILITIES[role];
  if (!caps?.canMutateWorkspace) {
    return reply.code(403).send(failure(
      "Workspace mutation not permitted for this role.",
      "governance", "never", "role_can_mutate_workspace",
    ));
  }

  const companyId = req.mcp!.companyId;
  const dir = workspaceManager.getLocalPath(companyId);
  const fileChanges = await getDirtyFiles(dir);
  if (fileChanges.length === 0) {
    return reply.code(422).send(failure(
      "Empty commit rejected — no staged changes.",
      "validation", "always", "has_dirty_files",
    ));
  }

  const { message, relatedTaskId, body } = req.body;
  const fullMessage = [
    message,
    body ? `\n${body}` : null,
    relatedTaskId ? `\nRefs: ${relatedTaskId}` : null,
    `\nCo-authored-by: ${role} <${role}@arceus>`,
  ].filter(Boolean).join("");

  const sha = await commitAllChanges(dir, fullMessage);

  // Existing dual-write — bundle to remote storage if configured
  await workspaceManager.commitAndSync(companyId, relatedTaskId ?? "ad-hoc", role, fullMessage);

  return reply.send(success({ sha, fileChanges, message: fullMessage }));
});

app.post("/api/workspace/tag-sprint", async (req, reply) => {
  const role = req.mcp?.role;
  if (role !== "cto" && role !== "pm") {
    return reply.code(403).send(failure("Sprint tagging requires CTO or PM role.", ...));
  }

  const { sprintNumber, message } = req.body;
  const companyId = req.mcp!.companyId;
  const snapshot = await buildSnapshotView(companyId);
  const sprint = snapshot.sprints.find(s => s.number === sprintNumber);

  // Invariants
  if (!sprint || sprint.status !== "completed") {
    return reply.code(422).send(failure(`Sprint ${sprintNumber} not in completed state.`, ...));
  }
  const probe = await probePreviewHealth(8000);
  if (!probe.reachable) {
    return reply.code(422).send(failure(`Preview unreachable: ${probe.error ?? "unknown"}`, ...));
  }
  const dir = workspaceManager.getLocalPath(companyId);
  const untagged = await getCommitsSinceTag(dir, `sprint-${sprintNumber - 1}`);
  if (untagged.length === 0) {
    return reply.code(422).send(failure("No new commits since previous sprint tag.", ...));
  }

  const tagName = `sprint-${sprintNumber}`;
  const tagMessage = message ?? `Sprint ${sprintNumber} — ${sprint.title}`;
  await tagWorkspace(dir, tagName, tagMessage);
  await workspaceManager.tagSprint(companyId, sprintNumber, snapshot);

  return reply.send(success({ tagName, sha: await gitHead(dir), untaggedCommitCount: untagged.length }));
});
```

### 3.5 Schema

```sql
-- migrations/0022_tasks_commit_sha.sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS commit_sha text;
CREATE INDEX IF NOT EXISTS tasks_commit_sha_idx ON tasks (commit_sha) WHERE commit_sha IS NOT NULL;
```

The route handler for `task_complete` accepts `evidence.commitSha` and persists it. Joins tasks ↔ git history without a separate table.

### 3.6 Capability flags

```typescript
// apps/api/src/agents/role-capabilities.ts
canMutateWorkspace: boolean,    // developer | ui_designer | marketing
canTagSprint: boolean,          // cto | pm
```

### 3.7 Per-role HEARTBEAT.md additions

**`developer.md`** (also `ui_designer.md`, `marketing.md`):

```markdown
## After completing a task

If you wrote files, commit them BEFORE marking the task completed:

1. workspace_status → confirm dirtyFiles is non-empty
2. workspace_commit {
     message: "<concise verb-led summary, ≤72 chars>",
     body: "<optional multi-line WHY>",
     relatedTaskId: $ARCEUS_TASK_ID
   }
3. task_complete { taskId: $ARCEUS_TASK_ID, evidence: { commitSha } }

If workspace_commit returns 422 "empty commit", task_complete shouldn't
be called either — investigate why no files changed.
```

**`cto.md`** (also `pm.md`):

```markdown
## When a sprint is marked completed

If $ARCEUS_WAKE_REASON = "sprint_completed":

1. workspace_status → confirm last commit is recent and untaggedCommitCount > 0
2. sprint_run_qa_gate { sprintId } → read-only check, don't proceed if failures
3. workspace_tag_sprint {
     sprintNumber: <from snapshot>,
     message: "<short summary of what landed>"
   }
4. chat_post { content: "Sprint <N> tagged — <commitCount> commits" }

If 422 "no untagged commits": skip — nothing meaningful to tag.
If 422 "preview unreachable": file a bug task, don't tag.
```

### 3.8 Phase A migration order

| # | Step | Risk |
|---|---|---|
| A.1 | Per-company workspace isolation (`legacyProductDir` → `getCompanyWorkspacePath(companyId)`) | **Medium.** ~150 LoC. Touches manager.ts + bootstrap + state. Active-company seam already exists; resolves through it. |
| A.2 | Local-fallback `exportTarball` | Low. Pure addition, no behavior change when storage IS configured. |
| A.3 | `tasks.commit_sha` column | Low. Additive. |
| A.4 | Ship `workspace_commit` + `workspace_status` MCP tools + routes (coexist with orchestrator-driven path) | Low. Agents can use them but don't have to. |
| A.5 | Update developer/ui_designer/marketing HEARTBEAT.md to call `workspace_commit` before `task_complete`. Soak 7 days. | Low. Per-role; flag-gated. |
| A.6 | Remove orchestrator-driven `commitAndSync` after task completion. Gated on telemetry: >95% of `task_complete` calls have `evidence.commitSha`. | **Medium.** Point of no return for auto-commit. Rollback = revert. |
| A.7 | Ship `workspace_tag_sprint` tool + route. Coexist with `lifecycle.ts:tagCurrentSprintSnapshot`. | Low. |
| A.8 | Update cto/pm HEARTBEAT.md to call `workspace_tag_sprint` on `sprint_completed` wake. Soak 7 days. | Low. |
| A.9 | Remove orchestrator-driven `tagCurrentSprintSnapshot` from `finalizeSprintCompletion`. | Medium. Same pattern as A.6. |

**Calendar:** ~3 weeks with two 7-day soak windows. ~6 active engineering days.

---

## 4. Phase B — GitHub MCP

### 4.1 Auth model

```sql
-- migrations/0023_companies_deploy_config.sql
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deploy_config jsonb;
COMMENT ON COLUMN companies.deploy_config IS
  'Encrypted credentials + project metadata for GitHub/Vercel publishing. ' ||
  'Updated only via admin-auth routes.';
```

```typescript
// shape stored in deploy_config:
{
  github?: {
    tokenEncrypted: string;     // AES-GCM with ARCEUS_SECRET_KEY
    owner: string;
    repo: string;
    visibility: "public" | "private";
    lastPushedSha?: string;
    lastPushedAt?: string;
  };
  vercel?: { ... };  // Phase C / Spec 37
}
```

Founder configures via **admin-auth-gated** route (not agent-callable):

```
POST /api/admin/companies/:id/deploy/github/connect
Authorization: Bearer ${ARCEUS_TOKEN}
Body: {
  ownerLogin: string,
  repoName: string,                  // optional — defaults to slugified company name
  visibility: "public" | "private",
  authMode: "pat" | "github_app",
  personalAccessToken?: string,      // when authMode = "pat"
  installationId?: number             // when authMode = "github_app"
}
```

**Two auth modes:**

| Mode | Setup | Scaling | Recommendation |
|---|---|---|---|
| Personal Access Token | seconds — paste a `ghp_…` token | One token per founder, shared rate limits | **Default for v1.** |
| GitHub App | minutes — install Arceus GitHub App on the org | Per-installation tokens, better rate limits + scoping | Migrate at ~10 customers |

Token storage: AES-GCM-encrypted with `ARCEUS_SECRET_KEY` env. Same envelope as the admin token. **Never** logged to audit ledger; idempotency-key derivation must filter on a `secretFields: ["personalAccessToken", "installationId", "envVars"]` allow-list.

### 4.2 MCP tools (in `packages/arceus-mcp/src/tools/github.ts`)

```typescript
server.registerTool("github_publish", {
  description:
    "Push the company's workspace git history to its configured GitHub repo. " +
    "Creates the repo on first call (visibility from deploy_config), then " +
    "pushes all commits + tags. Force-push is NOT supported. CTO role only.",
  inputSchema: {
    branch: z.string().default("main"),
    includeTags: z.boolean().default(true),
  },
}, async ({ branch, includeTags }) => { /* POST /api/github/publish */ });

server.registerTool("github_status", {
  description:
    "Read the current GitHub publish state — last pushed sha, ahead/behind " +
    "counts, repo URL. Read-only.",
  inputSchema: {},
}, async () => { /* GET /api/github/status */ });

server.registerTool("github_open_pr", {
  description:
    "Open a PR from a feature branch into main. Used when a sprint is " +
    "marked completed but the founder wants human review before merging. " +
    "CTO or PM role.",
  inputSchema: {
    fromBranch: z.string(),
    title: z.string().min(8).max(200),
    body: z.string().optional(),
    base: z.string().default("main"),
  },
}, async (...) => { /* POST /api/github/pr */ });
```

### 4.3 Server-side route invariants

```typescript
// apps/api/src/routes/internal-mcp/github.routes.ts (NEW)

app.post("/api/github/publish", async (req, reply) => {
  const role = req.mcp?.role;
  if (role !== "cto") {
    return reply.code(403).send(failure("CTO role only.", "governance", "never", "role_is_cto"));
  }

  const companyId = req.mcp!.companyId;
  const config = await getDeployConfig(companyId);
  if (!config?.github) {
    return reply.code(422).send(failure(
      "GitHub not configured. Founder must run POST /api/admin/companies/:id/deploy/github/connect first.",
      "config_missing", "always", "github_connected",
    ));
  }

  // Invariant: must have at least one sprint tag before publishing
  const dir = workspaceManager.getLocalPath(companyId);
  const tags = await gitTagsList(dir);
  if (!tags.some(t => t.startsWith("sprint-"))) {
    return reply.code(422).send(failure(
      "Cannot publish — no sprint tags yet. Tag at least one sprint first.",
      "validation", "always", "has_sprint_tag",
    ));
  }

  const result = await pushToGitHub({ companyId, dir, config, branch: req.body.branch, includeTags: req.body.includeTags });

  // Persist last-pushed state
  await persistDeployConfig(companyId, {
    ...config,
    github: { ...config.github, lastPushedSha: result.pushedSha, lastPushedAt: new Date().toISOString() },
  });

  return reply.send(success(result));
});

app.post("/api/admin/companies/:id/deploy/github/connect", { preHandler: requireAdminAuth }, async (req, reply) => {
  // Encrypt token + store in companies.deploy_config
});
```

### 4.4 Implementation core

```typescript
// apps/api/src/deploy/github.ts (NEW)
import { Octokit } from "octokit";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

interface PublishInput {
  companyId: string;
  dir: string;
  config: {
    github: { token: string; owner: string; repo: string; visibility: "public" | "private" };
  };
  branch: string;
  includeTags: boolean;
}

export async function pushToGitHub(input: PublishInput) {
  const { dir, config: { github }, branch, includeTags } = input;
  const octokit = new Octokit({ auth: github.token });

  // 1. Create repo if missing (idempotent on 422 already-exists)
  let repoExists = true;
  try {
    await octokit.rest.repos.get({ owner: github.owner, repo: github.repo });
  } catch (e) {
    if ((e as { status?: number }).status === 404) repoExists = false;
    else throw e;
  }
  if (!repoExists) {
    await octokit.rest.repos.createForAuthenticatedUser({
      name: github.repo,
      private: github.visibility === "private",
      auto_init: false,
    });
  }

  // 2. Configure remote (idempotent)
  const remoteUrl = `https://${github.token}@github.com/${github.owner}/${github.repo}.git`;
  await exec("git", ["-C", dir, "remote", "remove", "origin"], { reject: false } as never);
  await exec("git", ["-C", dir, "remote", "add", "origin", remoteUrl]);

  // 3. Push branch (NOT force-push)
  await exec("git", ["-C", dir, "push", "origin", branch]);

  // 4. Push tags if requested
  if (includeTags) {
    await exec("git", ["-C", dir, "push", "origin", "--tags"]);
  }

  // 5. Read pushed sha
  const { stdout: sha } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);

  return {
    repoUrl: `https://github.com/${github.owner}/${github.repo}`,
    branch,
    pushedSha: sha.trim(),
    tagsIncluded: includeTags,
  };
}
```

### 4.5 Capability flag

```typescript
canPublishToGithub: boolean,    // true: cto. false: everyone else.
```

### 4.6 Per-role HEARTBEAT.md addition (cto.md)

```markdown
## When $ARCEUS_WAKE_REASON = "sprint_completed":
1. workspace_status        → confirm everything is committed
2. sprint_run_qa_gate      → confirm verdicts pass
3. workspace_tag_sprint    → tag sprint-N at HEAD                  (Phase A)
4. github_status           → check ahead/behind, repo URL
5. github_publish { branch: "main", includeTags: true }            (Phase B)
6. chat_post { content: "Sprint <N> live on github.com/<owner>/<repo>" }

If github_publish returns 422 "config_missing":
  chat_post { content: "GitHub not connected — founder must run admin /deploy/github/connect", mode: "ask" }
If 409 "diverged":
  chat_post { content: "Remote diverged — manual intervention required", mode: "ask" }
  (NEVER force-push.)
If 429 rate-limited:
  beat_request_continue { reason: "github rate limit, retry in N seconds" }
```

### 4.7 Phase B failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Push rejected (remote diverged) | non-zero exit from `git push` | Tool returns 409; CTO posts a chat asking founder to resolve manually. **Never force-push.** |
| Token revoked | 401 from octokit | Tool returns 422 `config_missing`; founder reconnects |
| Rate-limited | 403 with `x-ratelimit-*` headers | Tool returns 429 with retry-after; engine wakes CTO again on `wake_reason=liveness_continuation` after the window |
| Repo created but push failed | partial state | createForAuthenticatedUser is idempotent on 422; remote-add is reset every call |
| Secret committed to public repo | n/a today — would leak | Phase A.4 enhancement: server-side scan via `git diff --staged` against secret patterns (`sk-`, `ghp_`, `xoxb-`); 422 with offending file path. |

### 4.8 Phase B migration order

| # | Step | Risk |
|---|---|---|
| B.1 | `companies.deploy_config` schema migration + encryption helpers | Low |
| B.2 | Admin-auth route for connecting GitHub (founder-facing) | Low |
| B.3 | Ship `github_publish` + `github_status` tools + routes | Low |
| B.4 | Update CTO HEARTBEAT.md to call `github_publish` after `workspace_tag_sprint`. Soak 7 days. | Low |
| B.5 | Ship `github_open_pr` tool + route (optional, used when founder wants human review) | Low |

**Calendar:** ~1 week. ~3 active engineering days.

---

## 5. Schema migrations summary

| File | Phase | Adds |
|---|---|---|
| `0022_tasks_commit_sha.sql` | A | `tasks.commit_sha text` + partial index |
| `0023_companies_deploy_config.sql` | B | `companies.deploy_config jsonb` |

---

## 6. NPM dependency footprint

| Phase | New deps | Size (gzipped) |
|---|---|---|
| A | none — uses existing `child_process` | 0 |
| B | `octokit` | ~150 KB |

Both well-maintained, MIT-licensed. `octokit` is the official GitHub SDK.

---

## 7. Concrete deletions (the win in numbers)

| File | What gets deleted |
|---|---|
| `apps/api/src/orchestration/state.ts` | `legacyProductDir` becomes a deprecated shim, ~5 LoC of dead branches in manager.ts |
| `apps/api/src/persistence/control-plane/snapshot.ts` (or wherever the auto-commit hook lives) | The "after task completes, fire commitAndSync" listener, ~25 LoC |
| `apps/api/src/sprints/lifecycle.ts:tagCurrentSprintSnapshot` | The orchestrator-driven tag call, ~25 LoC |
| `apps/api/src/workspace/manager.ts:exportTarball` | "throw if no bundle" branch removed; falls back to local tar, +30 / −3 LoC |

**Net Phase A: −40 LoC orchestrator hooks, +400 LoC tools/routes/runbooks.**
**Net Phase B: +450 LoC tools/routes/admin-auth/encryption.**

---

## 8. What this unlocks

| Use case | Today | After Spec 36 |
|---|---|---|
| **Deploy MCP** (Spec 37 — Vercel) | Blocked: `exportTarball` throws without Supabase | Works against per-company workspace + local tarball |
| **Diff between sprints** | `getDiff(...)` exists but tags auto-named with no context | Tag messages carry agent intent; `git log sprint-1..sprint-2 --oneline` is human-readable |
| **Rollback a bad sprint** | Manual SQL + filesystem hack | `git checkout sprint-{N-1}` works because tags are real |
| **Multi-tenant deployment** | One workspace dir; concurrent companies clobber each other | Per-company isolation makes hosted Arceus mechanically possible |
| **Co-authorship audit** | Commit messages say `(developer)` from a TS string | `Co-authored-by: developer <developer@arceus>` shows up in GitHub UI |
| **Forensic debugging** | "Why did this file change?" requires correlating timestamps with task IDs across two systems | `git blame` returns the agent role; `git show {sha}` shows the message; `tasks.commit_sha` joins back to the task |
| **Off-site backup** | None | Every push to GitHub is a free off-site backup of the company's history |
| **PR-style human review** | None | `github_open_pr` lets a CTO queue a sprint for founder review before merging |

---

## 9. Trade-offs and risks

| Decision | Pro | Con | Mitigation |
|---|---|---|---|
| Per-company workspace dir | Multi-tenant possible, isolated git history | More disk usage; cold-start time grows with active companies | Cap N most-recently-active on disk; bundle-restore handles re-hydration |
| Agentic commit | Meaningful messages; agent owns "what is a unit of work" | Agent might forget to commit; task can be `completed` but commit missing | `task_complete` route requires `evidence.commitSha`; route returns 422 if missing → agent retries |
| Server-side `Co-authored-by` stamp | Audit trail of agent role per change | One author per commit; no pair-programming | Pair work happens via separate tasks. |
| `tag-sprint` requires preview reachable | Prevents tagging a broken build | Local dev without preview can't tag | Allow `--force` flag gated on `caps.canForceWorkspaceMutation`, audit-logged |
| Concurrent commits in same company | Safe via `BeatLockManager` per agent — but workspace shared per company | Two agents in same company commit at once → race | Add per-company `workspaceCommitGate: TryRunGate` (already in `runtime-shared`); concurrent callers get `null`, retry |
| GitHub repo names per company | Founder can audit each company separately | Two companies with same `repo:"todo-app"` collide if same owner | Route validates uniqueness within `deploy_config` across companies sharing a token; 409 with suggested suffix |
| PAT vs GitHub App | PAT ships in seconds | PAT is per-founder-shared; rate limits apply | App migration well-documented; can swap auth modes via the connect route without changing tools |
| No force-push tool | Prevents history rewrites | Founder may need to amend (e.g. accidentally committed secret) | Founder shells out locally with their token — admin route gives them the token. Audit-logged when issued. |
| Token leak via logs | n/a — explicitly filtered | Tools that pass tokens to git/octokit must NOT log args | Idempotency-key derivation filters on `secretFields: ["personalAccessToken", "installationId", "envVars", "token"]`; route audit detail strips same |

---

## 10. Open questions worth answering before implementing

1. **What if `workspace_commit` succeeds but bundle upload to Supabase fails?** Today the fire-and-forget catches it. With agentic commits, recommendation: tool returns `{ sha, bundleUploaded: boolean, bundleError?: string }`; runbook says "if `bundleUploaded` is false, log a chat warning and continue."

2. **Multiple agents committing in parallel within one company.** Today's `BeatLockManager` serializes per agent. Workspace is shared per company. Recommendation: add per-company `workspaceCommitGate: TryRunGate`. Concurrent callers get `null` and retry on next beat.

3. **Un-`task_complete`d commits.** Agent commits experimental work that doesn't correspond to a finished task. `relatedTaskId` is optional in `workspace_commit`. Commit lands; `tasks.commit_sha` doesn't get filled until `task_complete` happens. Git log retains the commit as `Refs: <none>` — not orphaned, just not joined to any task.

4. **Interaction with Spec 35 (agentic sprint review).** Tester reads workspace at HEAD (or `sprint-{N-1}..HEAD`) when verifying. On `verdict: pass`, CTO `sprint_completed` wake fires; CTO calls `workspace_tag_sprint`. Tag and verdict become independent agent decisions. Clean separation.

5. **Public-repo secret leak.** If founder configures `visibility: public`, a leaked `.env` would be public. Mitigation lands in Phase A.4: server-side scan in `workspace_commit` route against secret patterns (`sk-…`, `ghp_…`, `xoxb-…`); returns 422 with offending file path.

---

## 11. Per-PR safety checks

Each PR ships with:

- [ ] `npm run typecheck` green across all 9 workspaces
- [ ] Drift test green
- [ ] `silent-catch` lint clean
- [ ] If schema migration: applied locally + smoke-tested against `arceus_dev`
- [ ] If new MCP tool: idempotency-key derivation explicitly excludes secret fields
- [ ] If new route: audit-ledger detail does NOT include token-bearing fields
- [ ] If new route: capability check + role check both present
- [ ] CI build artifact (graph + flaws inventory) updated

---

## 12. References

- Spec 08 — Product Storage (the original `WorkspaceManager` design we're completing here)
- Spec 33 — CAS Concurrency Protection (`TryRunGate`, `OncePromise` from `@arceus/runtime-shared`)
- Spec 35 — CEO Chat 2.0 (the agentic-card pattern this spec mirrors for git operations)
- Spec 37 — Vercel deployment (next phase, depends on Phase B)
