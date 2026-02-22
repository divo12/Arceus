---
name: decide-support-skill
status: draft
review_required: true
created_at: 2026-02-22T06:46:45.640791+00:00
source: skill-gap-detection
---

# Draft Skill: decide-support-skill

## Why this draft exists
Missing capability in phase 'decide' seen 3 iterations.

## Problem context
PM Ideas Sweep: Search the web for product ideas, trends, and what-to-build-next.

This project: Given a Problem, the agent uses PM knowledge and skills to solve it and tell what to build next.

**Your skills:**
- **Web Search MCP** (if available): Use mcp_web_search_full-web-search, mcp_web_search_get-web-search-summaries, mcp_web_search_get-single-web-page-content for rich web research. Prefer these when present.
- **Open skills** (skills/open_skills/): Use web_search, searx_search (free SearXNG fallback), web_fetch. If web_search returns 422 or "not configured", use searx_search instead.
- **Support agent**: Call query_support_agent when you need "where to learn more" or "what's missing in our workspace skills" or "what tools could help our PM". The support agent has workspace PM skills context and will point you to relevant skills and gaps.

**Search for:**
- Product ideas for AI PM agents
- Trends in product management tools
- What to build next (product discovery, prioritization, roadmapping)
- Features that would improve problem-to-build workflows

**Then create PM_IDEAS.md** with:
1. Gaps: What's not in our workspace_skills that we should add
2. Tools: What tools we could implement to help the PM agent
3. Learning: Where to learn more (from support agent)
4. Todo list: Actionable items with checkboxes (- [ ])

Format: markdown with header and date. Use write_file to save PM_IDEAS.md.


## Proposed procedure
1. Clarify the missing objective and expected output.
2. Define inputs required from context, tools, and stakeholders.
3. Provide repeatable steps with checkpoints and quality gates.
4. Define evidence and validation criteria.

## Evidence snippets
[
  {
    "run_id": "89c13caf-eee9-4993-b8cf-f6af3f644ef2",
    "iteration": 2,
    "timestamp": "2026-02-22T06:46:40.904834+00:00",
    "response": {
      "content": "",
      "confidence": 0.6,
      "done": false,
      "rationale": "finish_reason=tool_calls"
    },
    "tool_results": [
      {
        "tool": "write_file",
        "arguments": {
          "path": "PM_IDEAS.md",
          "content": "# PM Ideas Sweep \u2014 2026-02-21\n\n> Goal: Identify product ideas, trends, and \u201cwhat to build next\u201d improvements for an AI PM agent that goes from **Problem \u2192 Evidence \u2192 Options \u2192 Decision \u2192 Plan**.\n\n## Web research status (important)\n- `web_search` is failing with **HTTP 422**.\n- `searx_search` is failing with **\u201cAll SearXNG instances failed (rate limited or unavailable)\u201d**.\n- Web Search MCP tools (`mcp_web_search_*`) are erroring with **\u201cunhashable type: 'list'\u201d**.\n- `web_fetch` works for direct URLs, but search-result pages (DuckDuckGo HTML) are not reliably extractable via readability (and sometimes return 202 challenges).\n\nSo this sweep is based on **support-agent guidance + internal gap analysis**. First TODO is to restore web research.\n\n---\n\n## 1) Gaps: what\u2019s not in `skills/workspace_skills/` that we should add\n\n### Highest-leverage missing skills\n1. **North Star + OKRs / outcomes management**\n   - Outcomes \u2192 leading indicators \u2192 KPI trees; connect strategy \u2192 roadmap.\n2. **Customer research synthesis**\n   - Turn interviews/notes into themes, insights, opportunity sizing, decision-ready artifacts.\n3. **Experiment design + A/B testing**\n   - Hypothesis \u2192 metrics \u2192 test plan \u2192 analysis/decision (beyond PoL probes).\n4. **Analytics instrumentation + event taxonomy**\n   - What to track, event/property definitions, dashboards, data quality.\n5. **Competitive analysis / market landscape**\n   - Competitor teardown, differentiation map; beyond positioning statement.\n6. **Go-to-market planning**\n   - Launch planning, packaging, enablement, adoption loops; beyond acquisition channel evaluation.\n7. **Stakeholder alignment & decision logs**\n   - RACI/DRI, comms plans, tradeoff docs, decision records.\n8. **Risk/compliance/security review for product (esp. AI)**\n   - Privacy, safety, governance, regulatory constraints.\n9. **Roadmap portfolio capacity planning**\n   - Resourcing, dependency mapping, scenario planning.\n10. **Post-launch evaluation**\n   - Impact review, retros, kill/iterate/scale rubric.\n\n---\n\n## 2) Tools: what we could implement to help the PM agent\n\n### Top 5 tools/capabilities for \u201cProblem \u2192 What to build next\u201d\n1. **Unified intake + normalization layer**\n   - Capture problems from tickets/interviews/sales calls; dedupe; cluster; map to personas/JTBD.\n2. **Evidence & traceability store**\n   - Link every problem/opportunity to sources (quotes, metrics, revenue impact) + confidence.\n3. **Opportunity scoring engine**\n   - Configurable scoring (RICE/WSJF/ROI + confidence) \u2192 ranked \u201cwhat next\u201d list.\n4. **Experiment planner + learning loop**\n   - Auto-generate PoL/experiment plans, success metrics, and decision rules (scale/test/kill).\n5. **Roadmap & PRD generator with constraints**\n   - Convert top opportunities into epics/stories/PRDs with sequencing, dependencies, and release slices.\n\n### Additional high-ROI tools (next)\n- **Metrics & tracking-plan generator**: KPI tree + event taxonomy + dashboard requirements from PRD/OST.\n- **Competitive intel workspace**: competitor matrix templates + update cadence.\n- **Roadmap simulator**: capacity-aware scenario planning + stakeholder-ready narratives.\n\n---\n\n## 3) Learning: where to learn more (from support agent)\n\n### Best existing end-to-end flow (reuse these skills)\n1. **Problem framing**\n   - `skills/workspace_skills/problem-framing-canvas/SKILL.md`\n   - `skills/workspace_skills/problem-statement/SKILL.md`\n2. **Discovery**\n   - `skills/workspace_skills/discovery-process/SKILL.md`\n   - `skills/workspace_skills/discovery-interview-prep/SKILL.md`\n   - `skills/workspace_skills/jobs-to-be-done/SKILL.md`\n   - `skills/workspace_skills/proto-persona/SKILL.md`\n3. **Map opportunities \u2192 solutions**\n   - `skills/workspace_skills/opportunity-solution-tree/SKILL.md`\n   - (optional narrative alignment) `skills/workspace_skills/storyboard/SKILL.md`\n4. **Validate cheaply**\n   - `skills/workspace_skills/pol-probe-advisor/SKILL.md`\n   - `skills/workspace_skills/pol-probe/SKILL.md`\n   - `skills/workspace_skills/lean-ux-canvas/SKILL.md`\n5. **Prioritize + investment decision**\n   - `skills/workspace_skills/prioritization-advisor/SKILL.md`\n   - `skills/workspace_skills/feature-investment-advisor/SKILL.md`\n6. **Define what to build**\n   - `skills/workspace_skills/epic-hypothesis/SKILL.md`\n   - `skills/workspace_skills/prd-development/SKILL.md`\n   - `skills/workspace_skills/user-story-mapping/SKILL.md` / `skills/workspace_skills/user-story-mapping-workshop/SKILL.md`\n   - `skills/workspace_skills/user-story-splitting/SKILL.md` + `skills/workspace_skills/user-story/SKILL.md`\n7. **Plan delivery**\n   - `skills/workspace_skills/roadmap-planning/SKILL.md`\n8. **Strategy/positioning (as needed)**\n   - `skills/workspace_skills/product-strategy-session/SKILL.md`\n   - `skills/workspace_skills/positioning-workshop/SKILL.md` + `skills/workspace_skills/positioning-statement/SKILL.md`\n   - `skills/workspace_skills/tam-sam-som-calculator/SKILL.md`, `skills/workspace_skills/pestel-analysis/SKILL.md`\n9. **Business viability checks (as needed)**\n   - `skills/workspace_skills/saas-revenue-growth-metrics/SKILL.md`\n   - `skills/workspace_skills/saas-economics-efficiency-metrics/SKILL.md`\n   - `skills/workspace_skills/finance-metrics-quickref/SKILL.md`\n   - `skills/workspace_skills/business-health-diagnostic/SKILL.md`\n\n---\n\n## 4) Todo list\n\n- [ ] Fix Web Search MCP error: investigate why `mcp_web_search_*` throws **\u201cunhashable type: 'list'\u201d** (likely tool wrapper bug / parameter typing).\n- [ ] Restore web research fallback: make `searx_search` robust via multi-instance probing/rotation (per `web-search-api` skill).\n- [ ] Add workspace skill: **north-star-okrs-outcomes** (outcomes \u2192 KPI tree \u2192 roadmap linkage).\n- [ ] Add workspace skill: **research-synthesis-insight-repo** (themes, confidence, opportunity sizing).\n- [ ] Add workspace skill: **experiment-design-readout** (A/B + quasi; guardrails; decision rules).\n- [ ] Add workspace skill: **analytics-instrumentation-event-taxonomy** (events/properties, dashboards, data quality).\n- [ ] Add workspace skill: **competitive-analysis-differentiation** (competitor matrix, wedge thesis, pricing/packaging).\n- [ ] Add workspace skill: **gtm-launch-plan** (packaging, enablement, adoption loops).\n- [ ] Add workspace skill: **stakeholder-alignment-decision-records** (tradeoff memo + RACI/DRI + decision log).\n- [ ] Add workspace skill: **ai-risk-compliance-review** (privacy/safety/governance checklist).\n- [ ] Build tool: **unified intake + clustering** (start with CSV import + dedupe + tagging).\n- [ ] Build tool: **evidence store + traceability graph** (problem \u2192 decision).\n- [ ] Build tool: **opportunity scoring engine** (RICE/WSJF/ROI + confidence).\n- [ ] Build tool: **experiment planner + learning repository** (hypotheses, results, decisions).\n- [ ] Build tool: **roadmap/PRD generator with constraints** (dependencies, sequencing, release slices).\n"
        },
        "result": "Successfully wrote 6912 bytes to PM_IDEAS.md"
      }
    ],
    "decision": {
      "priority": "medium",
      "next_actions": [
        "understand: gather web evidence before final recommendation",
        "understand: run web-search",
        "validate: run web-search",
        "decide: proceed with generic PM analysis",
        "plan: proceed with generic PM analysis"
      ],
      "decision": "Proceed with phased discovery-to-delivery plan",
      "objective_focus": [
        "Clarify problem, impact, and desired outcome"
      ],
      "confidence": 0.55,
      "requires_web_evidence": true,
      "has_context": false
    },
    "reflection": {
      "confidence": 0.55,
      "requires_web_evidence": true,
      "web_evidence_count": 3,
      "unmet_phases": [
        "decide",
        "plan"
      ],
      "learning": "Need more evidence and capabilities before final commitment.",
      "next_iteration_focus": "Acquire supporting evidence",
      "action_result_summary": "",
      "risk_count": 0,
      "objective_count": 1
    }
  },
  {
    "run_id": "89c13caf-eee9-4993-b8cf-f6af3f644ef2",
    "iteration": 3,
    "timestamp": "2026-02-22T06:46:45.612470+00:00",
    "response": {
      "content": "Saved an updated **`PM_IDEAS.md`** (dated **2026-02-21**) with the required sections:\n\n1) **Gaps**: top missing workspace skills (OKRs/outcomes, research synthesis, experiment design, instrumentation/event taxonomy, competitive teardown, GTM, decision logs, AI risk/compliance, capacity planning, post-launch evaluation).  \n2) **Tools**: top 5 capabilities to build (unified intake+clustering, evidence store, opportunity scoring, experiment planner+learning loop, roadmap/PRD generator with constraints) plus a few next-bets.  \n3) **Learning**: best existing end-to-end flow using current workspace skills (from framing \u2192 discovery \u2192 OST \u2192 validation \u2192 prioritization \u2192 PRD/stories \u2192 roadmap).  \n4) **Todo list**: actionable checkboxes, including fixing the MCP search error and restoring web research fallback.\n\nAlso documented current web research blockers (422, SearXNG failures, MCP \u201cunhashable type: 'list'\u201d, DDG extraction issues).",
      "confidence": 0.8,
      "done": true,
      "rationale": "finish_reason=stop"
    },
    "tool_results": [],
    "decision": {
      "priority": "medium",
      "next_actions": [
        "understand: gather web evidence before final recommendation",
        "understand: run web-search",
        "validate: run web-search",
        "decide: proceed with generic PM analysis",
        "plan: proceed with generic PM analysis"
      ],
      "decision": "Proceed with phased discovery-to-delivery plan",
      "objective_focus": [
        "Clarify problem, impact, and desired outcome"
      ],
      "confidence": 0.55,
      "requires_web_evidence": true,
      "has_context": false
    },
    "reflection": {
      "confidence": 0.55,
      "requires_web_evidence": true,
      "web_evidence_count": 3,
      "unmet_phases": [
        "decide",
        "plan"
      ],
      "learning": "Need more evidence and capabilities before final commitment.",
      "next_iteration_focus": "Acquire supporting evidence",
      "action_result_summary": "",
      "risk_count": 0,
      "objective_count": 1
    }
  }
]

## Human review checklist
- [ ] Validate this capability is repeatedly required
- [ ] Confirm no existing built-in/workspace skill already covers it
- [ ] Refine the procedure and examples
- [ ] Move from `_drafts` to `workspace_skills/<name>/SKILL.md` when approved