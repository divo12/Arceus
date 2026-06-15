# Superpowers → Arceus integration

[obra/superpowers](https://github.com/obra/superpowers) is a library of **process-discipline** skills for Claude Code (TDD, systematic-debugging, verification-before-completion, …). Arceus's OpenCode agents already have a skill system; this integration vendors the superpowers process skills into it so the agents *work* with discipline, not just with domain reference.

## Why it fits (1:1 mechanics)

| superpowers | Arceus |
|---|---|
| `SKILL.md` with `name` + `description` frontmatter | `.arceus/skills-seed/<slug>/SKILL.md` (name + description + **role** + **trigger**) |
| `Skill` tool | OpenCode `skill({name})` resolved against `.opencode/skills/<slug>/` |
| `using-superpowers` SessionStart rule | per-role **prompt preamble** (Arceus controls the beat prompt) |
| skills evolve in git | Arceus skill **registry + evolution** (successRate/usageCount, skill_mutator) |

A vendored skill flows through the existing pipeline unchanged: `seedExistingSkills → skill-registry → materializeStaticSkillsForCompany → .opencode/skills/`.

## The three layers

**1. Content** — `scripts/sync-superpowers.ts` reads each curated superpowers `SKILL.md`, rewrites its frontmatter for Arceus (namespaced `sp-` slug, role scoping, `trigger` = the superpowers "use when…" description, `source: obra/superpowers`), and writes it to `.arceus/skills-seed/`. Re-run to track upstream:

```
npx tsx scripts/sync-superpowers.ts            # sync
npx tsx scripts/sync-superpowers.ts --dry      # preview
```

Curated role map (`SUPERPOWERS_SKILL_MAP`):

| skill | Arceus role(s) |
|---|---|
| sp-test-driven-development | developer |
| sp-systematic-debugging | developer, tester |
| sp-verification-before-completion | developer, tester |
| sp-brainstorming | ceo, pm |
| sp-writing-plans | pm, cto |

Excluded: `using-superpowers` (meta — replaced by the preamble), `dispatching-parallel-agents` / `subagent-driven-development` (Arceus roles are `mode: primary`, frontend-stitched — not subagent-delegated).

**2. Discipline** — the relevant `sp-*` skills are invoked at the exact decision points in the agent prompt. Developer beat loop (`employee-prompts/developer.ts`): `sp-test-driven-development` before implementing, `sp-systematic-debugging` when typecheck/tests fail, `sp-verification-before-completion` before `task_complete`.

**3. Gating** — `sp-verification-before-completion` is reinforced by the gates Arceus already has (`runVerificationGate` / `computeEffectiveVerdict`, the code-review verifier, the browser flow-tester): the skill says "prove it works," the gate *enforces* "no done without evidence."

## Extending

Add an entry to `SUPERPOWERS_SKILL_MAP` and re-run the sync. Because each skill lands in the registry, Arceus's `skills_lead` + skill-evolution can refine the seeded copy per company over time. Provenance is recorded per-skill (`source: obra/superpowers`) — keep upstream attribution per its LICENSE.
