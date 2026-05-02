---
name: playwright-frontend-debug
description: Diagnose frontend bugs using playwright-mcp — reproduce the failure in a live browser, isolate the root cause, fix, and verify.
role: developer
trigger: debugging a UI bug or rendering issue, investigating a tester-reported frontend failure, or verifying a fix before marking task_complete
---

# Playwright Frontend Debug

When a frontend bug is reported, the slowest path is re-reading the code. The fastest path is reproducing it in a real browser, reading the console, and watching what the network actually does. This skill is the workflow for using playwright-mcp browser tools to reproduce, isolate, and verify frontend bugs.

## When this fires

- Tester filed a bug via `task_report_bug` for a UI component or interaction
- A preview URL exists and something visual or behavioral is wrong
- You fixed a bug and want to verify before `task_complete`
- A build passes typecheck but the UI behaves unexpectedly at runtime

Not this skill when: the bug is purely server-side (API, DB), no preview URL is available yet, or the issue is a TypeScript type error caught at compile time.

## Playwright-mcp tools for debugging

| Tool | What you use it for |
|---|---|
| `browser_navigate` | Open the page where the bug occurs |
| `browser_console_messages` | Read JS errors, warnings, and debug logs |
| `browser_network_requests` | See failed API calls, 404 assets, slow requests |
| `browser_snapshot` | Read the DOM tree — what's actually rendered vs. expected |
| `browser_screenshot` | Capture the visible bug state for the bug report |
| `browser_click` | Reproduce interaction steps |
| `browser_type` | Reproduce input-driven bugs |
| `browser_wait_for` | Wait for async state to settle before inspecting |
| `browser_select_option` | Trigger select-driven bugs |

## The debug loop

```
1. Reproduce the bug
   browser_navigate({ url: previewUrl + "/bug/path" })
   → Follow the exact repro steps from the bug report

2. Read the console immediately
   browser_console_messages()
   → Errors here are your first lead. Uncaught errors, failed imports, and
     React hydration errors show up here.

3. Read the network
   browser_network_requests()
   → Look for: 4xx API calls (data not loading), 404 assets (missing images/fonts),
     slow requests (loading states stuck), duplicate requests (state management bug)

4. Read the DOM
   browser_snapshot()
   → Compare what's rendered to what should be rendered.
     Is the element missing? Wrong role? Hidden (aria-hidden="true")?

5. Narrow the root cause
   - Console error → trace to the component throwing it
   - Network 4xx → trace to the API call site; check payload
   - DOM wrong → inspect the React state path leading to the render

6. Fix the code

7. Verify the fix
   browser_navigate({ url: previewUrl })   ← force a fresh load
   browser_console_messages()              ← errors gone?
   browser_network_requests()              ← API calls succeeding?
   browser_screenshot()                    ← visual looks correct?
   browser_snapshot()                      ← DOM matches expected?

8. Capture evidence and complete
   workspace_collect_evidence({ ... })
   task_complete({ ... })
```

## Reading console messages

Classify each message before acting:

| Message type | What it means |
|---|---|
| `Uncaught TypeError` | Runtime error — a variable is undefined or wrong type; check the component |
| `Failed to load resource` | Network error — check `browser_network_requests` for the URL |
| React: `Warning: Each child in a list should have a unique "key"` | Missing key prop; not a crash but indicates a list render bug |
| React: `Hydration failed` | Server-rendered HTML doesn't match client render; check conditional rendering |
| `[webpack/vite error]` | Build-time module resolution failed; check imports |
| `401` / `403` in console | Auth token missing or expired for an API call |

## Reading network requests

Focus on:
- Status `>= 400` on API calls → the data never arrived
- Status `404` on `.js`, `.css`, `.png` → broken import or missing public asset
- Status `200` but the component still shows empty → the response shape is wrong (check the response body)
- A request made twice → double-effect in `useEffect`, missing dependency array

## Heuristics

- **Reproduce before fixing.** If you can't reproduce with playwright tools, you can't verify the fix either.
- **Console errors first.** They point directly to the throw site. Read them before touching code.
- **Network 404 on an API call means the fix is not in the component.** The component rendered correctly — the data fetch failed. Look at the API route, auth headers, or env vars.
- **Browser state persists between tool calls.** You don't need to reload the page between `browser_click` and `browser_snapshot`. Use this to inspect state mid-interaction.
- **Prefer fresh navigation after a fix.** `browser_navigate` with the same URL will fully reload, clearing stale state.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Can't reproduce the bug | Navigated to wrong URL or skipped interaction steps | Follow bug report steps exactly; use `browser_wait_for` for async |
| Fix seems to work but tester re-opens | Verified only the happy path | Run the exact repro steps from the bug report after fixing |
| Console clean but bug persists | Bug is in silent data transformation, not a thrown error | Read `browser_snapshot` for DOM mismatch; add temporary logging |
| Network shows 200 but UI empty | API response shape changed | Log the raw response; compare against what the component expects |

## Anti-patterns

- **Fixing by reading only the code.** The runtime environment (env vars, API responses, browser quirks) is different from what TypeScript can see. Always reproduce in the browser.
- **Verifying only the landing state after a fix.** Reproduce the entire interaction flow that caused the bug.
- **Ignoring console warnings.** `key` prop warnings and hydration warnings become bugs under load or after navigation.
- **Not capturing evidence of the fix.** A screenshot before/after is the difference between "I fixed it" and "it's fixed."
