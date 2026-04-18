# 04 — Agent Skills

*The single most important mechanism for replacing Arceus's embedding-based skill matching with progressive disclosure.*

---

## 4.1 The contract

OpenCode implements the **Agent Skills** open specification from agentskills.io — incubated in Anthropic's skills system — as a first-class, filesystem-driven loader ([opencode.ai/docs/skills/](https://opencode.ai/docs/skills/)).

### Discovery paths

Project-local paths are searched by walking up from `cwd` until the git worktree root:

| Scope | Path |
|---|---|
| Project (OpenCode) | `.opencode/skills/<name>/SKILL.md` |
| Global (OpenCode)  | `~/.config/opencode/skills/<name>/SKILL.md` |
| Project (Claude)   | `.claude/skills/<name>/SKILL.md` |
| Global (Claude)    | `~/.claude/skills/<name>/SKILL.md` |
| Project (agent)    | `.agents/skills/<name>/SKILL.md` |
| Global (agent)     | `~/.agents/skills/<name>/SKILL.md` |

The Claude + `.agents/` paths are explicit compatibility affordances — skills authored for Claude Code / Claude.ai work in OpenCode unchanged.

### Frontmatter schema

OpenCode recognizes **only 5 fields** at the skill frontmatter level:

```yaml
---
name:          string    # required
description:   string    # required, 1–1024 chars
license:       string    # optional
compatibility: string    # optional
metadata:                # optional, string → string map
  key: value
---
```

Unknown fields are silently ignored.

The underlying [agentskills.io/specification](https://agentskills.io/specification) adds one more field that OpenCode's page does not enumerate but Anthropic-authored skills use:

- **`allowed-tools`** — space-separated list of pre-approved tool invocations (e.g. `Bash(git:*) Bash(jq:*) Read`). Marked **experimental**; support varies per client. *[unconfirmed whether OpenCode honors this — treat as unsupported until verified.]*

Note: **there is no `model:` hint** in skill frontmatter. That field exists for agents and commands, not skills. If you need model routing per skill, it has to live in a custom agent definition that references the skill.

### Name rules (strict)

- 1–64 chars
- regex `^[a-z0-9]+(-[a-z0-9]+)*$`
- Must equal the parent directory name

## 4.2 Progressive disclosure — the three tiers

From Anthropic's canonical `skill-creator/SKILL.md` and echoed in agentskills.io/specification:

```
Tier 1   Metadata         ~100 tokens      name + description, always in context
Tier 2   SKILL.md body    <5,000 tokens    loaded when the skill is activated
Tier 3   Bundled files    as needed        scripts/, references/, assets/
```

### Tier 1 — the auto-injected catalog

OpenCode concatenates every discovered skill's name + description into the `skill` tool's description, wrapped in an `<available_skills>` XML block:

```xml
<available_skills>
  <skill>
    <name>git-release</name>
    <description>Create consistent releases and changelogs</description>
  </skill>
  <skill>
    <name>ceo-delegate-task</name>
    <description>How the CEO delegates a task to an engineer…</description>
  </skill>
</available_skills>
```

This catalog is always in the system prompt. The model sees it every turn. **This is what replaces Arceus's current `buildSkillCatalog` + `classifyTaskSkills` LLM pre-flight.**

### Tier 2 — body loaded on demand

When the agent decides to use a skill, it calls:

```
skill({ name: "git-release" })
```

OpenCode then injects the corresponding `SKILL.md` body into the conversation. Before that call, the body is **not** in context.

### Tier 3 — bundled resources

`scripts/`, `references/`, and `assets/` subdirectories under the skill folder. Per agentskills.io and `skill-creator`:

- `scripts/` — executable code (Python, Bash, JS) the agent can `Bash`-invoke without ever loading into context. Best for deterministic/repetitive work.
- `references/` — lazy-loaded Markdown files (`REFERENCE.md`, `FORMS.md`, domain-specific) the agent reads only when needed.
- `assets/` — static templates, icons, fonts used in output.

**Crucial:** tier-3 files are accessed via normal `Read`/`Bash` tool calls, *not* returned by `skill()`. The `skill` tool's only job is to swap tier-1 metadata for tier-2 body; everything else uses existing tools.

## 4.3 The `skill` built-in tool

- Input: `{ name: string }`
- Output: the target skill's `SKILL.md` body (frontmatter stripped) injected into the conversation
- Tool description: dynamically enumerates discovered skills as the `<available_skills>` block shown above
- Permission category: `skill` (see §4.5)

The per-beat config can disable the tool outright (`tools: { skill: false }`), in which case the `<available_skills>` block is omitted.

## 4.4 Authoring conventions

The canonical authoring guide is Anthropic's `skill-creator` skill itself (`anthropics/skills/skills/skill-creator/SKILL.md`), plus the spec at agentskills.io/specification.

### Anatomy

```
skill-name/
├── SKILL.md              (required)
│   ├── YAML frontmatter  (name, description required)
│   └── Markdown body
└── Bundled Resources     (optional)
    ├── scripts/          — executable code for deterministic/repetitive tasks
    ├── references/       — docs loaded on demand
    └── assets/           — templates, icons, fonts used in output
```

### The description is the primary triggering mechanism

`skill-creator` is emphatic: **all "when to use" info goes here, not in the body.** And it recommends descriptions be *slightly pushy* because models tend to under-trigger skills:

> Instead of `"How to build a simple fast dashboard..."`, you might write `"How to build a simple fast dashboard... Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a dashboard."`

### Body length

Keep SKILL.md under ~500 lines / ~5,000 tokens. If you exceed, split into `references/` with explicit pointers from `SKILL.md` telling the agent when to read each.

### Large references

For reference files >300 lines, include a table of contents.

## 4.5 Per-agent skill scoping

[opencode.ai/docs/skills/](https://opencode.ai/docs/skills/) confirms both global pattern permissions and per-agent overrides:

### Global

```jsonc
{
  "permission": {
    "skill": {
      "*":            "allow",
      "pr-review":    "allow",
      "internal-*":   "deny",
      "experimental-*": "ask"
    }
  }
}
```

Three verbs:
- `allow` — load immediately
- `deny` — **skill hidden from the agent entirely; the catalog entry is removed**
- `ask` — user prompted (avoid in headless Arceus)

Patterns support `*` wildcards.

### Per-agent override

```yaml
---
permission:
  skill:
    "documents-*": "allow"
    "ceo-*":       "deny"
---
```

For built-in agents, override via `opencode.json`:

```jsonc
{
  "agent": {
    "plan": {
      "permission": { "skill": { "internal-*": "allow" } }
    }
  }
}
```

**For Arceus:** the cleanest model is to skip per-agent skill permissions entirely and instead **filter at materialize time** — the CEO beat only gets CEO-role SKILL.md files written to its beat dir. The agent sees a catalog that already matches its role, and no permission rule is needed.

## 4.6 Example 1 — minimal OpenCode skill

From [opencode.ai/docs/skills/](https://opencode.ai/docs/skills/):

```markdown
---
name: git-release
description: Create consistent releases and changelogs
license: MIT
compatibility: opencode
metadata:
  audience: maintainers
  workflow: github
---

## What I do
- Draft release notes from merged PRs
- Propose a version bump
- Provide a copy-pasteable `gh release create` command

## When to use me
Use this when you are preparing a tagged release.
Ask clarifying questions if the target versioning scheme is unclear.
```

## 4.7 Example 2 — production-grade skill with tier-3 (PDF)

From `anthropics/skills/skills/pdf/SKILL.md` (abridged):

```markdown
---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files.
  This includes reading or extracting text/tables from PDFs, combining or merging
  multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks,
  creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting
  images, and OCR on scanned PDFs to make them searchable. If the user mentions
  a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## Overview
This guide covers essential PDF processing operations using Python libraries.
For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md.
If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Quick Start
```python
from pypdf import PdfReader, PdfWriter
...
```
```

On-disk structure:

```
skills/pdf/
├── SKILL.md            # the body
├── reference.md        # "see REFERENCE.md" pointer from body
├── forms.md            # "read FORMS.md" pointer from body
├── LICENSE.txt
└── scripts/            # executable helpers, never loaded into context
    ├── extract_text.py
    ├── merge_pdfs.py
    └── fill_form.py
```

Notice the pattern:
- Body is short and task-structured
- Description names every trigger phrase
- SKILL.md explicitly **routes** the agent to tier-3 files for subtasks

The `mcp-builder` skill in the same repo follows the same shape — body plus `reference/` (singular) with `mcp_best_practices.md`, `node_mcp_server.md`, `python_mcp_server.md`, with the body saying "see [TypeScript Guide](./reference/node_mcp_server.md)" when the agent needs the tier-3 jump.

## 4.8 Skills vs custom commands

A quick disambiguation:

| Concern | Skill | Command |
|---|---|---|
| Who triggers it | **Agent** (autonomously, via `skill()` tool) | Human (`/name` in TUI) |
| Discovery | Tier-1 catalog in system prompt | TUI auto-complete |
| Progressive disclosure | Yes (3 tiers) | No (full template always) |
| Can call scripts/refs | Yes (tier-3) | Only via `!cmd` and `@file` |
| Model hint | Not supported | `model:` in frontmatter |
| Per-agent scoping | Pattern-based permissions | `agent:` field |

**Rule of thumb:** behavior that should be picked up *autonomously* when relevant = skill. Human-invoked macro = command. For Arceus specifically, **skills are what you want** — CEO/PM/Engineer agents must pull capability without a human typing `/`.

## 4.9 Nanobot — the contrast

Briefly: [github.com/nanobot-ai/nanobot](https://github.com/nanobot-ai/nanobot) is an MCP host, not a skill runtime. Its directory-based config loads *agents* with frontmatter, not skills with progressive disclosure:

```yaml
agents:
  dealer:
    name: Blackjack Dealer
    model: gpt-4.1
    mcpServers: blackjackmcp
mcpServers:
  blackjackmcp:
    url: https://blackjack.nanobot.ai/mcp
```

Lessons for Arceus:

1. **Nanobot binds capability through MCP servers**, not skills. Good for tool endpoints, not for prompt knowledge. OpenCode's skill model is the better fit for Arceus because Arceus skills are mostly procedural prompt knowledge (how to run a sprint review, how to structure an org chart).
2. **Nanobot has no tier-2 lazy-load.** Every agent instruction is always in context. That's exactly what Arceus wants to avoid — it's the problem that drove the embedding `matchSkillsAsync` workaround.
3. **Nanobot's `agents/main.md` auto-entrypoint** is a clean UX idea Arceus could mirror for beat-scoped agent materialization.

Verdict: use OpenCode as the loader. Nanobot is filed under "interesting but not suitable for our lifecycle."

## 4.10 Mapping this onto Arceus's `SkillArtifact`

The existing `SkillArtifact` schema (see `packages/contracts/src/skills.ts`) already contains everything needed for tier-2:

| `SkillArtifact` field | Maps to |
|---|---|
| `name` | SKILL.md parent dir + frontmatter `name` (sanitized to slug) |
| `trigger` | SKILL.md frontmatter `description` |
| `content` | SKILL.md body |
| `role` | Used by `materializeBeatSkills` to filter which skills appear in the beat |
| `status === "active"` | Materialization filter |
| `id`, `version`, `successRate` | Written into `metadata:` as custom keys for hook-back tracking |

For tier-3 support, add a `resources: SkillResource[]` field — covered in [`05-arceus-integration.md`](./05-arceus-integration.md).

## Sources

- [opencode.ai/docs/skills/](https://opencode.ai/docs/skills/) — discovery paths, frontmatter, `skill` tool, permissions
- [agentskills.io/specification](https://agentskills.io/specification) — canonical Agent Skills spec
- [github.com/anthropics/skills](https://github.com/anthropics/skills) — `skill-creator`, `pdf`, `mcp-builder` reference skills
- [github.com/nanobot-ai/nanobot](https://github.com/nanobot-ai/nanobot) — contrast

## Flagged uncertainties

- Whether OpenCode honors the `allowed-tools` frontmatter field (spec defines it as experimental; OpenCode skills page lists only 5 fields).
- Whether OpenCode has special semantics for `scripts/`, `references/`, `assets/` subdirectories (docs only describe `SKILL.md` discovery). In practice tier-3 is accessed via normal `Read`/`Bash`, so this probably doesn't matter.
- Skill-name collision precedence across the 6 discovery paths — not documented. For Arceus this is moot because we write only to per-beat `.opencode/skills/`, but worth confirming before mixing global + project skills.
