# Shell Command Logging Conventions

After running any non-trivial shell command, call `task_append_command` with:

```json
{
  "command": "bun test -- --coverage  # 38 pass / 0 fail, 92% coverage (12.4s)"
}
```

The tool currently accepts only `command` (string, ≤2000 chars). An
optional `exitCode` is accepted by the HTTP schema but **not persisted** —
the server stores just the command string (capped at 50 entries per task).
There is no `summary` or `durationMs` field, so if you want a pass/fail
note, a duration, or an exit-code annotation to survive into later beats,
embed it inline in the `command` string (as the trailing `#` comment above).

## When to log

- **Always** — test runs, builds, migrations, deploys, any destructive op.
- **Always** — long-running commands (>5s).
- **Skip** — `ls`, `cat`, `pwd`, `which` — read-only, no state change.

## What to embed after a `#` comment

- Tests: pass count / fail count / first failure if any
- Builds: success or first error line
- Package installs: packages added/removed, lockfile changed yes/no

Keep the whole `command` line ≤200 chars. Put full output into an artifact
via `artifact_create` (kind `output`) if you need to preserve it.
