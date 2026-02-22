---
name: skill-creator
description: Create or update Agent Skills for the Arceus project. Use when designing, structuring, or packaging skills with scripts, references, and assets. Triggers when creating skills in skills/open_skills/, skills/essential/, or skills/workspace_skills/.
---

# Skill Creator

Guidance for creating effective Agent Skills in the Arceus project.

## Draft Skill Review Gate

When draft skills are auto-generated from runtime gap detection, treat them as proposal artifacts only:

- keep drafts under `skills/workspace_skills/_drafts/`
- require explicit human review before promotion
- move approved drafts into `skills/workspace_skills/<skill-name>/SKILL.md`

## About Skills

Skills are modular, self-contained packages that extend the agent's capabilities by providing specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific domains or tasks.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share the context window with everything else the agent needs.

**Default assumption: the agent is already very smart.** Only add context the agent doesn't already have. Challenge each piece: "Does the agent really need this?" and "Does this justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

- **High freedom** (text instructions): Multiple valid approaches, context-dependent decisions
- **Medium freedom** (pseudocode/scripts with parameters): Preferred pattern exists, some variation acceptable
- **Low freedom** (specific scripts): Fragile operations, consistency critical, specific sequence required

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter: name, description (required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation loaded as needed
    └── assets/           - Files used in output (templates, icons, etc.)
```

#### SKILL.md

- **Frontmatter**: `name` and `description` only. The description is the primary triggering mechanism—include both what the skill does and when to use it. Put all "when to use" info in the description, not the body.
- **Body**: Instructions and guidance. Only loaded after the skill triggers.

#### Bundled Resources

- **scripts/**: When the same code is rewritten repeatedly or deterministic reliability is needed. Token efficient, may be executed without loading into context.
- **references/**: Documentation the agent should reference while working. Keeps SKILL.md lean; loaded only when needed. Avoid duplication—info lives in SKILL.md or references, not both.
- **assets/**: Files used in the output (templates, images, boilerplate). Not loaded into context.

#### What NOT to Include

Do NOT create: README.md, INSTALLATION_GUIDE.md, QUICK_REFERENCE.md, CHANGELOG.md, or other auxiliary docs. Only include files that directly support the skill.

## Progressive Disclosure

1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<5k words)
3. **Bundled resources** - As needed by the agent

Keep SKILL.md under 500 lines. Split into reference files when approaching this limit. Link directly from SKILL.md—avoid deeply nested references.

## Skill Creation Process

1. Understand the skill with concrete examples
2. Plan reusable contents (scripts, references, assets)
3. Initialize the skill (create structure)
4. Edit the skill (implement resources and write SKILL.md)
5. Package/validate the skill
6. Iterate based on real usage

### Skill Naming

- Lowercase, digits, hyphens only; hyphen-case (e.g., "Plan Mode" → `plan-mode`)
- Under 64 characters
- Prefer short, verb-led phrases
- Namespace by tool when it helps (e.g., `gh-address-comments`)
- Folder name = skill name

### Step 1: Understanding with Concrete Examples

Ask: What functionality? Can you give examples? What would trigger this skill?

Conclude when there is a clear sense of the functionality.

### Step 2: Planning Reusable Contents

For each example: (1) How to execute from scratch? (2) What scripts, references, assets would help when repeated?

Examples:
- PDF rotation → `scripts/rotate_pdf.py`
- Frontend webapp → `assets/hello-world/` template
- BigQuery queries → `references/schema.md`

### Step 3: Initializing the Skill

**If `init_skill.py` exists** (e.g., in experiments/skill-creator/scripts/):

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

Output paths for Arceus: `skills/open_skills/`, `skills/essential/`, or `skills/workspace_skills/`.

**Otherwise, create manually:**

```bash
mkdir -p skills/<category>/<skill-name>/{scripts,references,assets}
# Create SKILL.md with frontmatter template
```

### Step 4: Edit the Skill

- Start with reusable resources (scripts, references, assets)
- Test scripts by running them
- Update SKILL.md with imperative/infinitive form
- Frontmatter: `name` and `description` only. Description must include what + when.

### Step 5: Package/Validate

**If `package_skill.py` exists:**

```bash
scripts/package_skill.py <path/to/skill-folder>
```

**Otherwise:**
- Validate frontmatter (name, description present and valid)
- Ensure folder name matches skill name
- Run `experiments/skill-creator/scripts/check-skill-metadata.py` if the skill follows the PM format (type, required sections)

### Step 6: Iterate

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Update SKILL.md or bundled resources
4. Test again

## Arceus Project Paths

| Category | Path |
|----------|------|
| Open skills | `skills/open_skills/<skill-name>/` |
| Essential | `skills/essential/<skill-name>/` |
| Workspace | `skills/workspace_skills/<skill-name>/` |
| Drafts | `skills/workspace_skills/_drafts/` |

Per AGENTS.md: When adding a new tool in agents folder, use `./experiments/skill-creator/creator/Skill.md` to create the relevant built-in skill.
