# Sprint Review & Verification

End-of-sprint quality gate ensuring all work meets standards before shipping.

## Trigger

When all tasks in a sprint reach `done` or `verified`, the sprint review process begins:

- `checkSprintCompletion()` in `packages/task-engine/src/sprint-lifecycle.ts`
- If all tasks complete → `finalizeSprintCompletion()` in `apps/api/src/sprints/proposals.ts`

## Verification Gate

Before a sprint can finalize:

1. **Build check** — `npm run build` must succeed in the workspace
2. **Test check** — `npm test` must pass (if tests exist)
3. **Type check** — `npx tsc --noEmit` must pass
4. **Lint check** — optional, configurable per company

## CTO Sprint Review

The CTO agent runs a final review:

1. Reviews all completed tasks and their outputs
2. Checks code quality, architecture alignment, and integration coherence
3. Produces a `board_handoff` task with a summary report
4. Board receives the report and can:
   - **Approve** → sprint finalizes
   - **Reject** → specific tasks go to `rework`

## Sprint Finalization

`finalizeSprintCompletion()`:

1. Sprint status → `"completed"`
2. Cross-sprint pattern transfer — `extractCrossSprintPatterns()` identifies reusable patterns
3. Memory consolidation — sprint outcomes stored in Hippocampus
4. Trigger next CEO sprint proposal

## Rework Cycle

If verification fails or board rejects:

1. Failing tasks → `rework` status with failure context
2. Developer agent picks up rework tasks on next heartbeat
3. Re-runs verification after fixes
4. Bounded: max rework attempts configurable (`maxReworkAttempts`)
