# Contains Studio Agents Integration

**Date:** 2026-04-16  
**Trigger:** Product output quality was unacceptable — developer agent produced a bare unstyled HTML form (Name/Email/Submit) with zero styling, no Tailwind, no design system, no visual polish. Root cause: role soul prompts were too vague ("You are the Developer inside Arceus. You are an OpenCode agent with coding authority.") giving the LLM no actionable expertise to produce quality output.

## Problem

The existing Arceus role soul system prompts were 1-2 sentences of generic identity ("You are the CTO", "You are the Developer"). They provided:
- No tech stack guidance (no mention of Tailwind, React patterns, component libraries)
- No quality standards (no typography scales, spacing systems, color palettes)
- No design expertise (no mention of hover states, animations, empty states)
- No testing methodology (no mention of AAA pattern, Testing Library, coverage strategies)

The result: agents produced the lowest-effort output that technically satisfied the task description.

## Solution

Integrated [Contains Studio AI Agents](https://github.com/contains-studio/agents) — a library of 37 specialized agent definitions with rich 500+ word system prompts covering frontend development, UI design, testing, backend architecture, marketing, and more.

### Architecture

```
packages/company-runtime/
├── skills/agents/           ← 37 .md agent files (copied from Contains Studio repo)
│   ├── frontend-developer.md
│   ├── ui-designer.md
│   ├── rapid-prototyper.md
│   ├── backend-architect.md
│   ├── test-writer-fixer.md
│   ├── brand-guardian.md
│   ├── whimsy-injector.md
│   └── ... (30 more)
└── src/
    ├── agent-skills.ts      ← NEW: loader + role-to-agent mapper
    ├── roles.ts             ← MODIFIED: all 8 soul prompts rewritten
    └── index.ts             ← MODIFIED: exports agent-skills
```

### Two-Layer Enhancement

**Layer 1: Richer Soul Prompts** (`roles.ts`)

Every role's `systemPrompt` was rewritten with concrete, actionable expertise. Examples:

| Role | Before (vague) | After (actionable) |
|------|----------------|-------------------|
| developer | "You are an OpenCode agent with coding authority." | Specifies React+TS, Vite, Tailwind CSS, Framer Motion, shadcn/ui, 8px grid, typography scale, hover/focus/active states, loading skeletons, empty states, error boundaries |
| ui_designer | "You shape the visual direction of the product." | Specifies color palettes with hex values, typography scale (Display 36px → Small 14px), spacing system, component states checklist, micro-animations, whimsy injection, WCAG accessibility |
| tester | "You validate through browser-based QA." | Specifies Vitest/Jest, Testing Library, AAA pattern, edge cases, descriptive test names, WCAG verification, responsive behavior checks |
| cto | "You can break strategy into implementation plans." | Specifies API design, database selection, component architecture, exact tech stacks, file structures, dependency lists, acceptance criteria |

**Layer 2: Skill Injection** (`agent-skills.ts`)

At runtime, each role gets supplementary expertise excerpts from mapped Contains Studio agents appended to their system prompt via `getAgentSkills(role)`.

### Role → Agent Mapping

| Arceus Role | Contains Studio Agents Injected |
|---|---|
| `ceo` | project-shipper, trend-researcher, studio-producer |
| `cto` | backend-architect, devops-automator, ai-engineer |
| `pm` | sprint-prioritizer, feedback-synthesizer |
| `developer` | frontend-developer, rapid-prototyper, backend-architect |
| `tester` | test-writer-fixer, test-results-analyzer, api-tester |
| `ui_designer` | ui-designer, brand-guardian, whimsy-injector, ux-researcher |
| `marketing` | content-creator, growth-hacker, app-store-optimizer |
| `skills_lead` | workflow-optimizer, tool-evaluator |

### Developer Prompt Upgrades (UI Quality)

The developer build prompt (`devSystemPrompt`) was also enhanced with non-negotiable UI standards:

- Tailwind CSS utility classes for all styling (replaces generic "use CSS variables")
- `hover:bg-*`, `focus:ring-2`, `rounded-lg`, `p-4`/`p-6` specifics
- Transitions: `transition-all duration-200` on interactive elements
- Micro-animations: `hover:scale-105`, fade-in for page content
- Loading skeletons: `animate-pulse` for async content
- Empty states must have helpful messages, not blank screens
- Error states must be friendly and actionable

## Files Changed

| File | Change |
|------|--------|
| `packages/company-runtime/src/roles.ts` | All 8 role `systemPrompt` values rewritten with rich expertise |
| `packages/company-runtime/src/agent-skills.ts` | **NEW** — agent skill loader, YAML frontmatter parser, role→agent mapper, caching |
| `packages/company-runtime/src/index.ts` | Added `getAgentSkills`, `getFullAgentPrompt`, `listAvailableAgents` exports |
| `apps/api/src/orchestrator.ts` | Added `getAgentSkills` import; injected `+ getAgentSkills(role)` at all 9 `runPromptText` call sites; enhanced developer UI standards block |
| `apps/api/src/ceo.ts` | Added `getAgentSkills` import; injected into CEO operating prompt |
| `packages/company-runtime/skills/agents/*.md` | **NEW** — 37 agent definition files copied from Contains Studio |

## Injection Points in orchestrator.ts

All places where `soul.systemPrompt` is passed to `runPromptText` now append `getAgentSkills(role)`:

1. **Sprint tester verification** (line ~1108) — tester gets test expertise during sprint review
2. **Specialist task execution** (line ~2763) — all roles get skills during autonomous task execution
3. **CTO plan generation** (line ~3545) — CTO gets architecture expertise when writing technical plans
4. **PM acceptance criteria** (line ~3664) — PM gets prioritization expertise when writing specs
5. **Developer build prompt** (line ~3976) — developer gets frontend + prototyping + backend expertise
6. **Developer rework prompt** (line ~4155) — developer gets skills during bug fix rework cycles
7. **CTO review** (line ~4537) — CTO gets skills during implementation review
8. **Beat task execution** (line ~5895) — all roles get skills during heartbeat-driven execution
9. **Checklist action execution** (line ~6084) — PM/CTO get skills during checklist-driven actions
10. **CTO plan decomposition** (line ~3846) — CTO gets skills when decomposing plans into dev steps

## Verification

- TypeScript: 0 errors across all modified files
- API server: starts cleanly, responds on `http://127.0.0.1:4000`
- Agent skills loader: reads .md files from `skills/agents/`, parses YAML frontmatter, caches prompts
- Token impact: each role gets ~1500 chars × N agents of additional system prompt context (3-6KB per role)

## Expected Impact

Next sprint execution should produce significantly higher quality output:
- Developer should scaffold with Vite+React+Tailwind (not bare HTML)
- Components should have proper styling, hover states, animations
- UI Designer should provide concrete Tailwind classes and color hex values
- Tester should write actual test files with proper coverage patterns
- CTO should produce implementation-ready specs with file structures
