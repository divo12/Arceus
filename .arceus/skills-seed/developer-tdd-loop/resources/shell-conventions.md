# Shell Command Logging Conventions

After running any non-trivial shell command, call `task_append_command` with:

```json
{
  "command": "npm test -- --coverage",
  "exitCode": 0,
  "summary": "38 tests passed, 92% coverage",
  "durationMs": 12400
}
```

## When to log

- **Always** — test runs, builds, migrations, deploys, any destructive op.
- **Always** — long-running commands (>5s).
- **Skip** — `ls`, `cat`, `pwd`, `which` — read-only, no state change.

## What `summary` should contain

- Tests: pass count / fail count / first failure if any
- Builds: success or first error line
- Package installs: packages added/removed, lockfile changed yes/no

Keep summary ≤120 chars. Put full output into an artifact if you need to preserve it.
