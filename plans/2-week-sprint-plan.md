# Arceus — 2-Week Execution Plan

> **Period:** April 7 — April 20, 2026
> **Goal:** Go from "specs on paper" to "Arceus running on a URL with Supabase persistence"
> **Starting point:** 5,271 lines of working backend (in-memory), Next.js dashboard, 10 specs written, zero persistence

---

## Where We Are (Honest Assessment)

**What works today:**
- CEO chat with streaming responses via OpenCode + Azure
- Strategy generation + approval flow
- Agent execution — Developer builds code in /workspace
- Preview detection — iframe shows the generated app
- Activity feed via SSE
- Dashboard with CEO chat, sprint progress, team activity

**What doesn't exist yet:**
- No database. Server restart = total data loss.
- No Supabase. Everything lives in JS variables.
- No git in workspace. No versioning, no rollback.
- No cost tracking. Azure bills are invisible.
- No verification gate. Code ships without build/test check.
- Tester agent has a SOUL but no tasks.
- No workspace isolation per company.
- No export, no download, no snapshot.

**Code size:** ~5,300 lines backend, ~2,000 lines frontend, ~500 lines shared packages.

---

## The 2-Week Goal

By April 20, Arceus should:
1. **Persist across restarts** — Supabase Postgres for all state, Supabase Storage for workspace bundles
2. **Track costs** — every Azure LLM call logged with token counts, budget widget on dashboard
3. **Verify builds** — orchestrator runs `npm run build` + `npm run test` before board review
4. **Version products** — git repo per company, sprint tags, rollback capability
5. **Run on a URL** — Docker image deployable to Railway/Fly with zero persistent volumes

That's the "first hostable Arceus." Not multi-user, not production-grade, but something real that survives a restart and shows a budget.

---

## Week 1: Foundation (April 7-13)

The theme: **make things stick.** Every mutation that currently writes to a JS variable should also write to Supabase. Every workspace write should go through git.

### Day 1-2: `packages/db` + Supabase Setup

**What to build:**
- Create Supabase project (manual, 5 minutes)
- Create `arceus-workspaces` and `arceus-assets` storage buckets
- Build `packages/db` package:
  - `client.ts` — `getDb()`, `getSupabaseClient()`, `isSupabaseConfigured()`
  - All schema files (Spec 04 domains + Spec 08 storage tables)
  - `drizzle.config.ts`
  - Run `drizzle-kit push` to create tables in Supabase
- Update `config.ts` with Supabase env vars
- Create `.env.example` with all env vars documented

**Deliverable:** `packages/db` builds, tables exist in Supabase, `isSupabaseConfigured()` returns true.

**Risk:** Drizzle + Supabase Postgres connection quirks. Mitigate: test with `drizzle-kit push` before writing any app code.

### Day 2-3: Workspace Manager + Git Ops

**What to build:**
- `git-ops.ts` — gitInit, gitAdd, gitCommit, gitTag, gitBundle, gitCloneFromBundle
- `workspace-manager.ts` — provision, commitAndSync, tagSprint, getLocalPath, ensureLocal
- `supabase-storage.ts` — uploadBundle, downloadBundle, createSignedUrl
- Wire `provision()` into company bootstrap (replace `resetProductWorkspace`)
- Wire `commitAndSync()` into orchestrator after developer task completion
- Wire `tagSprint()` into board review approval

**Deliverable:** Create company → workspace has git repo. Developer completes task → git commit. Sprint approved → git tag + bundle uploaded to Supabase Storage.

**Test:** Kill server. Restart. Call `ensureLocal()`. Workspace restores from Supabase bundle.

### Day 3-4: Store Persistence (Dual-Write)

**What to build:**
- `store-persistence.ts` — reads/writes full CompanySnapshot as JSON to Supabase Postgres
- Dual-write pattern: every mutation in `store.ts` calls `maybePersist()` fire-and-forget
- On server startup: if Supabase configured, load snapshot from DB
- Artifact persistence: `addArtifact()` writes to Postgres AND in-memory array
- Sprint snapshot: `tagSprint()` serializes full state to `sprint_snapshots` table

**Deliverable:** Create company, run sprint, kill server, restart — company still exists. Artifacts still queryable.

**This is the big unlock.** Everything after this builds on persistent state.

### Day 5: Cost Tracking

**What to build:**
- `cost-config.ts` — Azure pricing table, `computeCostCents()`, `estimateTokens()`
- `cost-tracker.ts` — `trackCost()`, `checkBudget()`, `getCompanySpend()`
- Wire into `azure-openai.ts` — extract `response.usage`, call `trackCost()`
- Wire into `ceo.ts` — track strategy generation costs
- Wire into `chat.ts` — track CEO chat costs
- Wire into orchestrator — estimated tracking for OpenCode agent calls
- Add budget routes: `GET /api/budget`, `GET /api/budget/breakdown`, `PATCH /api/budget`

**Deliverable:** Run a sprint. `GET /api/budget` returns real spend data with token counts. Dashboard shows "$X.XX / $20.00 spent."

### Day 6-7: Verification Gate + Tester Task

**What to build:**
- `verification-gate.ts` — `runVerificationGate()` with build + test check
- Update orchestrator: create Tester task parallel with Developer tasks
- Update orchestrator: run verification gate after both complete
- Update orchestrator: failure → retry loop (Developer fixes code, max 2 retries)
- Update Quinn's SOUL prompt with test-writing instructions
- Add `test` and `verification` task kinds to contracts

**Deliverable:** Sprint creates Developer + Tester tasks in parallel. After both finish, orchestrator runs `npm run build` + `npm run test`. Failure loops back to Developer.

---

## Week 2: Polish + Deploy (April 14-20)

The theme: **make it presentable and hostable.**

### Day 8-9: Dashboard Updates

**What to build:**
- Budget widget on overview page (progress bar, per-sprint breakdown)
- Sprint snapshot list with rollback button
- Workspace export button (download tarball)
- Verification gate results visible (build passed/failed, test summary)
- Cost breakdown view (by agent, by model, by sprint)

**Deliverable:** Dashboard shows budget, sprint history with rollback, and build/test status. Board can download their code.

### Day 9-10: Rollback + Export

**What to build:**
- `POST /api/workspace/rollback/:sprint` — download sprint bundle, restore, reload snapshot
- `POST /api/workspace/export` — create tarball, upload to Supabase, return signed URL
- `GET /api/workspace/diff/:from/:to` — git diff between sprints
- Wire rollback into dashboard (button on sprint snapshot card)
- Wire export into dashboard (download button)

**Deliverable:** Board can roll back to any previous sprint. Board can download their code as a tarball.

### Day 10-11: Budget Enforcement

**What to build:**
- Pre-task budget check in orchestrator (before dispatching any agent)
- Hard stop when company budget exhausted
- Warning thresholds: 50% info, 75% CEO mentions, 90% dashboard alert
- Sprint soft limit: CEO proposes, board approves, warning on overage
- Resume flow: board adds funds → execution resumes
- Inject budget state into CEO system prompt

**Deliverable:** Set budget to $1. Run sprint. Hard stop triggers. Increase budget. Execution resumes. CEO naturally mentions budget status in chat.

### Day 12-13: Docker + Deployment

**What to build:**
- `Dockerfile` — multi-stage build (Node 22, build TS, copy dist, minimal runtime)
- `docker-compose.yml` — Arceus API + Redis (Supabase is external)
- `docker/entrypoint.sh` — run migrations on startup, health check
- `/api/health` endpoint — checks Supabase Postgres + Redis + OpenCode connectivity
- `.env.example` with complete documentation
- Update `README.md` with deployment instructions

**Deliverable:** `docker compose up` starts Arceus. Health check passes. Connected to Supabase.

### Day 14: End-to-End Testing + Bug Fixes

**What to do:**
- Full lifecycle test: create company → CEO chat → strategy → approve → Sprint 1 → approve → Sprint 2
- Verify: artifacts in Supabase Postgres
- Verify: git bundle in Supabase Storage
- Verify: cost_events have real data
- Verify: kill server, restart, state restored
- Verify: rollback to Sprint 1 works
- Verify: export tarball downloads
- Fix whatever breaks

**Deliverable:** Arceus runs end-to-end with persistence, verification, and cost tracking. Ready to deploy.

---

## What We're NOT Doing These 2 Weeks

| Deferred | Why |
|----------|-----|
| Hippocampus (Spec 05a) | Memory system is valuable but not blocking. Artifact handoff works for Sprint 1-3. |
| Auth (Spec 13) | Single-user for now. Add when we go multi-user. |
| Tier 2 Playwright verification | Tier 1 (build+test) is sufficient. Playwright adds 200MB and sandbox complexity. |
| Sprint soft limit UI | Budget hard limit works. Soft limit is a polish feature. |
| Multi-company | One company at a time. Schema supports it, enforce later. |
| Security sandboxing | Agents run code on the host. Acceptable for single-user. Docker sandbox later. |
| Observability | console.log for now. Structured logging later. |

---

## Daily Standup Checkpoints

| Day | Mon 7 | Tue 8 | Wed 9 | Thu 10 | Fri 11 | Sat 12 | Sun 13 |
|-----|-------|-------|-------|--------|--------|--------|--------|
| **Week 1** | DB pkg + Supabase setup | Workspace mgr + git ops | Store dual-write | Cost tracker | Verification gate | Buffer / bugs | Buffer / bugs |

| Day | Mon 14 | Tue 15 | Wed 16 | Thu 17 | Fri 18 | Sat 19 | Sun 20 |
|-----|--------|--------|--------|--------|--------|--------|--------|
| **Week 2** | Dashboard budget + snapshots | Rollback + export | Budget enforcement | Docker + deploy | E2E test + fix | Buffer | **Ship** |

---

## Success Criteria (April 20)

- [ ] Server restart preserves all company state (Supabase Postgres)
- [ ] Workspace restores from Supabase Storage bundle on cold start
- [ ] Every LLM call tracked in cost_events with token counts
- [ ] `GET /api/budget` returns real spend data
- [ ] Dashboard shows budget widget with progress bar
- [ ] Orchestrator runs build + test gate before board review
- [ ] Tester agent writes test files parallel with Developer
- [ ] Git repo per company with commits per task and tags per sprint
- [ ] Rollback to previous sprint works (restore workspace + snapshot)
- [ ] Export tarball downloadable via signed URL
- [ ] Hard budget stop triggers at 100% company budget
- [ ] `docker compose up` starts Arceus connected to Supabase
- [ ] Health check endpoint validates all dependencies
- [ ] Full Sprint 1 → Sprint 2 lifecycle works with persistence

---

## Dependency Graph

```
Day 1-2: packages/db + Supabase
    │
    ├───► Day 2-3: Workspace Manager (needs db for workspace registry)
    │         │
    │         └───► Day 9-10: Rollback + Export (needs workspace manager)
    │
    ├───► Day 3-4: Store Persistence (needs db for snapshot storage)
    │         │
    │         └───► Day 8-9: Dashboard Updates (needs persisted data to display)
    │
    ├───► Day 5: Cost Tracking (needs db for cost_events)
    │         │
    │         └───► Day 10-11: Budget Enforcement (needs cost data)
    │
    └───► Day 6-7: Verification Gate (needs orchestrator changes)

Day 12-13: Docker (needs everything above working)
Day 14: E2E Testing (needs everything)
```

No circular deps. Each day builds on the previous. The critical path is Day 1-2 (db package) — everything else depends on it.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Drizzle + Supabase connection issues | Medium | Blocks everything | Test connection on Day 1 before writing any schema code |
| Orchestrator changes break existing flow | High | 2-3 days to fix | Surgical insertions only. Test after each change. Keep in-memory fallback. |
| Git operations flaky on workspace | Low | Slows Day 2-3 | Use execFile with timeouts. Comprehensive error handling in git-ops.ts. |
| Supabase Storage upload latency | Low | Slows execution | All uploads are fire-and-forget. Execution never blocks on network. |
| OpenCode SDK doesn't expose token counts | Known | Estimated costs for agent calls | Already planned: estimateTokens() fallback. tracking_method field distinguishes exact vs estimated. |
| Docker build fails with OpenCode dependency | Medium | Blocks deploy | Test Docker build early (Day 10). OpenCode may need separate container. |
| Quinn writes bad tests that always fail | Medium | Verification gate never passes | Max 2 retries then CTO escalation. Can disable gate as escape hatch. |
