---
name: design-to-dev-handoff
description: Package design output as an artifact the developer can implement directly without rereading the design brief.
role: ui_designer
trigger: design task is about to complete
---

# Design → Developer Handoff

The developer reads your artifact. Make it buildable as-is.

1. **Artifact kind:** `design`
2. **Title:** `Design: <feature> — direction + component specs`
3. **Body must include:**
   - **Tokens** — colors, spacing, typography (inline or reference the design system path)
   - **Components** — per-component: name, props, states (default/hover/focus/disabled/loading/error), accessibility notes
   - **Layout** — grid, breakpoints, responsive behavior
   - **Preview URL** — if a prototype exists, call `task_set_preview_url` before completing
4. **Copy** — all user-facing strings, labeled per component
5. **Acceptance criteria** — what "done" looks like from a QA standpoint

Call `artifact_write_to_workspace` if you produced source files (SVGs, design tokens as JSON/CSS). Store them under `src/design/`.

**Never:** hand off "here's a Figma link, figure it out." The developer beat has a fresh session and zero context — make the artifact self-sufficient.
