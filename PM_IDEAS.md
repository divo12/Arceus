# PM Ideas Sweep — 2026-02-21

> Goal: Identify product ideas, trends, and “what to build next” improvements for an AI PM agent that goes from **Problem → Evidence → Options → Decision → Plan**.

## Web research status (important)
- `web_search` is failing with **HTTP 422**.
- `searx_search` is failing with **“All SearXNG instances failed (rate limited or unavailable)”**.
- Web Search MCP tools (`mcp_web_search_*`) are erroring with **“unhashable type: 'list'”**.

So this sweep is based on **support-agent guidance + internal gap analysis + subagent synthesis**. TODO #1 is to restore web research.

---

## 0) North Star framing (validated new angle)

Treat the AI PM agent as a **closed-loop decision system** (not a doc generator): optimize **decision latency** and **decision quality** under uncertainty.

Make **auditability** the differentiator: every recommendation should be **traceable** to evidence, with explicit confidence and revisit triggers.

First-class artifact across all workflows: **Assumption & Decision Register** (belief, confidence, evidence, how we’ll learn, expiry/revisit trigger).

---

## 1) Gaps: what’s not in `skills/workspace_skills/` that we should add

### Two spines to connect outputs to outcomes
- **Measurement spine:** KPI tree → tracking plan → dashboard → experiment readouts.
- **Portfolio spine:** prioritization → roadmap → dependency/risk → launch/rollback.

### Missing skills (prioritized) + what to reuse
1. **Prioritization & roadmap (capacity-aware)** — RICE/WSJF/CoD, sequencing, trade-offs, roadmap governance.
   - Reuse: `opportunity-solution-tree`, `business-health-diagnostic`, `finance-metrics-quickref`, `tam-sam-som-calculator`.
2. **North Star + KPI design / metric tree** — NSM, input/output metrics, guardrails, metric dictionary & targets.
   - Reuse: `finance-metrics-quickref`, `business-health-diagnostic`, `problem-statement`.
3. **Experimentation & causal evaluation** — hypothesis→experiment design (A/B + quasi), success criteria, readouts.
   - Reuse: `epic-hypothesis`, `discovery-process`.
4. **Instrumentation & analytics spec** — event taxonomy, tracking plan, properties, data QA, dashboard spec.
   - Reuse: `prd-development`, `user-story-splitting`.
5. **Stakeholder alignment & decisioning** — stakeholder map, RACI/DRI, decision log/DRs, escalation paths.
   - Reuse: `workshop-facilitation`, `positioning-statement`, `problem-framing-canvas`.
6. **Go-to-market & launch planning** — launch tiers, readiness checklist, comms/enablement, pricing hooks.
   - Reuse: `acquisition-channel-advisor`, `finance-based-pricing-advisor`, `positioning-statement`, `company-research`.
7. **Delivery planning & dependency/risk mgmt** — milestones, dependency map, RAID log, rollout/rollback.
   - Reuse: `user-story-splitting`, `prd-development`.
8. **Customer feedback ops (VoC synthesis)** — intake→tagging→synthesis→link to opportunities.
   - Reuse: `discovery-interview-prep`, `discovery-process`, `opportunity-solution-tree`.
9. **Competitive/market intel (repeatable)** — teardown template, differentiation map, pricing scan cadence.
   - Reuse: `company-research`, `positioning-statement`, `pestel-analysis`.
10. **Quality/reliability & post-launch learning** — pre-mortem, SLO/SLI-lite, incident learnings→backlog, retros.
   - Reuse: `workshop-facilitation`, `business-health-diagnostic`.

---

## 2) Tools: what we could implement to help the PM agent

### JTBD-driven “golden path” (what the agent should output)
Top 5 end-to-end JTBD (each ends in a reviewable artifact):
1. **Ambiguous input → validated problem + success metrics** (problem statement, persona/context, baseline+target, guardrails, non-goals)
2. **Prioritize next bet with evidence + constraints** (ranked options, tradeoffs, scenarios by capacity/time)
3. **Decision → PRD/spec → sprint-ready tickets** (stories, AC, edge cases, NFRs, rollout)
4. **De-risk via experiments** (experiment plan + pre-registered thresholds + readout)
5. **Launch → measure → iterate** (launch checklist, instrumentation verified, monitoring, iteration backlog)

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
- **Product Truth Layer**: canonical graph (initiative ↔ epics ↔ PRs ↔ launches ↔ metrics) + drift detection + approval workflows.
- **Metrics & tracking-plan generator**: KPI tree + event taxonomy + dashboard requirements from PRD/OST.
- **PRD/Epic linter**: completeness checks (non-goals, edge cases, metrics, rollout), ambiguity flags, “ask 5 clarifying questions”.
- **Roadmap simulator**: capacity-aware scenario planning + stakeholder-ready narratives.

---

## 3) Trends (2024–2026): capability shifts → workflow impact → build implication

> Synthesized from subagent research + internal analysis (add more citations once web research is restored).

Macro trend: PM tooling is converging on an **“AI-powered Product OS”**: unify customer signals + strategy + delivery artifacts, with AI doing clustering, drafting, and comms.

Key differentiator emerging: **decision accountability** (not just writing speed) — can the tool show *what evidence* drove a roadmap decision, track assumptions, and close the loop to outcomes.

1. **Copilots → agents (action-taking across tools)** → multi-step PM ops can be delegated → workflow agents with human approval steps + rollback.
2. **Embedded/in-context AI** → PM work happens inside Jira/Linear/docs → inline actions + diff/preview + one-click apply.
3. **Source-grounded outputs (citations/provenance)** → stakeholders demand “show your work” → citations, confidence, freshness controls.
4. **AI governance becomes core (enterprise)** → adoption hinges on admin controls + data guarantees → RBAC, audit logs, PII redaction, retention policies.
5. **Multimodal inputs** → meetings/slides/whiteboards become primary inputs → meeting-to-artifacts pipeline.
6. **Continuous discovery automation** → feedback clustering becomes table stakes → opportunity inbox with weighting + evidence links.
7. **Outcome-driven roadmapping** → roadmaps tie to measurable outcomes → initiative↔metric linkage + impact narratives.
8. **Spec quality tooling** → demand for consistent specs → PRD/epic linting + org templates.
9. **Defensible prioritization** → rationale + scenarios matter → tradeoff memos + what-if sliders.
10. **Interoperability as moat** → unify systems of record → connectors + unified object model + sync.

---

## 4) Product ideas (what to build next) — evidence-first backlog

> New angle validated: treat the product as an **auditability layer** for PM work (governance + provenance), not just AI generation.

1. **PM Decision Record (PDR) system (ADR-for-product)**
   - What: decision logs (context, options, tradeoffs, decision, owner, date, links to evidence) + “decision diff” when assumptions change.
   - Refs: Microsoft ADR guidance https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-records/ ; AWS ADR process https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html ; ADR templates https://github.com/joelparkerhenderson/architecture-decision-record

2. **Evidence-backed Insight Repository (“claim → evidence graph”)**
   - What: store insights as claims with attached snippets (calls, tickets, surveys), confidence, recency, segment; agent answers cite evidence nodes.
   - Refs: Dovetail https://dovetail.com/ ; Atlassian research library lessons https://uxinsight.org/managing-what-we-know-lessons-from-the-atlassian-research-library-think-tank/

3. **Continuous Discovery Agent (Opportunity–Solution Tree copilot)**
   - What: maintains OSTs, suggests next interviews, maps learnings to opportunities, flags weakly-supported branches.
   - Refs: OST explainer https://www.hustlebadger.com/what-do-product-teams-do/how-to-build-an-opportunity-solution-tree/ ; Teresa Torres on assumption testing https://www.producttalk.org/assumption-testing/

4. **Experimentation Orchestrator (hypothesis → design → ship → readout)**
   - What: drafts hypotheses, metrics, sample-size guidance, rollout plan (feature flag), then generates readouts + recommendations.
   - Refs: experimentation ecosystem example https://www.statsig.com/comparison/alternatives-to-launchdarkly-for-experimentation

5. **North Star & Metric Tree Builder + anomaly explainer**
   - What: builds metric trees, links metrics to events, monitors anomalies, generates likely drivers with evidence.

6. **PRD-to-Execution “Spec Diff” agent**
   - What: watches PRD/design/tickets/PRs; highlights drift (scope creep, missing AC, unaddressed edge cases).
   - Ref: landscape mention https://huryn.medium.com/introducing-aigents-pm-free-ai-agents-for-product-managers-bba6ad2a931d

7. **Meeting-to-Artifacts pipeline (auto decisions, actions, risks)**
   - What: from transcript → updates decision log, creates Jira/Linear tickets, updates roadmap notes, pings owners.

8. **Competitive Intel Agent (monitor → summarize → impact)**
   - What: tracks competitor sites/changelogs/pricing/job posts; summarizes changes and maps to positioning + backlog impact.
   - Refs: Crayon https://www.crayon.co/ ; Klue https://klue.com/ ; Kompyte https://www.kompyte.com/

9. **Agentic Product Ops knowledge router (search + permissions)**
   - What: unified search across docs/tickets/chats with permission-aware answers; proposes doc updates when stale.
   - Ref: Glean https://www.glean.com/

10. **Evals harness for PM agents (quality gates)**
   - What: automated evals for agent outputs: citation coverage, freshness, policy compliance, decision correctness on historical cases.
   - Refs: OpenAI Evals https://github.com/openai/evals ; OpenAI cookbook evals intro https://developers.openai.com/cookbook/examples/evaluation/getting_started_with_openai_evals/

11. **Assumption Register + “assumption drift” monitor**
   - What: tracks key assumptions with owners and expiry; alerts when new evidence contradicts them.

12. **Roadmap Integrity Agent (dependency + capacity + risk)**
   - What: checks roadmap feasibility vs capacity/dependencies/cycle times; flags unrealistic commitments.

13. **Portfolio-level “Strategy-to-Work” alignment auditor**
   - What: maps initiatives → outcomes → metrics → shipped work; flags weak linkage and suggests cuts/re-scopes.

14. **Exec-ready roadmap memo generator + pushback handling** (org alignment risk)
   - What: produces stakeholder-ready narrative (why now, tradeoffs, sequencing, risks) and suggests responses to common pushback.

---

## 5) Learning: where to learn more (from support agent)

### Best existing end-to-end flow (reuse these skills)
1. **Problem framing**: `problem-framing-canvas`, `problem-statement`
2. **Discovery**: `discovery-process`, `discovery-interview-prep`, `jobs-to-be-done`, `proto-persona`
3. **Opportunities → solutions**: `opportunity-solution-tree`, `lean-ux-canvas`
4. **Validate cheaply**: `pol-probe-advisor`, `pol-probe`
5. **Prioritize/invest**: `prioritization-advisor`, `feature-investment-advisor`
6. **Define**: `epic-hypothesis`, `prd-development`, `user-story-mapping`, `user-story-splitting`, `user-story`
7. **Plan delivery**: `roadmap-planning`

---

## 6) Todo list

### Restore web research
- [ ] Fix Web Search MCP error: investigate why `mcp_web_search_*` throws **“unhashable type: 'list'”** (likely tool wrapper bug / parameter typing).
- [ ] Fix `web_search` 422 (configure provider keys / request format).
- [ ] Make `searx_search` robust via multi-instance probing/rotation (per `web-search-api` skill).

### Add missing skills (workspace_skills)
- [ ] **prioritization-roadmap-capacity-aware**
- [ ] **north-star-okrs-outcomes**
- [ ] **research-synthesis-insight-repo**
- [ ] **experiment-design-readout**
- [ ] **analytics-instrumentation-event-taxonomy**
- [ ] **stakeholder-alignment-decision-records**
- [ ] **gtm-launch-plan**
- [ ] **delivery-dependency-risk-mgmt**
- [ ] **competitive-analysis-differentiation**
- [ ] **quality-reliability-post-launch-learning**

### Build tools (agents/tools)
- [ ] Implement **Assumption & Decision Register** (PDR/ADR-for-product) + decision diff.
- [ ] Implement **Evidence store** (citations, confidence, freshness).
- [ ] Implement **Opportunity scoring engine** (RICE/WSJF/ROI + confidence + sensitivity).
- [ ] Implement **PRD/Epic linter** (org templates + missing sections + ambiguity flags).
- [ ] Implement **Experiment planner + learning repository** (hypotheses, results, decisions).
- [ ] Implement **Product Truth Layer** (canonical graph + drift detection + approvals).
