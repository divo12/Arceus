---
name: developer-tool-reference
description: Complete reference table for every tool the developer agent can call — built-in primitives, arceus task lifecycle, artifact tools, workspace tools, context/memory tools. Load when you need to know what's available, what each does, or which to pick.
role: developer
trigger: choosing between tools, or when a tool call returns "tool not found" and you need to confirm availability
---

# Developer Tool Reference

Every tool below is in your allowlist. For a tool's argument schema, call `tool_help({name:"<tool>"})`.

## Built-in primitives (no governance, no idempotency)

Use these for the implementation work itself. They hit `/workspace` directly.

| Tool      | Purpose                                              |
|-----------|------------------------------------------------------|
| `read`    | Read a file. Args: `path` (or `filePath`) + optional `offset`/`limit`. |
| `grep`    | Pattern search across files. Args: `pattern`, optional `path`. |
| `glob`    | List files matching a pattern. Args: `pattern`, optional `path`. |
| `edit`    | `str_replace` on an existing file. Args: `filePath`, `oldStr`, `newStr`. |
| `write`   | Create or overwrite a file. Args: `path` (or `filePath`), `content`. |
| `bash`    | Run a shell command in `/workspace`. The plugin wraps it in a tenant-scoped `cd` automatically. |
| `webfetch`| Fetch external library docs. URL must be absolute http(s). |
| `skill`   | Load a `SKILL.md` into context. Does NOT execute. Args: `name`. |
| `tool_help`| Get the schema of any allowed tool. Args: `name`. |

**Plugin path-rewrite:** any path starting with `/workspace/...` is automatically scoped to your tenant's workspace root. So `read({path:"/workspace/src/App.tsx"})` reads YOUR tenant's `src/App.tsx`. Relative paths are also resolved against your tenant root.

## Arceus tools — required-every-beat

At least ONE of these must fire per beat or the stall watchdog kills your session:

| Tool                       | When                                       |
|----------------------------|--------------------------------------------|
| `task_append_plan_step`    | One-line narration of the next move (≤80 char). |
| `task_append_command`      | Logged shell command + exit code.          |
| `task_append_result`       | Free-form note attached to the task ledger. |
| `task_update_progress`     | Bump percent (0–100) with one note.        |
| `beat_read_last_progress`  | First call of every beat.                  |

## Arceus tools — task lifecycle

| Tool                   | Purpose                                       |
|------------------------|-----------------------------------------------|
| `task_claim`           | Take an unclaimed task off the backlog.       |
| `task_get`             | Read one task by id. Include `includeProgress:true` to get planSteps/results. |
| `task_get_preview_path`| Read the preview slot for this task.          |
| `task_list_progress`   | List in-progress tasks across the sprint.     |
| `task_complete`        | Mark done. REQUIRES `evidenceArtifactIds`.    |
| `task_block`           | Flag blocked. Args: `cause`, `detail`, `suggestedUnblock`. |
| `task_report_bug`      | File a new bug-fix task without context shift. |
| `task_verify`          | Mark a task as verified (post-QA).            |
| `task_attach_artifact` | Attach an artifact to an existing task.       |
| `task_set_preview_url` | Publish the live preview URL. Args: ONLY `taskId` — server reads live state. |

## Arceus tools — artifacts

Artifacts are immutable. To revise, create v2 with version in the title. Always pass `attachToTaskIds` so downstream roles inherit them.

| Tool                         | Purpose                                   |
|------------------------------|-------------------------------------------|
| `artifact_create`            | Persist plan/code/output/specification.   |
| `artifact_get`               | Read one artifact by id.                  |
| `artifact_list_sprint`       | List every artifact in the active sprint. |
| `artifact_write_to_workspace`| Materialize an artifact's content to disk. |

## Arceus tools — workspace

Prefer these over `bash` when one exists. They are cached, structured, and audited.

| Tool                          | Purpose                                  |
|-------------------------------|------------------------------------------|
| `workspace_verify_baseline`   | First check after `task_claim` — does prior work still build? |
| `workspace_run_typecheck`     | Cached `tsc --noEmit`, parsed errors.    |
| `workspace_get_build_health`  | Last build pass/fail, no rebuild.        |
| `workspace_check_exports`     | Verifies a module exports expected API.  |
| `workspace_start_preview`     | Launch the managed preview dev server (the ONLY supported way). |
| `workspace_probe_preview`     | Hit live preview URL, report health.     |
| `workspace_get_preview_url`   | Read the registered preview URL.         |
| `workspace_checkpoint`        | Intermediate git commit (not task close). |

## Arceus tools — context + memory

| Tool                       | Purpose                                |
|----------------------------|----------------------------------------|
| `company_get_summary`      | Goal, strategy, active sprint snapshot. |
| `sprint_get_active`        | Active sprint id, number, status.      |
| `meeting_contribute`       | Attach a position to an open meeting.  |
| `memory_add_learning`      | Record a cross-beat pattern (≤2/beat). |
| `memory_set_focus`         | Update next-beat focus hint.           |
| `memory_format_for_prompt` | Render the slice that gets injected.   |

## Which tool to pick

| Want to... | Use |
|---|---|
| Run TypeScript check | `workspace_run_typecheck` (NOT `bash("tsc")` — bypasses cache + parsed errors) |
| Start the dev server for preview | `workspace_start_preview` (NEVER `vite dev` or `npm run dev`) |
| Commit progress mid-task | `workspace_checkpoint` (NOT `bash("git commit")` — bypasses audit) |
| Read incoming PM/CTO/Designer spec | `artifact_get` for each `incomingArtifactId` |
| Find files matching a glob | `glob` (the plugin rewrites `/workspace/...` to your tenant) |
| Run tests | `bash("bun test ...")` and log via `task_append_command` |
| File a new bug | `task_report_bug` (doesn't shift your current task context) |
