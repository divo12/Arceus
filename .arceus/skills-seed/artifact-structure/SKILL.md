---
name: artifact-structure
description: Structure artifact_create content per kind so downstream roles can consume it without reparsing.
role: developer
trigger: about to call artifact_create
---

# Artifact Structure

`artifact_create({ kind, title, content, taskId? })` must produce content that
the next role can act on directly. `kind` is one of exactly four values —
there is no structured `metadata` field, so everything non-textual must be
serialised into `content` itself (e.g. a leading summary block).

- **`plan`** — ordered list of steps with acceptance criteria per step. Readable top-to-bottom. Used for design direction, QA plans, and distribution/campaign briefs.
- **`code`** — diff-style or full-file content with a one-line summary at the top. List the files touched in that summary since there's no metadata field.
- **`output`** — run summaries: test results, preview probe notes, build logs. Used by tester / probe outputs.
- **`specification`** — formal specs, contracts, acceptance criteria documents. Used when the artifact is a reference, not a delivery.

If the role you're working in needs a more specific shape (e.g. "QA report",
"design direction"), encode it in the `title` + the opening paragraph of
`content` — the registry kind stays one of the four above.

**Title format:** `<Intent>: <short noun phrase>` — e.g. `Code: LoginForm component + tests`, `Output: Signup flow acceptance run`, `Plan: Onboarding design direction`.

**Length:** body ≤ 4000 chars. If you need more, split into multiple artifacts and link them by ID in the summary block.

**Never:** dump raw terminal output verbatim. Never inline secrets. Never include files > 50 KB — reference them by path in the workspace instead.
