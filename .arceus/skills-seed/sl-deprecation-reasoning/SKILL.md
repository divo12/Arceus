---
name: sl-deprecation-reasoning
description: Decide when to deprecate a skill — migration path, historical preservation, catalog-budget recovery.
role: sl
trigger: skill_audit_unused flags a skill with 0 invocations in 3+ sprints, OR health-diagnosis finds low-value skills crowding the catalog
---

# Deprecation Reasoning

Deprecation is curation. A library that only grows becomes noise. This skill helps you cut without losing value.

## When this fires

- `skill_audit_unused` returned candidates for deprecation
- `sl-library-health-diagnosis` flagged a skill as low-value
- Catalog-budget pressure (close to 40-skill cap for a role)
- A skill has been superseded by a newer, better one

Not this skill when: the skill is low-usage but still valuable (emergency handlers, rare-case patterns) — investigate instead.

## The deprecation test

Before deprecating, answer all five:

### 1. Is usage genuinely zero, or just rare?

- Zero invocations in 3+ sprints → probable deprecation candidate
- 1-3 invocations / sprint → rare but alive; investigate if it's rare-but-critical
- Check EMA: a skill invoked rarely but successfully is different from invoked rarely and failing

Tool: `skill_inspect_history` for invocation trail + success rates.

### 2. Is the capability still needed, or has the need gone away?

The skill might be unused because:
- **The need disappeared** (feature removed, product pivoted) → safe to deprecate
- **The need is covered elsewhere** (better skill, OpenCode built-in, context injection) → safe to deprecate
- **The need still exists but agents stopped invoking** → don't deprecate; investigate why (trigger wrong? skill buried?)

### 3. If a need exists, is there a migration path?

If deprecating, point future invocations somewhere:
- To another skill (preferred)
- To a tool or built-in
- To a workflow ("don't need this; use X instead")

Document in the deprecation note.

### 4. Is the history valuable?

Skills you deprecate shouldn't vanish. They're data:
- What problems did we think existed?
- What solutions did we try?
- Why did this one fail to catch on?

`skill_deprecate` soft-deletes — preserves the SKILL.md with a `deprecated: true` frontmatter field. Don't hard-delete.

### 5. Would the role suffer if this skill vanished tomorrow?

If no → deprecate.
If yes → don't deprecate; revise instead.

## The loop

```
1. Identify candidates (skill_audit_unused or health-diagnosis output)
2. For each candidate, walk the 5-test:
   - Zero usage? (verify)
   - Need gone? (check)
   - Migration path? (identify)
   - Preserve history? (always yes; soft-delete)
   - Would role suffer? (sanity check)
3. Decision:
   - All 5 green → skill_deprecate
   - Any caution → investigate before acting
4. Emit:
   skill_deprecate({
     id,
     reason: "<specific reason>",
     migrationPath: "<where to route instead>"
   })
5. Log:
   memory_add_learning({
     content: "Deprecated <skill name>: <reason>. Migration: <path>. Preserved at <location>.",
     tags: ["skill-deprecation", "curation"]
   })
6. If roles might be affected, notify:
   memory_handoff({
     targets: [<affected roles>],
     kind: "context_transfer",
     content: "Skill <name> deprecated. If you used it: use <migration path> instead."
   })
```

## Deprecation notice format

The skill file stays; frontmatter updates:

```yaml
---
name: <original-name>
description: <original description>
role: <original roles>
trigger: <original trigger>
deprecated: true
deprecated_at: "2026-04-23"
deprecated_reason: "Superseded by <new-skill>; need no longer exists since <feature/pivot>"
migration: "Use <new-skill-name> for similar situations; or see <alt path>"
---

[Original body preserved]

**DEPRECATED (2026-04-23):** <reason + migration>. Do not invoke.
```

Catalog injection logic skips skills with `deprecated: true`. The file remains discoverable via `skill_inspect_history` for audit purposes.

## Heuristics

- **Deprecate quickly; resurrect rarely.** A deprecated skill is usually done. Resurrection needs a real new reason.
- **Batch deprecations.** Reviewing 3-4 at once catches patterns (e.g., all from same era, all in same role, all replaced by same mechanism).
- **Deprecate after confirming migration.** If you deprecate without the migration path ready, you leave a hole.
- **Never deprecate during active sprint use.** Check `skill_inspect_history` — if there's been invocation in the current sprint, wait one sprint post-use to confirm it's truly gone.
- **Communicate the deprecation.** Roles that used the skill should know via `memory_handoff`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Agent calls a deprecated skill, gets confused | Migration path wasn't communicated | Handoff on deprecation to affected roles |
| Deprecated skill gets re-added later | Need came back but deprecation knowledge was lost | Keep history readable via `skill_inspect_history` |
| Catalog still full after deprecations | Deprecated skills still injected | Verify catalog-injection logic filters deprecated |
| Deprecation causes immediate regression | Skipped "would role suffer" check | Always check; revise instead of deprecate if suffering likely |

## Anti-patterns

- **Hard-deleting the skill file.** Loses history. Always soft-delete.
- **Deprecating without migration path.** Leaves agents stranded.
- **Deprecating skills that fire rarely but save the sprint when they do.** Value ≠ frequency.
- **Resurrecting deprecated skills instead of authoring new ones.** If the need evolved, author fresh — don't un-deprecate stale patterns.
- **Deprecating skills authored by the pipeline without reviewing pipeline's logic.** Pipeline proposals may be low-quality; deprecate proposals, but also flag for `sl-review-skill-evolution-proposal` tuning.
