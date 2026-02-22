# Experiments

Exploratory code for later integration.

- **prompt_policy.py** — Prompt selection policy (moved from agents). Was used by cognition/planner for prompts_to_reference. Skills-only flow now; prompts explored here.

- **skill-creator/** — Skill creation support: creator/SKILL.md, research/ (finance, context engineering, etc.), scripts/ (add-a-skill, build-a-skill, check-skill-metadata, etc.). Referenced by AGENTS.md and Cursor skill-creator for creating built-in skills.

- **exploratory_skills/** — Skills moved from open_skills for exploration. Not loaded by the agent by default. Includes: web-search-api, pdf-manipulation, file-tracker, humanizer, free-translation-api, ip-lookup, news-aggregation, and others. To use one, copy its folder back to `skills/open_skills/`.
