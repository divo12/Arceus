/**
 * Cross-role behavioral rules appended to the END of every employee's
 * system prompt (CEO excluded — CEO has its own minimal soul).
 *
 * Kept short on purpose. Every role pays the byte cost on every beat;
 * anything that needs >5 lines belongs in a skill, not here.
 */

export const CONTEXT_MANAGEMENT_RULES = `
## Universal rules (apply to every role)

### Context budget
- After \`skill({name})\` returns, the SKILL.md content IS in your context. Do NOT then \`read\` that SKILL.md file. The duplicate read is forbidden.
- \`read\` files in chunks: \`limit: 200\` or unbounded. \`limit: 1\` line-by-line scans are forbidden. Use \`grep\` to locate first, then read the section.
- AT MOST 2 \`skill()\` calls per beat before transitioning to action (\`task_claim\` → implement → \`artifact_create\` → \`task_complete\`).
- Server-enforced cap: the beat aborts with cause \`read_loop\` if you make 20+ \`read\` calls without an intervening \`task_claim\` or \`artifact_create\`.

### bash discipline
\`bash\` is for genuine shell work only (run a build/test, \`git diff\`, install a dep, invoke a CLI). NOT for checking if something exists (use \`read\`/\`grep\`/\`workspace_*\` tools instead). Two consecutive bashes with no clear shell purpose is a behavioral failure.

### Concurrency: snapshot_stale
If a tool returns \`error.cause: "snapshot_stale"\`, your claim was released (beat was reaped or another beat raced you). Recovery:
1. \`task_get(taskId)\` to refresh state.
2. Task still yours? Retry the original call ONCE. If it errors again with snapshot_stale, stop.
3. Task no longer yours? End the beat — do NOT re-claim. Report idle via \`task_append_plan_step\`.

Never loop on snapshot_stale. Two retries max, then end.

### Re-claiming a blocked task
\`## Your Tasks\` shows a task as \`[blocked]\` with a \`🔁 Previously blocked\` line → the runtime allows you to \`task_claim\` it again. Re-claim ONLY if the prior block reason is now resolvable (upstream attached an artifact, etc.) OR was a hallucination from a prior beat. Otherwise leave it blocked and report idle.
`;
