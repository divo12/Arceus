---
title: Skills System
---

# 03 · Skills System

Paperclip's skill model is the closest existing analog to what Arceus is building, but the two systems differ in interesting ways. This file captures the model, the injection pipeline, the duality between *repo skills* and *company skills*, and the implications for Arceus's `SkillArtifact`.

---

## Part A: The model — what a skill is

A **skill** is a markdown file (`SKILL.md`) with YAML frontmatter:

```markdown
---
name: paperclip
description: >
  Use this skill whenever you need to talk to the Paperclip control plane
  from an agent heartbeat — identity, checkout, comments, subtask creation.
---

# Paperclip skill body
...
```

Frontmatter fields (from `/tmp/paperclip/writing-a-skill.md`):
- `name` — unique, kebab-case id
- `description` — *decision-logic routing text* (not marketing copy). Tells the agent *when* to load this.

Skill layout on disk:
```
skills/{name}/
├─ SKILL.md                    ← the frontmatter + body
└─ references/                 ← optional supporting files the body can link to
```

## Part B: Progressive disclosure (two tiers, not three)

Paperclip uses **two tiers** of disclosure:

- **Tier 1 — metadata.** When the runtime starts, it scans the skills directory and embeds *just the frontmatter* (name + one-line description) into the agent's system prompt as a catalog.
- **Tier 2 — full body.** The agent's runtime (e.g. Claude Code, OpenCode) has a built-in `skill` tool. When the LLM decides a skill applies, it calls `skill({ name: "paperclip" })` and the body is loaded into the conversation.

This is **not** Arceus's current "pre-classify and inject top-K bodies" pattern. Paperclip lets the LLM pull what it wants. Crucially:

- No embedding, no cosine matcher, no classifier LLM call.
- Catalog cost: O(skill_count × ~60 tokens) in every turn.
- Body cost: paid only when the LLM asks.

The model is almost identical to Anthropic's shipped Agent Skills model (`agentskills.io`), because Paperclip defers skill discovery to whichever runtime the adapter wraps.

## Part C: Three skill trees, one runtime

Paperclip keeps skill definitions in three places. Understanding which is which is essential.

### C.1 `/skills/` — **platform skills** (repo root)
- Shipped with Paperclip, available to every company.
- 4 skills at HEAD: `paperclip`, `paperclip-create-agent`, `paperclip-create-plugin`, `para-memory-files`.
- These are the canonical "how do I interact with the control plane" skills every agent needs.

### C.2 `/.agents/skills/` — **agent-scoped workflow skills**
- 8 skills at HEAD, e.g. `company-creator`, `doc-maintenance`, `pr-report`, `prcheckloop`, `release`, `release-changelog`, `deal-with-security-advisory`, `create-agent-adapter`.
- Used by specific agent *roles* during specific workflows. They're not loaded by every agent — they're loaded by agents whose `desiredSkills` config includes them.

### C.3 `/.claude/skills/` — **dev-env skills**
- Skills used by humans contributing to the Paperclip repo itself (e.g. `design-guide`, `company-creator`). Not loaded into agent runtimes.
- These exist because the Paperclip team uses Claude Code themselves on the repo.

### C.4 `company_skills` table — **runtime-mutable per-company skills**
- `packages/db/src/schema/company_skills.ts` stores skills registered *by* companies (via UI or API), not shipped with the repo.
- Columns: `companyId`, `key`, `slug`, `name`, `markdown`, `sourceType` (`"local_path"` | `"remote_url"`), `trustLevel` (`"markdown_only"` | `"full_execution"`), `compatibility` (`"compatible"` | `"deprecated"`), `fileInventory`.
- Resolution order at runtime: **company_skills first, then repo skills, with company_skills winning on name conflict.**

This is the design Arceus should copy directly: filesystem seed + DB override. See `08-arceus-leverage.md §4`.

## Part D: Injection — how skills actually reach the child process

Source: `packages/adapters/claude-local/src/server/skills.ts:1-121` (read in full during research).

### D.1 The snapshot function
```ts
async function buildClaudeSkillSnapshot(
  config: Record<string, unknown>
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills     = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome        = resolveClaudeSkillsHome(config);   // ~/.claude/skills by default
  const installed         = await readInstalledSkillTargets(skillsHome);
  …
}
```
What it does:
1. Reads the available skills from the Paperclip runtime skills dir (platform + agent-scoped).
2. Resolves which ones this agent *desires* (from `agent.adapterConfig.skills`).
3. Looks at `~/.claude/skills` and diffs current state vs desired state.
4. Returns an `AdapterSkillSnapshot` describing the desired end state.

### D.2 Materialization via symlinks
Per `packages/adapters/opencode-local/src/server/execute.ts:57-90`, `ensurePaperclipSkillSymlink(source, target)` creates a symlink from the runtime skills dir to the repo skill path. For Claude Code, the mechanism is:
- `~/.claude/skills/paperclip` → `/path/to/paperclip/skills/paperclip/` (symlink)
- `~/.claude/skills/para-memory-files` → `/path/to/paperclip/skills/para-memory-files/` (symlink)

Then the `claude --print ...` process starts. Claude Code's built-in skill discovery picks up `~/.claude/skills` automatically. No flag needed.

### D.3 Origin labels and state
Each entry in the snapshot carries metadata the UI uses:
- `state`: `configured` (materialised + desired), `available` (known but not desired), `missing` (desired but not available), `external` (found in skill home but not managed by Paperclip).
- `origin`: `paperclip_required`, `company_managed`, `user_installed`, `external_unknown`.
- `origin_label`: human-readable for the UI.

The `user_installed` lane (`readOnly: true`) is how Paperclip coexists with skills a human put in their own Claude config.

### D.4 What does not happen
- **No embedding.** The runtime does not build vectors.
- **No classifier LLM call.** The runtime does not pre-pick skills.
- **No body injection.** Bodies are on disk; the LLM loads them via the `skill` tool.

The whole system relies on the runtime (Claude Code / OpenCode / etc.) having a built-in skill tool. Adapters without one (e.g. `pi-local`) either skip skills or wrap them differently.

## Part E: How skills change over time

There is **no mutation/versioning** of skills in the Paperclip model. A skill is a markdown file. You edit the file. The next run sees the edit.

This is where Paperclip and Arceus diverge:

| Aspect | Paperclip | Arceus |
|---|---|---|
| Storage | filesystem + `company_skills` table (markdown only) | DB `SkillArtifact` rows with `version`, `successRate`, `usageCount`, `mutatedFromId` |
| Versioning | none | explicit (v1 → v2 on mutation) |
| Telemetry | none | `successRate`, `usageCount`, `lastUsedAt`, EMA update |
| Governance | none | ATA (Agentic Tool Alignment) mutation pipeline with Skills Lead approval |
| Loading | filesystem symlinks | DB → seed into prompt |

**Arceus's richer lifecycle is an advantage, not a gap to fill.** But Paperclip's *loading mechanism* (filesystem materialization + model-driven pull via skill tool) is cleaner than Arceus's *classifier pre-injection*. See `08 §4` for the synthesis.

## Part F: The skill body the agent actually reads

Representative skill: `skills/paperclip/SKILL.md`.

The description encodes routing:
> "Use this skill whenever you need to coordinate with other agents, manage tasks, work with company goals, document decisions, or interact with the Paperclip platform."

The body teaches the agent:
- How to authenticate (use `PAPERCLIP_API_KEY` as bearer)
- The REST surface (with example calls)
- Status transitions
- How to handle 409 Conflict
- How to create subtasks
- How to delegate

**This is how a protocol becomes an agent instruction.** The heartbeat checklist lives in the agent's SOUL/HEARTBEAT files; the protocol lives in the `paperclip` skill. Two separate disclosure tiers with different lifetimes.

## Part G: Practical takeaways for Arceus

1. **Keep `SkillArtifact`**, but split storage from loading. Today the artifact is both the record *and* the payload — when we want to change how loading works, we have to touch too much.
2. **Materialize, don't classify.** At beat dispatch, write the active skills for the role to `.opencode/skills/` (or equivalent). Let the LLM pull via the built-in skill tool. Delete the embedding-based `matchSkillsAsync` hot path — we already started this with `progdisc`.
3. **Adopt the `{source_type, trust_level}` lanes.** Today every skill in Arceus is the same. Paperclip's `trust_level: "markdown_only" | "full_execution"` and `source_type: "local_path" | "remote_url"` are exactly what we'll need when companies start importing third-party skills.
4. **Skill mutation pipeline stays.** Paperclip doesn't have one. We do. Our ATA path (`packages/company-runtime/src/skill-mutator.ts`) is ahead of theirs.
5. **Add a `resources` field to `SkillArtifact`** to carry Tier-3 attachments (scripts + references). Paperclip hands them via the filesystem (`skills/{name}/references/...`); our DB-backed model needs an inline array. See `08 §4`.

## Citations

- `packages/adapters/claude-local/src/server/skills.ts:1-121` — skill snapshot + state machine
- `packages/adapters/opencode-local/src/server/execute.ts:57-90` — symlink injection
- `packages/db/src/schema/company_skills.ts:12-36` — DB-backed skill table
- `skills/paperclip/SKILL.md` — canonical protocol skill
- `server/src/onboarding-assets/ceo/HEARTBEAT.md:79` — *"Always use the Paperclip skill for coordination."*
- `/tmp/paperclip/writing-a-skill.md` — full skill authoring doc
