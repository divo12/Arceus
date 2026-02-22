# New Ideas — Arceus (Cursor for Product Managers)

**Date:** 2026-02-23 (IST)

This sweep focuses on strengthening Arceus’s core loop **Problem → Evidence → Options → Decision → Plan**, with an emphasis on *trust/traceability*, *decision memory/governance*, and *change propagation* (dependency graph for product decisions).

---

## 1) New ideas surfaced (agent + subagents)

### A. Foundational “Decision OS” ideas (high leverage)
1. **Evidence/Traceability Graph (Decision Memory)**
   - Build a minimal graph that links: *Problem* → *Evidence items* → *Options* → *Decision* → *Plan artifacts*.
   - Output surfaces: cited recommendations, confidence, and “why this” explanations.
   - Why: improves trust, repeatability, and reduces re-litigating decisions each quarter.

2. **Decision Record (DR) generator + revisit triggers**
   - Generate a lightweight DR/ADR-style artifact: *context, decision, alternatives, rationale, risks, metrics, revisit triggers*.
   - Add “what new evidence would change this decision?” as a first-class field.

3. **Change propagation across artifacts (Product dependency graph)**
   - When a requirement/metric/constraint changes, Arceus identifies impacted artifacts (PRD sections, tickets, launch checklist, comms) and proposes coordinated diffs.
   - Differentiated wedge beyond drafting.

4. **Canonical artifact set for the loop (composable outputs)**
   - Standardize 4 small outputs that can be embedded anywhere:
     1) **Evidence Brief** (what we know + confidence + gaps)
     2) **Options Set** (≥3) with tradeoffs
     3) **Decision Record** (why this, why now, why not others)
     4) **Execution Plan** (scope slices, risks, metrics, rollout, comms)

### B. Distribution wedge ideas (stakeholder pull)
5. **Team-wide decision artifact generator (async alignment)**
   - Optimize for stakeholder consumption: briefs, PRDs, decision logs, exec updates.
   - Measure success by **stakeholder pull** (views/comments/forwards), not only PM satisfaction.

6. **“One-link” shareable recommendation packet**
   - A single shareable page: summary, top recommendation, evidence citations, options comparison, decision record draft.

### C. Workflow acceleration ideas (execution readiness)
7. **Spec → execution translation pack**
   - PRD → story map → MVP slice → acceptance criteria → sprint-ready tickets.

8. **Opportunity scoring with sensitivity analysis**
   - RICE/WSJF scoring plus “if confidence is low, ranking changes like this” to avoid false precision.

### D. Safety / enterprise viability ideas
9. **Data control boundary UI (local-only, redaction, retention)**
   - Make confidentiality controls explicit; unlocks enterprise trials.

---

## 2) Gaps in `workspace_skills` to add

The workspace already covers **problem framing, discovery, PRD writing** well; gaps are strongest in the middle/end of the loop: **evidence quality, option comparison, decision hygiene, execution planning/rollout**.

Proposed new skills (10–15):

1. **evidence-brief** — produce an Evidence Brief with confidence, coverage, contradictions, and open questions.
2. **evidence-quality-rubric** — score evidence (freshness, representativeness, source reliability, bias).
3. **evidence-dedup-and-tagging** — cluster/merge evidence items; generate canonical tags.
4. **options-set-generator** — generate ≥3 options with constraints, tradeoffs, and second-order effects.
5. **tradeoff-matrix** — structured comparison across dimensions (value, effort, risk, time-to-learn).
6. **decision-record** — DR/ADR-style artifact with revisit triggers.
7. **decision-hygiene-check** — detect common failure modes (anchoring, HiPPO override, missing alternatives).
8. **assumption-mapping** — map assumptions → risks → validation plan.
9. **experiment-design** — pick experiment type, define success metrics, guardrails.
10. **rollout-and-risk-plan** — phased rollout, comms, monitoring, rollback.
11. **metrics-instrumentation-plan** — event taxonomy + dashboards needed to measure outcome.
12. **stakeholder-update** — exec-ready narrative (context, decision, impact, asks).
13. **change-impact-analysis** — given a change, list impacted artifacts + propose diffs.
14. **post-decision-review** — after shipping, compare expected vs actual; update decision memory.
15. **backlog-governance** — keep a canonical backlog; separate initiatives vs skills content.

---

## 3) Tools / capabilities to implement (repo-level)

1. **Evidence store + schema (trust & audit oriented)**
   - Start MVP with repo-consistent persistence (JSON under `data/state/`), then evolve to SQLite.
   - Add **idempotency keys** `(source_system, source_id, source_version/hash)` to prevent duplicates.
   - Add **deterministic chunking** + `parser_version/chunker_version` to avoid silent retrieval drift.

2. **Provenance DAG + claim ledger**
   - Model provenance as: `raw_artifact → extracted_text → chunks → embeddings → citations`.
   - Add a lightweight `claims.json` ledger: `{claim, evidence_chunk_ids, confidence}` so evidence becomes decisionable.

3. **Traceability graph builder (as a contract)**
   - Opinionated minimal graph: *Problem → Evidence → Options → Decision → PlanItem*.
   - **Contract rule:** every PlanItem must declare (a) which Decision it implements and (b) which success metric it moves.
   - Enables drift detection: “plan item with no decision”, “decision with no metric”.

4. **Artifact generator CLI**
   - `uv run python scripts/arceus_artifacts.py --kind decision_record --input <...>`
   - Produces markdown artifacts into `docs/` or `pm_ideas/`.

5. **Shareable packet renderer**
   - Convert the recommendation packet to a single markdown/HTML page for stakeholder sharing.

6. **Change propagation engine (MVP)**
   - Detect diffs in key fields (requirements/metrics/constraints) and list impacted artifacts + suggested diffs.

7. **Two-lane RICE scoring helper + portfolio overlay**
   - Two lanes: (A) Tools/Capabilities, (B) Skills Content.
   - Add portfolio balance buckets: Reliability/Quality, New Capability, Cost/Latency, Content/Enablement (e.g., 40/30/20/10 per cycle).
   - Add override lens: Risk/Compliance + Reversibility.

8. **Integration “fake doors”**
   - Lightweight prototypes for Jira/Linear/Notion/Docs export to validate adoption demand.

---

## 4) Actionable TODO list

### Discovery / validation (1 week)
- [ ] Run PoL: **Evidence traceability A/B** (cited vs uncited) and measure “I’d act on this”.
- [ ] Run PoL for **distribution wedge**: share 5 recommendation packets; measure stakeholder pull (views/comments/forwards).
- [ ] Run PoL for **opportunity scoring**: compare Arceus ranking vs team baseline in 3 sessions.

### Build (MVP, 2–3 weeks)
- [ ] Implement **evidence item schema + store** (start with JSON under `data/state/`; migrate to SQLite if needed).
- [ ] Implement **provenance DAG** fields + `claims.json` ledger.
- [ ] Implement **traceability links** (problem↔evidence↔decision↔plan) and citation rendering in outputs.
- [ ] Add a new workspace skill: **decision-record** (DR with revisit triggers).
- [ ] Add a new workspace skill: **options-set-generator** (≥3 options + tradeoffs).
- [ ] Add a new workspace skill: **evidence-brief** (confidence + gaps).

### Hardening (next)
- [ ] Add **decision hygiene check** (bias + missing alternatives detection).
- [ ] Add **change impact analysis** skill + minimal change propagation (list impacted artifacts).
- [ ] Add **data controls** (redaction/retention toggles) as a prerequisite for enterprise trials.

---

## Evidence notes (web + subagents)

- Atlassian Rovo explicitly positions “Product requirements expert” and PRD generation/review as a use case, reinforcing that PRD drafting is table stakes; differentiation likely comes from **cross-artifact consistency + traceability + automation**.
  - https://www.atlassian.com/software/rovo/use-cases/agent-product-requirements-expert
  - https://support.atlassian.com/rovo/kb/rovo-capabilities-and-features-for-atlassian-cloud/
