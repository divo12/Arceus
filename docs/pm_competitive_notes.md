# PM Competitive Notes — PRD is table-stakes; wedge = decision traceability + change propagation

**Date:** 2026-02-23 (IST)

## Why this doc
Validate that **PRD drafting / doc generation** is already broadly covered by incumbents, and identify a defensible wedge for Arceus.

Working hypothesis: **Drafting is table-stakes**; differentiation comes from:
1) **Traceability / decision records** (why we decided, with evidence)
2) **Change impact / propagation** across artifacts (what breaks when inputs change)

---

## Evidence: incumbents already cover “draft docs with AI”

### Confluence Decisions blueprint (Decision Log)
Confluence ships a **Decisions blueprint** that creates a decision page template and an index page that acts as a **Decision Log** for a space.

Source:
- https://confluence.atlassian.com/docm/latest/decisions-blueprint-953123877.html


### Atlassian Jira Product Discovery — AI to brainstorm, draft, transform, summarize
Atlassian’s AI in Jira Product Discovery supports:
- Brainstorming ideas
- Drafting and transforming content in idea descriptions/comments
- Summarizing content (notes → concise descriptions)

Source:
- https://support.atlassian.com/jira-product-discovery/docs/explore-atlassian-intelligence-in-jira-product-discovery/

**Implication:** “AI writes the PRD/idea description” is not a wedge.

### Productboard — AI doc generation (Productboard Spark)
Productboard has an AI feature (“Productboard Spark”, beta) positioned to generate product docs (briefs/requirements/launch artifacts) via conversational prompting.

Source:
- https://support.productboard.com/hc/en-us/articles/44571897288723-Beta-Productboard-Spark

**Implication:** AI-assisted doc generation is mainstream in PM tools.

---

## Evidence: “decision log / decision record” is known (templates + workflows)

### Aha! — decision log template
Aha! publishes a decision log template for tracking and communicating key decisions.

Source:
- https://www.aha.io/roadmapping/guide/templates/create/decision-log

### Confluence — decision documentation template
Atlassian provides a Confluence decision template (DACI-style) to document decisions and avoid re-litigating.

Source:
- https://www.atlassian.com/software/confluence/templates/decision

### Jira + Automation — decision log as workflow
A detailed write-up shows how teams implement a decision log inside Jira using Automation (templates, lifecycle columns, converting comments into decisions, reminders).

Source:
- https://medium.com/bethink-pl/decision-log-using-jira-and-automation-the-holy-grail-of-documenting-decisions-8d37ad3f1f2b

**Implication:** “having a place to write decisions” is not enough. The wedge must be *systemic*: evidence linkage, reuse, and propagation.

---

## Evidence: “traceability + impact analysis” exists — but mostly in requirements/ALM tools

### Jama Connect — Impact Analysis (upstream/downstream related items)
Jama Connect describes Impact Analysis as:
- A complete picture of upstream/downstream related items affected by changes
- Run on an item or change request
- With traceability, see how a change might impact other requirements/verifications

Source:
- https://help.jamasoftware.com/ah/en/manage-content/coverage-and-traceability/impact-analysis.html

### AWS Prescriptive Guidance — ADRs as an immutable decision log
AWS describes ADRs as a lifecycle-based process producing a decision log; accepted ADRs are immutable and superseded by new ADRs when decisions change.

Source:
- https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html

**Implication:** the “decision record” concept is mature in engineering; PM tooling hasn’t productized it with evidence + artifact propagation.

---

## Competitive landscape summary (what’s table-stakes vs. open)

### Table-stakes (widely available)
- AI-assisted drafting: PRDs/briefs/idea descriptions, summaries, tone rewrites (Atlassian, Productboard, etc.)
- Basic decision templates / logs (Aha!, Confluence templates; Jira workflows)
- Centralized idea/feedback capture + prioritization + roadmaps (all incumbents)

### Partially served (exists, but not PM-native)
- Requirements traceability + impact analysis (Jama Connect; ALM class)
- Engineering ADR discipline (AWS guidance; ADR GitHub repos)

### Likely open wedge for Arceus
1) **Decision traceability (Decision OS)**
   - Link **Problem → Evidence → Options → Decision → Plan** as a first-class graph.
   - Output: a shareable packet where every recommendation is *cited* and every plan item points back to a decision + success metric.

2) **Decision record hygiene (revisit triggers)**
   - DR/ADR-style record with: context, alternatives, rationale, risks, metrics, and “what new evidence would change this?”

3) **Change propagation across PM artifacts**
   - When a constraint/metric/requirement changes, Arceus proposes coordinated diffs across:
     - PRD sections
     - tickets
     - launch checklist
     - stakeholder comms
   - This is analogous to ALM impact analysis, but applied to **product decisions + artifacts**, not only requirements.

---

## Positioning angle (draft)
**Arceus is not a PRD generator.**
It’s a **Decision OS** that makes product decisions:
- evidence-backed,
- option-aware,
- auditable,
- and resilient to change.

---

## Open questions / validation to run next
1) Do PMs feel pain from “decision re-litigation” and “lost rationale” enough to switch tools?
2) What is the minimum viable traceability graph that feels useful (without heavy process overhead)?
3) Which integrations matter most for change propagation (Jira/Linear/Notion/Confluence)?
4) What proof artifact convinces stakeholders (execs/eng/design) that this is better than AI doc drafting?
