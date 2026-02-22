# Skill Learnings

When subagents use `query_support_agent` with a skill name and research context, the LLM may produce learnings. These are appended to the skill's `references/Learnings.md` file.

## Location

For each skill: `skills/workspace_skills/<skill_name>/references/Learnings.md`

The `references` folder is created if it does not exist. The original `SKILL.md` is never modified.

## Format

```markdown
# Learnings for <skill_name>

Improvements and insights discovered during agent runs.

---

## Learning (2025-02-19)

<learning content>
```

## Flow

1. Subagent calls `query_support_agent(query="...", problem_or_skill="prioritization", research_context="...")`
2. SupportQueryTool uses LLM to analyze and produce learnings.
3. If `problem_or_skill` matches a workspace skill name, learnings are appended to that skill's `references/Learnings.md`.
