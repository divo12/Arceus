---
name: playwright-ui-smoke-test
description: End-to-end smoke testing of frontend UIs using playwright-mcp browser tools — navigate, interact, assert, capture evidence.
role: qa
trigger: verifying a frontend task, about to call task_verify on a UI feature, or running acceptance suite for a browser-rendered app
---

# Playwright UI Smoke Test

The tester's job on a frontend task is not to say "the component renders." It's to prove the feature works end-to-end from the user's perspective. This skill is the repeatable workflow for doing that using the `playwright` MCP server tools.

## When this fires

- Received a task_verify call for a frontend or UI feature
- About to call `workspace_run_acceptance_suite` on a browser-rendered app
- Validating a dev's "done" claim on a React/Next.js/Vite component
- Smoke-testing a preview URL before a sprint gate

Not this skill when: pure API endpoints with no UI, or server-side rendering with no client interaction.

## Playwright-mcp tools you have access to

The `playwright` MCP server is always available. Key tools:

| Tool | Purpose |
|---|---|
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Capture accessibility tree (primary way to read page state) |
| `browser_screenshot` | Capture a visual screenshot |
| `browser_click` | Click an element by selector or accessibility label |
| `browser_type` | Type into an input |
| `browser_select_option` | Select a dropdown option |
| `browser_network_requests` | List all network requests made so far |
| `browser_console_messages` | Read browser console (errors, warnings, logs) |
| `browser_tab_new` | Open a new tab |
| `browser_tab_close` | Close a tab |
| `browser_wait_for` | Wait for a condition or selector |

## The smoke-test loop

```
1. Get the preview URL
   workspace_get_preview_url({ taskId })

2. Navigate to the feature
   browser_navigate({ url: previewUrl + "/path/to/feature" })

3. Capture baseline state
   browser_snapshot()          ← read the accessibility tree
   browser_screenshot()        ← visual capture

4. Walk the acceptance criteria — for each criterion:
   a. Interact (browser_click, browser_type, browser_select_option)
   b. Assert via browser_snapshot() — does the tree reflect expected state?
   c. Check browser_console_messages() — any errors?
   d. Take browser_screenshot() as evidence

5. Check network health
   browser_network_requests()
   ← look for 4xx/5xx responses, unexpected calls, missing API calls

6. Run edge cases (pair with qa-edge-case-discovery)
   Empty inputs, error states, boundary values

7. Package evidence
   workspace_collect_evidence({ probeArtifactIds, testOutputArtifactIds })

8. Verdict
   - Pass → task_verify({ taskId, verdict: "pass", evidence: "..." })
   - Fail → task_report_bug({ taskId, content: "..." }) then task_verify({ verdict: "fail" })
```

## Asserting with browser_snapshot

The snapshot returns the accessibility tree — use it as your source of truth, not the screenshot:

- Look for `role: "button"`, `role: "heading"`, `role: "alert"` nodes
- Check `name` attributes to verify labels match AC
- Check `checked`, `expanded`, `disabled` states
- Use it to locate elements before clicking — prefer accessibility name over CSS selectors

## Evidence checklist

Every passed verification must include:
- [ ] At least one screenshot per acceptance criterion
- [ ] Console log showing zero errors (or documented known warnings)
- [ ] Network log showing expected API calls succeeded (2xx)
- [ ] Snapshot showing expected UI state after each key interaction

## Heuristics

- **Snapshot before screenshot.** The accessibility tree tells you what's there; the screenshot tells you what it looks like. Read the tree first.
- **Console errors are bugs.** A feature that logs errors is not done, even if it renders.
- **Click by label, not by CSS.** `aria-label="Submit"` is more stable than `button.primary`. Use the snapshot to find names.
- **Test what the user does, not what the code does.** Fill the form, submit it, wait for success — don't just render the page.
- **Network 404 on a static asset is a bug.** Check network requests for broken imports, missing fonts, missing images.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "It renders" accepted as done | Only checked visual, not interaction | Always walk through user actions, not just load |
| Flaky test results | Race between navigation and assertion | Use `browser_wait_for` before asserting dynamic content |
| Console errors ignored | Logs not checked | Always run `browser_console_messages` after each step |
| Wrong element clicked | CSS selector drifted | Prefer accessibility name; use `browser_snapshot` to confirm target |
| Missing evidence | Evidence gathered at the end not per-criterion | Screenshot after every major AC, not just at the end |

## Anti-patterns

- **"Works in my manual test."** Manual is not repeatable. Use playwright tools and capture evidence.
- **Only screenshotting the landing state.** Capture state after each interaction.
- **Ignoring 404s in network log.** Missing assets are bugs.
- **Treating browser_snapshot as "just a tree."** It's the ground truth for what's accessible and operable.
- **Skipping console check.** JS errors that don't crash the page still ship to prod.
