---
name: sl-skill-authoring-guide
description: How to write a SKILL.md that actually gets used — frontmatter, triggers, body structure, budget constraints.
role: sl
trigger: about to register a new skill, update an existing one, or rewrite a proposal from the skill-evolution pipeline
---

# Skill Authoring Guide (SL meta-skill)

You are the library curator. Every skill you register shapes how another agent reasons on every beat that skill gets injected. Quality matters compounding times — a sloppy skill that gets called 500 times per sprint is worse than one that never gets called.

This skill teaches you how to write a SKILL.md that earns its slot in the progressive-disclosure catalog.

## When this fires

- You're about to call `skill_register` on a new skill
- You're about to call `skill_update` to rewrite an existing skill
- You're reviewing a `skill_evolution_review` delegation task where the proposed skill needs revision
- You're synthesizing a candidate from a recurring pattern

Not this skill when: deprecating (use `sl-deprecation-reasoning`), health-checking (use `sl-library-health-diagnosis`).

## The five quality gates

A skill is good if it passes all five:

### 1. The trigger is specific and falsifiable

The `trigger:` frontmatter field decides when the agent reads the skill. Bad triggers are vague; good triggers are falsifiable — the agent can look at its task and say yes/no.

| Bad | Good |
|---|---|
| "writing code" | "starting a TDD task where acceptance criteria specify tests first" |
| "doing PM work" | "sprint planning when multiple candidate tasks compete for dev capacity" |
| "meeting prep" | "about to attend a daily_sync or decision meeting" |

Rule: trigger ≤ 1 line, ≤ 200 chars. Names a concrete situation, not a role.

### 2. The description teaches in one line

`description:` is what renders in the progressive-disclosure catalog. ≤ 200 chars. Must answer: *what does calling this skill get me?*

- Bad: "Helps the agent write better code."
- Good: "Draft a task DAG for a sprint or decompose a large task into subtasks."

### 3. The body answers "how" not "what"

Agents already know what their role does. A skill teaches **the method** — checklists, decision trees, anti-patterns, examples of the shape of a good output.

Structural template:

```
# <Skill Title>

<1-paragraph why-this-exists>

## When this fires

<When to use; when NOT to use>

## The loop / The checklist / The decision tree

<The actual method — numbered steps, tables, or short procedures>

## Heuristics

<Rules of thumb; bounded quantities>

## Failure modes

<Common mistakes with symptoms + fixes>

## Anti-patterns

<What to explicitly not do>
```

Not every skill needs every section, but body < 300 lines.

### 4. It names concrete artifacts + tools

A skill that doesn't name tools or artifacts is an essay. Good skills say:

- "Call `task_create` with `kind: "implementation"`"
- "Attach `relatedArtifactIds` to the `memory_handoff` payload"
- "If validation fails, return to round 1 with the failed check highlighted"

The agent can act on these. Abstract advice without tool names usually gets ignored.

### 5. It has bounded quantities

Unbounded rules create chaos: "think hard about this," "review carefully." Bounded rules give the agent a stopping condition: "maximum 3 iterations," "≤ 12 nodes per sprint," "fail if > 5 failures/hour."

Every checklist and loop needs a cap.

## Progressive-disclosure budget constraints

The catalog injects every skill the role has. Budget rules:

- ≤ 40 skills per role (hard cap)
- Current: well under 40 per role — you have headroom
- Each injection costs ~15 tokens (description + trigger)
- Keep skill bodies in files (OpenCode `skill({id})` loads on demand) — body size doesn't affect the catalog

## Frontmatter template

```yaml
---
name: <role>-<specific-action-phrase>
description: <≤ 200 char one-liner — what does calling this get me?>
role: <one or more role enums, comma-separated: ceo, cto, pm, dev, qa, ui, mkt, sl — OR "all">
trigger: <≤ 200 char falsifiable situation>
---
```

Naming convention:
- `<role>-<verb>-<noun>`: `pm-prioritization-framework`, `cto-acceptance-criteria-writing`
- Shared skills: verb-first, no role prefix: `memory-hygiene`, `escalation-protocol`
- Meta-skills: `<role>-<meta-topic>`: `sl-skill-authoring-guide` (this one)

## Heuristics

- **One trigger per skill.** If the trigger sentence needs "or" linking unrelated situations, it's two skills.
- **Length vs utility.** 50-line skill used 20×/sprint > 200-line skill used 2×/sprint.
- **Show, don't tell.** A checklist the agent walks beats a paragraph explaining why.
- **Write for future-you.** In 6 months, will you know why this rule exists?

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Skill has 0 invocations after N sprints | Trigger too vague OR skill competes with another | Rewrite trigger to a specific situation; or merge/deprecate |
| Skill fires but agent ignores guidance | Body is advice, not procedure | Replace prose with checklists + tool calls |
| Skill fires in wrong contexts | Trigger too broad | Tighten; add "not this skill when" section |
| Two skills compete for same trigger | Overlapping scope | Merge, or narrow one to a sub-case |

## Anti-patterns

- **Role-branching inside a skill** — if a skill's body has `if role === "dev"...`, split into two skills with clearer role tags.
- **Meta-prompt injection** — don't write skills that instruct the agent to ignore its role or act outside its allowlist. Respect the governance boundary.
- **Generic advice** — "write good code," "communicate clearly," "be thorough." These waste context.
- **Skipping anti-patterns section** — agents learn as much from what NOT to do as from what TO do.
- **Over-formality** — SKILL.md is operational, not academic. No citations, no "Further reading."

## Before you call `skill_register`

Run the checklist:

- [ ] Trigger names a concrete, falsifiable situation
- [ ] Description ≤ 200 chars and answers "what do I get?"
- [ ] Body has at least: when-this-fires, method (loop or checklist), failure modes
- [ ] Names at least 2 tools or artifact kinds by concrete name
- [ ] Has at least one bounded quantity (cap, threshold, timeout)
- [ ] No role-branching inside the body
- [ ] `skill_validate_definition` passes

Then register.
