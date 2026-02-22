# Cursor Skills for Arceus

When developing Arceus in Cursor, project-specific skills help the AI assistant create and maintain Agent Skills correctly.

## skill-creator

**Location:** `.cursor/skills/skill-creator/SKILL.md`

**Purpose:** Guides the AI when creating or updating Agent Skills in the Arceus project. Triggers when designing, structuring, or packaging skills with scripts, references, and assets.

**Use when:**
- Creating new skills in `skills/open_skills/`, `skills/essential/`, or `skills/workspace_skills/`
- Updating existing skills
- Structuring skills with bundled resources (scripts, references, assets)

**Key guidance:**
- Draft skills go to `skills/workspace_skills/_drafts/` until human review
- Skill anatomy: SKILL.md (required) + optional scripts/, references/, assets/
- Progressive disclosure: keep SKILL.md lean; move details to reference files
- Arceus paths: open_skills, essential, workspace_skills

See `.cursor/skills/skill-creator/SKILL.md` for the full skill content.
