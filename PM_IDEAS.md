# PM Ideas Sweep — 2026-02-21

> Goal: Identify product ideas, trends, and “what to build next” improvements for an AI PM agent that goes from **Problem → Evidence → Options → Decision → Plan**.

## Web research status (important)
- `web_search` is failing with **HTTP 422**.
- `searx_search` is failing with **“All SearXNG instances failed (rate limited or unavailable)”**.
- Web Search MCP tools (`mcp_web_search_*`) are erroring with **“unhashable type: 'list'”**.
- `web_fetch` works for direct URLs, but search-result pages (DuckDuckGo HTML) are not reliably extractable via readability (and sometimes return 202 challenges).

So this sweep is based on **support-agent guidance + internal gap analysis**. First TODO is to restore web research.

---

## 1) Gaps: what’s not in `skills/workspace_skills/` that we should add

### Highest-leverage missing skills
1. **North Star + OKRs / outcomes management**
   - Outcomes → leading indicators → KPI trees; connect strategy → roadmap.
2. **Customer research synthesis**
   - Turn interviews/notes into themes, insights, opportunity sizing, decision-ready artifacts.
3. **Experiment design + A/B testing**
   - Hypothesis → metrics → test plan → analysis/decision (beyond PoL probes).
4. **Analytics instrumentation + event taxonomy**
   - What to track, event/property definitions, dashboards, data quality.
5. **Competitive analysis / market landscape**
   - Competitor teardown, differentiation map; beyond positioning statement.
6. **Go-to-market planning**
   - Launch planning, packaging, enablement, adoption loops; beyond acquisition channel evaluation.
7. **Stakeholder alignment & decision logs**
   - RACI/DRI, comms plans, tradeoff docs, decision records.
8. **Risk/compliance/security review for product (esp. AI)**
   - Privacy, safety, governance, regulatory constraints.
9. **Roadmap portfolio capacity planning**
   - Resourcing, dependency mapping, scenario planning.
10. **Post-launch evaluation**
   - Impact review, retros, kill/iterate/scale rubric.

---

## 2) Tools: what we could implement to help the PM agent

### Top 5 tools/capabilities for “Problem → What to build next”
1. **Unified intake + normalization layer**
   - Capture problems from tickets/interviews/sales calls; dedupe; cluster; map to personas/JTBD.
2. **Evidence & traceability store**
   - Link every problem/opportunity to sources (quotes, metrics, revenue impact) + confidence.
3. **Opportunity scoring engine**
   - Configurable scoring (RICE/WSJF/ROI + confidence) → ranked “what next” list.
4. **Experiment planner + learning loop**
   - Auto-generate PoL/experiment plans, success metrics, and decision rules (scale/test/kill).
5. **Roadmap & PRD generator with constraints**
   - Convert top opportunities into epics/stories/PRDs with sequencing, dependencies, and release slices.

### Additional high-ROI tools (next)
- **Metrics & tracking-plan generator**: KPI tree + event taxonomy + dashboard requirements from PRD/OST.
- **Competitive intel workspace**: competitor matrix templates + update cadence.
- **Roadmap simulator**: capacity-aware scenario planning + stakeholder-ready narratives.

---

## 3) Learning: where to learn more (from support agent)

### Best existing end-to-end flow (reuse these skills)
1. **Problem framing**
   - `skills/workspace_skills/problem-framing-canvas/SKILL.md`
   - `skills/workspace_skills/problem-statement/SKILL.md`
2. **Discovery**
   - `skills/workspace_skills/discovery-process/SKILL.md`
   - `skills/workspace_skills/discovery-interview-prep/SKILL.md`
   - `skills/workspace_skills/jobs-to-be-done/SKILL.md`
   - `skills/workspace_skills/proto-persona/SKILL.md`
3. **Map opportunities → solutions**
   - `skills/workspace_skills/opportunity-solution-tree/SKILL.md`
   - (optional narrative alignment) `skills/workspace_skills/storyboard/SKILL.md`
4. **Validate cheaply**
   - `skills/workspace_skills/pol-probe-advisor/SKILL.md`
   - `skills/workspace_skills/pol-probe/SKILL.md`
   - `skills/workspace_skills/lean-ux-canvas/SKILL.md`
5. **Prioritize + investment decision**
   - `skills/workspace_skills/prioritization-advisor/SKILL.md`
   - `skills/workspace_skills/feature-investment-advisor/SKILL.md`
6. **Define what to build**
   - `skills/workspace_skills/epic-hypothesis/SKILL.md`
   - `skills/workspace_skills/prd-development/SKILL.md`
   - `skills/workspace_skills/user-story-mapping/SKILL.md` / `skills/workspace_skills/user-story-mapping-workshop/SKILL.md`
   - `skills/workspace_skills/user-story-splitting/SKILL.md` + `skills/workspace_skills/user-story/SKILL.md`
7. **Plan delivery**
   - `skills/workspace_skills/roadmap-planning/SKILL.md`
8. **Strategy/positioning (as needed)**
   - `skills/workspace_skills/product-strategy-session/SKILL.md`
   - `skills/workspace_skills/positioning-workshop/SKILL.md` + `skills/workspace_skills/positioning-statement/SKILL.md`
   - `skills/workspace_skills/tam-sam-som-calculator/SKILL.md`, `skills/workspace_skills/pestel-analysis/SKILL.md`
9. **Business viability checks (as needed)**
   - `skills/workspace_skills/saas-revenue-growth-metrics/SKILL.md`
   - `skills/workspace_skills/saas-economics-efficiency-metrics/SKILL.md`
   - `skills/workspace_skills/finance-metrics-quickref/SKILL.md`
   - `skills/workspace_skills/business-health-diagnostic/SKILL.md`

---

## 4) Todo list

- [ ] Fix Web Search MCP error: investigate why `mcp_web_search_*` throws **“unhashable type: 'list'”** (likely tool wrapper bug / parameter typing).
- [ ] Restore web research fallback: make `searx_search` robust via multi-instance probing/rotation (per `web-search-api` skill).
- [ ] Add workspace skill: **north-star-okrs-outcomes** (outcomes → KPI tree → roadmap linkage).
- [ ] Add workspace skill: **research-synthesis-insight-repo** (themes, confidence, opportunity sizing).
- [ ] Add workspace skill: **experiment-design-readout** (A/B + quasi; guardrails; decision rules).
- [ ] Add workspace skill: **analytics-instrumentation-event-taxonomy** (events/properties, dashboards, data quality).
- [ ] Add workspace skill: **competitive-analysis-differentiation** (competitor matrix, wedge thesis, pricing/packaging).
- [ ] Add workspace skill: **gtm-launch-plan** (packaging, enablement, adoption loops).
- [ ] Add workspace skill: **stakeholder-alignment-decision-records** (tradeoff memo + RACI/DRI + decision log).
- [ ] Add workspace skill: **ai-risk-compliance-review** (privacy/safety/governance checklist).
- [ ] Build tool: **unified intake + clustering** (start with CSV import + dedupe + tagging).
- [ ] Build tool: **evidence store + traceability graph** (problem → decision).
- [ ] Build tool: **opportunity scoring engine** (RICE/WSJF/ROI + confidence).
- [ ] Build tool: **experiment planner + learning repository** (hypotheses, results, decisions).
- [ ] Build tool: **roadmap/PRD generator with constraints** (dependencies, sequencing, release slices).
