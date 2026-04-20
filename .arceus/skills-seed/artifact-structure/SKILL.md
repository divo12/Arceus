---
name: artifact-structure
description: Structure artifact_create content per kind so downstream roles can consume it without reparsing.
role: developer
trigger: about to call artifact_create
---

# Artifact Structure

`artifact_create({ kind, title, content })` must produce content that the next role can act on directly. Kind dictates shape:

- **`code`** — diff-style or full-file content with a one-line summary. Attach `filesModified` in metadata.
- **`plan`** — ordered list of steps with acceptance criteria per step. Readable top-to-bottom.
- **`design`** — visual direction (palette, typography, layout). Include reference URLs.
- **`qa_report`** — test run summary, failures, browser/viewport context.
- **`campaign`** — channel breakdown, copy variants, distribution schedule.

**Title format:** `<Kind>: <short noun phrase>` — e.g. `Code: LoginForm component + tests`, `QA: Signup flow acceptance run`.

**Length:** body ≤ 4000 chars. If you need more, split into multiple artifacts and link them.

**Never:** dump raw terminal output. Never inline secrets. Never include files > 50 KB — reference them by path instead.
