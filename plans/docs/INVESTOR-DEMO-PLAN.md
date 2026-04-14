# Investor Demo Plan: Frontend-Only Flow + Apple Design Skills

## Goal
Reliable, visually impressive end-to-end demo:
CTO plan → PM spec → Developer builds frontend → Local Preview on 3210 → Board Handoff → Follow-ups on approval

---

## Harness Diagnosis (Current Failure Modes)

Before fixing the flow, these are the **observed** failure modes from test runs, analyzed through the agent harness construction lens:

### 1. Action Space Issues
| Problem | Root Cause | Impact |
|---------|-----------|--------|
| Developer builds Express backend → build fails | No constraint in action space; developer's skill says "Prefer Express or Fastify for backend" | Demo crashes at preview |
| Developer uses port 3000 → kills dashboard | Prompt example used 3000; developer followed it | Investor sees crash |
| Developer runs `npm install` for 30+ packages → timeout | No package count constraint; full-stack = more deps | Stall during demo |

### 2. Observation Quality Issues
| Problem | Root Cause | Impact |
|---------|-----------|--------|
| Preview fails with "not reachable in time" but no root cause | `preview.ts:414` only says URL not reachable — doesn't check if process crashed, wrong port, or missing script | Orchestrator can't recover |
| Router proposes transition for already-completed task | Router LLM sees stale task state, proposes `completed → completed` | `!anyExecuted` → loop breaks, pipeline stalls |
| Developer tool events show `status=running` but never `completed` | Event parser didn't handle OpenCode's `part.type === "tool"` format | Activity log shows phantom edits |

### 3. Recovery Quality Issues
| Problem | Root Cause | Impact |
|---------|-----------|--------|
| Preview fails → entire pipeline stops | `startPreviewPhase` throws, caught in `continueExecutionFromCurrentState`, sets task to `failed` but no retry | Dead end |
| Router gets 2 rejections → gives up | `!anyExecuted` breaks loop with no retry feedback | Follow-up tasks never start |
| `local_preview` depends on `follow_up` (created) → deadlock | Task plan creates circular follow_up chains | Pipeline stuck forever |

### 4. Context Budget Issues
| Problem | Root Cause | Impact |
|---------|-----------|--------|
| Developer system prompt = soul + skill menu + ALL skill bodies | Apple design skill alone is ~3000 tokens; local-web-app is ~500 | Context bloat, worse instruction following |
| CTO/PM get skill bodies they don't need | `runPromptText` injects skills for every role | Wasted context, potential confusion |

---

## Phase 1: Fix the Harness (Reliability)

### 1.1 Config flag
**File:** `apps/api/src/config/orchestrator.ts`
```typescript
demoMode: readOptionalEnv("ARCEUS_DEMO_MODE", "false") === "true",
```
Log warning at startup if active.

### 1.2 Rewrite developer skill (action space fix)
**File:** `packages/company-runtime/skills/developer/SKILL.md`

The current skill is the #1 failure source — it says "Prefer Express or Fastify for backend." Replace entirely:

```markdown
---
name: frontend-web-app
description: Build frontend-only web apps with Vite that preview on port 3210.
role: developer
---

# Frontend Web App

## When to use
Use this skill for any task producing a web application.

## Constraints (NON-NEGOTIABLE)
- **Framework:** Vite + React (or vanilla HTML/CSS/JS). NEVER Express, Fastify, or any backend.
- **Port:** Dev server MUST run on port 3210. NEVER 3000, 4000, 4096.
- **Data:** Hardcode in JS/JSON or use localStorage. No databases, no API calls to external services.
- **Styling:** Use inline CSS or a CDN-loaded stylesheet. Tailwind via CDN is preferred.
- **Dependencies:** Minimal. `npm create vite@latest . -- --template react` then add only what's needed.

## Setup sequence
1. `npm create vite@latest . -- --template react` in the workspace
2. Edit `vite.config.js`: add `server: { port: 3210, host: '127.0.0.1' }`
3. `npm install`
4. Build the UI
5. `npm run dev` → verify http://127.0.0.1:3210 loads
6. Print: `PREVIEW_URL: http://127.0.0.1:3210/`

## Definition of done
- `npm run dev` starts Vite on port 3210
- `curl http://127.0.0.1:3210/` returns 200 with HTML
- No backend process, no Express, no server.js
```

**Why this fixes the action space:** The developer's ONLY skill now says "Vite + React, never Express." There is no competing instruction.

### 1.3 CTO prompt constraint (belt)
**File:** `apps/api/src/orchestrator.ts` (~line 2139, `runPlanningPhase`)

When `orchestratorConfig.demoMode`, prepend to the CTO prompt array (before strategy lines):
```
CRITICAL SCOPE CONSTRAINT (NON-NEGOTIABLE):
Build FRONTEND ONLY. No backend server, no Express/Fastify, no API routes, no database.
Use Vite + React. The app runs via `npm run dev` on port 3210.
All data hardcoded or localStorage. Plan accordingly.
```

Also append to `snapshot.strategy.scopeBoundary[]` (local mutation, not persisted):
`"FRONTEND ONLY — no backend, no API, no database, no server-side code"`

### 1.4 Developer prompt guard (suspenders)
**File:** `apps/api/src/orchestrator.ts` (~line 2374)

When `orchestratorConfig.demoMode`, add to delivery rules:
```
CRITICAL: FRONTEND-ONLY build. No backend server, no Express, no API routes.
Use Vite dev server. Command: npm run dev (port 3210 via vite.config.js).
```

**Triple-layer constraint: scope_boundary → CTO prompt → developer prompt. Three independent injection points, all saying the same thing.**

### 1.5 Fix preview path resolution (observation fix)
**File:** `apps/api/src/preview.ts` (~line 497, `startLocalPreview`)

Current: `detectLaunchCommand(productDir, ...)` scans workspace root. If developer put app in `workspace/todo-app/`, it finds `package.json` at wrong depth or picks root.

Fix: When `detectLaunchCommand` returns a candidate, log the resolved `cwd` and `targetPath`. If preview fails, include the actual cwd in the error message so the developer (or operator) can see the mismatch:
```typescript
previewState.lastError = `Preview not reachable at ${url} after ${timeout}ms. ` +
  `Launch command: ${previewState.command}. ` +
  `Working directory: ${launch.cwd}. ` +  // ← NEW: include cwd
  `Check if package.json exists there and 'dev' script starts on port ${previewState.port}.`;
```

### 1.6 Fix router retry on rejection (recovery fix)
**File:** `apps/api/src/router.ts` (~line 329)

Already partially fixed in commit 0691861 (rejection feedback + `autoPromoteReadyTasks`). Verify the fix is active. The key behavior:
- When all proposals rejected → feed rejection reasons back as `currentEvent` → LLM retries with context
- When a task completes → `autoPromoteReadyTasks()` moves downstream `created` → `planned`

**No new code needed here — verify the existing fix works in the next test run.**

---

## Phase 2: Apple Design Skill (Visual Impact)

### 2.1 Apple Design System Skill ✅ DONE
**File:** `packages/company-runtime/skills/apple-design-system/SKILL.md`
- `role: developer` — auto-loaded by skill loader
- Contains: color palette, SF Pro typography, component stylings, layout principles, CSS variables

### 2.2 Context budget concern
The Apple skill is ~3000 tokens. Combined with the local-web-app skill (~500 tokens) and the developer soul prompt, the system prompt may exceed 5000 tokens. This is within budget for a single-turn developer prompt but watch for:
- **Stop condition:** If developer output quality degrades (ignoring instructions, hallucinating), the skill is too long. Trim the "Responsive Behavior" and "Depth & Elevation" sections first — they're lowest-impact.
- **Measurement:** After first test run, check if generated CSS actually uses the Apple hex values. If not, the skill is being ignored due to context overload.

### 2.3 CTO design hint (optional, low-effort)
**File:** `packages/company-runtime/skills/cto/design-planning/SKILL.md` (new)

Light skill (~200 tokens) with `role: cto`:
```
When planning web applications, include a "Visual Design Direction" section:
- Specify: dark/light theme, primary accent color, font family
- Reference the Apple design aesthetic: clean, minimal, high contrast
- Mention Tailwind CSS for implementation
```

This makes the CTO plan mention design direction → PM spec includes it → developer follows it. Small context cost, high downstream impact.

---

## Phase 3: Skill System Improvements (Post-Demo)

### 3.1 Restructure to role directories
```
skills/
  developer/
    SKILL.md          (the frontend-web-app skill, renamed)
  apple-design-system/
    SKILL.md          (stays here, role: developer in frontmatter)
  cto/
    design-planning/
      SKILL.md
  _shared/
    (future universal skills)
```

**Decision: Keep flat structure with `role` frontmatter for now.** The current loader works. Restructuring to nested `skills/<role>/<skill>/` adds complexity with no demo benefit. Do this after the demo when there are 10+ skills and organization matters.

### 3.2 Skill activation hints
Update `buildSkillMenu()` output:
```
# Loaded Skills
All skills below are active. Follow their constraints.
- **frontend-web-app**: Vite + React on port 3210, no backend
- **apple-design-system**: Apple-inspired visual design (colors, typography, components)
```

**Key insight from harness construction:** Don't ask the agent to "decide which skill to load." That adds a decision point that can fail. Instead, load ALL role-matched skills and tell the agent they're all active. The agent applies what's relevant. Simpler = more reliable for demo.

### 3.3 Extract skill loader (code quality, not demo-blocking)
Move `loadSkillsForRole`, `buildSkillMenu`, `getSkillBody` from orchestrator.ts to `packages/company-runtime/src/skill-loader.ts`. Pure refactor.

---

## Phase 4: End-to-End Verification

### 4.1 Test protocol
```
1. Set ARCEUS_DEMO_MODE=true
2. Kill all servers (4000, 3000, 4096)
3. Start API: npx tsx src/server.ts
4. Start Web: npx next dev --port 3000
5. Reset: DELETE /api/company
6. Execute: POST /api/quick-execute {"idea": "Build a landing page for a productivity app"}
7. Monitor:
   a. CTO plan → verify NO backend references
   b. PM spec → verify frontend-only acceptance criteria
   c. Developer → verify Vite scaffold, no Express
   d. Workspace → verify files at workspace/
   e. Preview → verify http://127.0.0.1:3210 returns 200
   f. Board handoff → verify it pauses for approval
   g. Visual → verify Apple design tokens in generated CSS
```

### 4.2 Pass/fail checklist
| Check | How to verify | Stop condition |
|-------|--------------|----------------|
| No backend in CTO plan | `grep -i "express\|fastify\|backend\|server.js" plan-artifact` returns 0 | If found → CTO prompt constraint not working |
| Vite in package.json | `cat workspace/*/package.json \| grep vite` | If missing → developer skill not loaded |
| Port 3210 | `cat workspace/*/vite.config.*` or `package.json` dev script | If 3000 → port constraint not applied |
| Preview passes | `curl http://127.0.0.1:3210/` returns 200 | If timeout → check preview.ts cwd resolution |
| Apple colors in CSS | `grep -r "0071e3\|f5f5f7\|1d1d1f" workspace/` | If missing → design skill too long, being ignored |
| Router continues after preview | Check task statuses: `board_handoff` reaches `in_progress` | If stuck → router retry fix not working |

### 4.3 Known edge cases
- **Developer creates subdirectory:** e.g., `workspace/my-app/` instead of `workspace/`. Preview scanner handles this (scans recursively), but prefer telling developer to scaffold at workspace root.
- **Vite uses different output format:** Vite prints `Local: http://localhost:3210/` not `listening on port`. Preview HTTP probe doesn't care about console output — it just hits the URL. Safe.
- **npm create vite prompts interactively:** In non-interactive shell, use `npm create vite@latest . -- --template react` (the `.` and `--template` skip prompts). Add this to skill.

---

## Implementation Order (Critical Path)

```
STEP 1: Update developer skill (SKILL.md)     ← 5 min, highest impact
STEP 2: Add demoMode config flag               ← 2 min
STEP 3: CTO prompt + scope_boundary injection  ← 10 min
STEP 4: Developer prompt guard                 ← 5 min
STEP 5: Preview error message improvement      ← 5 min
STEP 6: Test run                               ← 15 min (mostly waiting)
STEP 7: Evaluate visual output quality         ← manual check
STEP 8: Trim Apple skill if context overloaded ← conditional
```

Steps 1-5 can be implemented in one pass. Step 6 is the gate. Steps 7-8 are iteration.

---

## Anti-Patterns to Avoid (from harness construction skill)

| Anti-Pattern | How We Avoid It |
|-------------|----------------|
| Too many tools with overlapping semantics | Developer has ONE skill (frontend-web-app) not two competing ones (local-web-app + frontend) |
| Opaque tool output with no recovery hints | Preview error now includes cwd, command, and port — actionable |
| Error-only output without next steps | Router rejection feedback includes "Propose different valid transitions for tasks whose dependencies are already met" |
| Context overloading with irrelevant references | Skills loaded by role, not globally. Apple skill is developer-only. CTO gets a 200-token design hint, not the full 3000-token design system |

---

## Success Criteria
- [ ] `ARCEUS_DEMO_MODE=true` → CTO plan has zero backend references
- [ ] Developer builds Vite + React app (no Express in package.json)
- [ ] Generated CSS contains Apple design tokens (#0071e3, #f5f5f7, etc.)
- [ ] `npm run dev` starts on port 3210
- [ ] Preview probe passes → `local_preview` status = `completed`
- [ ] Router continues to `board_handoff`
- [ ] `ARCEUS_DEMO_MODE` unset → normal behavior unchanged
- [ ] Total execution time < 3 minutes (demo pacing)
