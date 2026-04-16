# E2E Debug Session Report — April 15, 2026

## Session Summary

Full end-to-end debugging session targeting the heartbeat-driven autonomous execution pipeline. Starting from a state where `quick-execute` appeared to work but no actual code was ever produced, this session uncovered and fixed **three root-cause bugs** that collectively prevented specialist agents from executing tasks and the developer agent from writing code to the product workspace.

---

## Bug 1: SSE Event Bridge Never Started for Heartbeat Beats

**Symptom:** After `quick-execute`, the heartbeat engine started firing beats, but every beat that attempted an LLM call would hang for 5 minutes and then time out.

**Root Cause:** The `runPromptText()` function sends a prompt to OpenCode via HTTP, then waits for completion by listening for a `session.idle` SSE event from the OpenCode event stream. This event stream is managed by `startEventBridge()`. However, the `quick-execute` flow calls `heartbeatEngine.start()` directly — it never calls `beginExecution()` or `beginSprintExecution()` which are the only code paths that called `startEventBridge()`. Without the bridge, the completion promise never resolves.

**Fix:** Added event bridge initialization checks to both `executeBeatTask()` and `executeChecklistAction()` in [orchestrator.ts](../apps/api/src/orchestrator.ts):

```typescript
if (!eventBridgeStarted) {
  startEventBridge().catch(() => {});
  eventBridgeStarted = true;
}
```

These are the entry points for all heartbeat-driven work, ensuring the bridge is always active before any LLM call.

**File:** `apps/api/src/orchestrator.ts` (~lines 5660, 5990)

---

## Bug 2: OpenCode Agent Definitions Not Loaded (Config Path Mismatch)

**Symptom:** Specialist tasks (tester, ui_designer, marketing, skills_lead) failed instantly (~100ms) with `"OpenCode session error"`. The actual error payload was: `Agent not found: "tester". Available agents: build, explore, general, plan`.

**Root Cause:** Two compounding issues:

1. **Config not reaching OpenCode's cwd.** The `opencode.json` at the repo root defines custom agents (ceo, cto, pm, developer, tester, ui_designer, marketing, skills_lead). OpenCode spawns with `cwd: workspace/` — a separate directory where agents write product code. The code attempted to pass config via `OPENCODE_CONFIG_CONTENT` env var, but **OpenCode does not support this env var**. It only reads `opencode.json` from its working directory.

2. **Config loader pointed at wrong directory.** `loadOpencodeConfig()` used `projectRoot` (`process.cwd()` = `apps/api`) to find `opencode.json`, but the file lives at the repo root (`Q:\projects\arc2.0/opencode.json`).

OpenCode only had its 7 built-in agents (`build, compaction, explore, general, plan, summary, title`). When `runPromptText()` sent `agent: "tester"`, OpenCode rejected it immediately.

**Fix:** Two changes in [opencode.ts](../apps/api/src/opencode.ts):

1. Fixed `loadOpencodeConfig()` to read from `repoRoot` instead of `projectRoot`:
   ```typescript
   const configPath = resolve(repoRoot, "opencode.json");
   ```

2. Added `syncOpencodeConfigToWorkspace()` — copies the merged `opencode.json` and `.opencode/prompts/` directory into the product workspace before spawning OpenCode, so the server discovers custom agent definitions at its cwd:
   ```typescript
   function syncOpencodeConfigToWorkspace(mergedConfig: Record<string, unknown>) {
     writeFileSync(resolve(productWorkspace, "opencode.json"), JSON.stringify(mergedConfig, null, 2), "utf8");
     // Also copy .opencode/prompts/ so {file:...} references resolve
     const srcPrompts = resolve(projectRoot, "..", "..", ".opencode", "prompts");
     const dstPrompts = resolve(productWorkspace, ".opencode", "prompts");
     if (existsSync(srcPrompts)) {
       mkdirSync(dstPrompts, { recursive: true });
       for (const file of readdirSync(srcPrompts)) {
         copyFileSync(resolve(srcPrompts, file), resolve(dstPrompts, file));
       }
     }
   }
   ```

3. Called `syncOpencodeConfigToWorkspace()` in `getOpencode()` before detection/spawn, ensuring config is always present regardless of whether we connect to an existing server or launch a new one.

**Files:** `apps/api/src/opencode.ts` (lines 1-4 imports, line 30 loadOpencodeConfig, new syncOpencodeConfigToWorkspace function, spawnOpencodeServer, getOpencode)

---

## Bug 3: Debunked — "OpenCode Returns HTML" Was a Red Herring

**Symptom (prior session):** Testing showed OpenCode returning HTML instead of JSON, leading to the belief the SDK was broken.

**Investigation:** The prior test hit the wrong endpoint. The SDK's `session.prompt()` method actually POSTs to `/session/{id}/message` (not `/session/{id}/prompt`). Direct testing of the correct endpoint confirmed it returns proper JSON with valid LLM responses (cost=0.0018852, tokens.total=18429).

**Resolution:** No code fix needed — the endpoint was always working. The real issues were Bugs 1 and 2 above.

---

## Diagnosis Flow

```
quick-execute → heartbeat starts → beats fire
                                        │
                         ┌──────────────┼──────────────────┐
                         │              │                  │
                    developer       specialist          cto/pm
                         │           (tester,            (idle)
                         │          ui_designer)
                         │              │
                    runPromptText   runPromptText
                         │              │
                    ┌────┴────┐    ┌────┴────┐
                    │ Bug #1  │    │ Bug #1  │  SSE bridge not started
                    │ (hang)  │    │ + Bug#2 │  + agent not found
                    └─────────┘    └─────────┘
```

- **Bug #1** caused ALL LLM calls to hang (5-min timeout) because the SSE completion listener was never connected
- **Bug #2** caused specialist tasks to fail instantly because OpenCode rejected unknown agent names
- Together, they meant: developer tasks timed out silently, specialist tasks errored immediately, and no code was ever written to the product workspace

---

## Verification

After both fixes, a clean E2E test was run:

1. `DELETE /api/company` — reset state
2. `POST /api/quick-execute` with idea: "A minimal single-page todo list app"
3. Heartbeat engine started, CEO proposed sprint, tasks created and assigned
4. **All specialist agents resolved successfully** — tester completed testing, ui_designer completed UI design
5. **Developer agent produced real code** in `workspace/`:
   - `index.html`, `package.json`, `tsconfig.json`
   - `src/App.tsx`, `src/main.ts`, `src/style.css`, `src/counter.ts`
   - `public/favicon.svg`, `public/icons.svg`
   - `node_modules/` (npm install was run by the agent)
6. OpenCode agent list confirmed all 15 agents loaded (7 built-in + 8 custom)

### Final Task State
| Status | Task |
|--------|------|
| ✅ completed | UI Design |
| 🔄 in_progress | Core Frontend Development |
| ✅ completed | Testing |
| ⏳ planned | PM Coordination |
| 🔄 in_progress | CTO Sprint Review |

---

## Files Modified

| File | Changes |
|------|---------|
| `apps/api/src/orchestrator.ts` | Added event bridge startup in `executeBeatTask()` and `executeChecklistAction()` |
| `apps/api/src/opencode.ts` | Fixed config path, added `syncOpencodeConfigToWorkspace()`, updated imports, removed `OPENCODE_CONFIG_CONTENT` env var |

## Remaining Observations

- Developer task (`Core Frontend Development`) was still in_progress at report time — this is expected as LLM code generation takes multiple minutes
- The `OPENCODE_CONFIG_CONTENT` env var was a non-functional assumption in the original code — OpenCode CLI does not read this variable
- The prompt file references (`{file:./.opencode/prompts/ceo-soul.txt}`) require the `.opencode/prompts/` directory to exist relative to OpenCode's cwd, not the API server's cwd
