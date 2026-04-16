# Debug Report: Sprint Review Loop & Agent Output Quality

**Date:** 2026-04-16  
**Branch:** `dev/testing-plus-meetings`  
**Files modified:** `apps/api/src/orchestrator.ts`, `apps/api/src/preview.ts`, `apps/api/src/verification-gate.ts`, `packages/contracts/src/domain.ts`, `apps/api/src/workspace-scaffold.ts`

---

## 1. Preview Feedback Loop (5 root causes fixed)

### 1.1 Verification Gate — Preview Health Probe
**Problem:** Verification gate (`verification-gate.ts`) never checked if the product preview was actually reachable. A broken/blank preview could pass all gates.  
**Fix:** Added `probePreviewHealth()` call in both `pre_review` and `final` verification phases. Unreachable preview = gate failure with `previewResult` field added to gate result schema.  
**Files:** `apps/api/src/verification-gate.ts`, `packages/contracts/src/domain.ts`

### 1.2 Tester Sprint Verification — Preview Probe Injection
**Problem:** Tester QA prompt had no awareness of whether the preview was running. Could "approve" an app that doesn't render.  
**Fix:** Preview probe results injected into tester prompt context. Hard override added: even if the LLM says APPROVED, verdict is forced to FAIL when preview is unreachable.  
**File:** `apps/api/src/orchestrator.ts` (~line 4640–4700)

### 1.3 CTO Board Handoff — Preview Health Check
**Problem:** CTO board_handoff review had no preview gate. Could approve a sprint where the product never loaded.  
**Fix:** Automated preview health check injected into CTO review prompt with CRITICAL warning when unreachable. Four separate gates added (pre-review, post-review, escalation meeting on failure).  
**File:** `apps/api/src/orchestrator.ts` (~line 2885)

### 1.4 Sprint REVIEWING Transition — Pre-Review Gate
**Problem:** Sprint could transition to REVIEWING state without checking if the product was actually viewable.  
**Fix:** Handled via verification gate — the pre-review gate now includes the preview probe. Blocks CTO review from starting if preview unreachable.  
**File:** `apps/api/src/orchestrator.ts` (~line 4640)

### 1.5 Unparseable QA Output — Default to FAIL
**Problem:** When the LLM's QA verdict couldn't be parsed (malformed JSON, missing fields), the system defaulted to `approved: true` — silently passing broken builds.  
**Fix:** Default changed to `approved: false` with rework items listing "verdict extraction failed".  
**File:** `apps/api/src/orchestrator.ts` (~line 4692)

---

## 2. Agent Output Quality (4 systemic problems fixed)

### 2.1 Generic Specialist Prompts → Role-Specific Templates
**Problem:** All specialist agents (PM, UI Designer, Marketing, etc.) shared a single generic 5-section prose template ("Background → Key Points → Details → Recommendations → Next Steps"). Output was fluffy prose with no actionable specs.  
**Fix:** `buildSpecialistTaskPrompt()` replaced with role-specific output templates:
- **PM** → Structured spec: user stories, functional requirements, UI requirements, non-goals, definition of done
- **UI Designer** → Actionable design spec: layout structure, component hierarchy with props, design tokens, component states, interaction patterns, responsive breakpoints
- **Marketing/others** → Improved but still text-based templates  
**File:** `apps/api/src/orchestrator.ts` (~line 2280)

### 2.2 UI Designer → Developer Handoff Broken
**Problem:** The handoff mechanism wrote a memory note containing an API URL reference (`/api/artifacts/...`) instead of the actual artifact content. The developer agent never fetched the URL — it just saw a dead link in its memory.  
**Fix:** `deliverUiDesignerMemoryHandoff()` now fetches the actual artifact content and embeds it directly into the developer's memory (up to 4000 chars), so the design spec is visible in-context.  
**File:** `apps/api/src/orchestrator.ts` (~line 2562)

### 2.3 Developer File-Change Gate Too Lenient
**Problem:** The developer task completion gate counted ANY file change as meaningful work. Changing only `package-lock.json` or `tsconfig.json` (without touching source files) would pass the gate.  
**Fix:** Added `meaningfulExtensions` filter — only changes to source files (.ts, .tsx, .js, .jsx, .vue, .svelte, .py, .css, .scss, .html) count as meaningful. Config/lock-file-only changes are rejected.  
**File:** `apps/api/src/orchestrator.ts` (~line 6100)

### 2.4 Preview Health Probe — Accept Header Fix
**Problem:** `probePreviewHealth()` fetch call used default Accept header. Some Vite dev servers return different content types based on Accept, causing false negatives.  
**Fix:** Added explicit `Accept: text/html,*/*` header to preview probe.  
**File:** `apps/api/src/preview.ts`

---

## 3. Programmatic Workspace Scaffold

### Problem
The developer agent was expected to run `npm create vite@latest`, then configure Tailwind CSS, PostCSS, TypeScript, and design tokens — a multi-step process it consistently botched. Result: Tailwind directives in CSS but no `tailwind.config.js` or `postcss.config.js`, so all utility classes were ignored. The preview rendered unstyled raw HTML.

### Fix
New `scaffoldProductWorkspace()` function writes a complete working project deterministically (no LLM involved):

| File | Purpose |
|------|---------|
| `package.json` | React 18, Tailwind 3, clsx, tailwind-merge, lucide-react, tailwindcss-animate |
| `tailwind.config.js` | Content paths, design token aliases, animate plugin |
| `postcss.config.js` | Tailwind + autoprefixer |
| `tsconfig.json` | Strict TypeScript with react-jsx |
| `vite.config.ts` | Port 3210, host 127.0.0.1 |
| `src/index.css` | @tailwind directives + Apple Notes design tokens (CSS custom properties) |
| `src/main.tsx` | React root mount |
| `src/App.tsx` | Minimal styled starter |
| `src/lib/utils.ts` | `cn()` utility (clsx + tailwind-merge) |
| `src/components/` | Empty directory for agent-created components |
| `design/style-guide.md` | Color usage, component patterns, typography scale |

The developer system prompt now references the pre-configured stack, includes the full style guide inline, and instructs agents to create separate component files in `src/components/` rather than dumping everything in `App.tsx`.

**Files:** `apps/api/src/workspace-scaffold.ts` (new), `apps/api/src/orchestrator.ts`

---

## 4. Other Fixes

| Fix | Description | File |
|-----|-------------|------|
| Task dependency gates | Tasks with unmet dependencies are blocked from execution | `orchestrator.ts` |
| PM polling fallback | PM timeout no longer stalls the pipeline | `orchestrator.ts` |
| Dark theme | Full dark mode for Arceus dashboard | `apps/web/` |
| Sidebar hover | Hover states on nav items | `apps/web/` |
| Heartbeat dots | Full-width layout + outcome-based coloring (green/red/yellow) | `apps/web/` |
| Softer board bubbles | Rounded, less harsh CEO/Board chat bubbles | `apps/web/` |

---

## Validation

- TypeScript: `npx tsc --noEmit` — clean (0 errors)
- Tests: 9/9 passing (4 pre-existing vitest suite-detection failures unrelated to changes)
- All changes committed and pushed to `origin/dev/testing-plus-meetings`
