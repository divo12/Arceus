---
name: task-completion-checklist
description: Call task_complete only when evidence fields are populated and handoff is staged.
role: developer
trigger: task is about to be marked complete
---

# Task Completion Checklist

Before calling `task_complete`, verify:

1. **Work is actually done** — all planned changes applied, no pending edits.
2. **Tests pass** — run the project's test suite and confirm exit code 0.
3. **Evidence is concrete** — include artifact IDs, preview URLs, and the commit/branch where work lives.
4. **No placeholders** — no stub functions, no TODO comments in production code, no empty component props.
5. **Next role can continue** — if tester/designer needs context, stage it in the artifact content or via a follow-up tool call.

## Evidence shape

```json
{
  "evidence": {
    "artifactIds": ["art_123"],
    "previewUrl": "https://...",
    "testsPassed": true,
    "commandsRun": ["npm test", "npm run build"]
  }
}
```

See `resources/evidence-templates.md` for full templates per task kind.
See `resources/common-failures.md` for what blocks completion.
