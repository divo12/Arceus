---
name: web-search
description: Use web_search/web_fetch to learn domain context and current problem facts before committing to decisions.
always: true
---

# Web Search

Use this skill to gather fresh external context when solving product problems.

## When To Use

- Domain is unfamiliar or changing quickly.
- You need market/competitor references.
- Problem framing depends on recent external signals (news, standards, benchmarks).
- You need evidence before recommending what to build.

## Primary Tools

- `web_search` for broad discovery and source finding.
- `web_fetch` for deep reading of selected sources.

## Workflow

1. Start with `web_search` using focused queries.
2. Pick high-signal sources (official docs, trusted industry sources, primary references).
3. Use `web_fetch` to extract details from top links.
4. Summarize findings with:
   - what changed,
   - why it matters to the current problem,
   - confidence level and source quality.

## Query Patterns

- `<domain> latest best practices`
- `<problem> benchmarks`
- `<competitor> pricing/features`
- `<regulation/standard> updates <region/year>`

## Guardrails

- Prefer factual synthesis over speculation.
- Cite source URLs in recommendations when possible.
- If web search is unavailable, state limitation and proceed with explicit assumptions.
