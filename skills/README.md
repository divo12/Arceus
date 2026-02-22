# Skills Structure

Three-tier skill organization:

## 1. Essential (`skills/essential/`)

Survival skills — always loaded in every session.

- **first-principles-thinking** — Break down problems into fundamentals; challenge assumptions
- **heartbeat** — HEARTBEAT.md for periodic autonomous tasks
- **memory** — Episodic memory and run traces
- **web-search** — web_search/web_fetch for domain context

## 2. Workspace (`skills/workspace_skills/`)

PM designation skills — product management frameworks and methodologies.

- Problem framing, prioritization, PRD development, user stories, etc.
- Workspace-specific; created via onboard or skill-gap drafts.

## 3. Open (`skills/open_skills/`)

Tool-level skills — widely-used tasks (from [besoeasy/open-skills](https://github.com/besoeasy/open-skills) + core tools).

- pdf-manipulation, web-search-api, send-email-programmatically, github, cron, etc.
- Agent uses these instead of looking up how to do tasks on the net.

## Skill Format

Each skill is a directory with `SKILL.md`:

```
skill-name/
├── SKILL.md (required)
└── [scripts/, references/, assets/] (optional)
```

Frontmatter: `name`, `description`; optional `always: true` for non-essential skills that should always load.
