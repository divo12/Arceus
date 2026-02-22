# 2-week MVP plan: Arceus “Decision OS”

## Goal
Ship a thin, end-to-end workflow that produces a **shareable decision packet**:
1) Evidence brief → 2) Options → 3) Decision record → 4) Shareable packet (link/export)

This MVP should validate the wedge: **decision traceability** and **change propagation** (at least within the packet, and optionally to 1 downstream integration).

## Target user / use case (MVP)
- **PM** preparing for a decision meeting (scope cut, pricing change, launch go/no-go, prioritization).
- Needs to quickly assemble evidence, present options, capture the decision, and share a clean artifact.

## Success criteria (2-week)
- Time-to-packet: median < 30 minutes from “start” to shareable packet.
- Adoption: 5+ real packets created by internal team or design partners.
- Decision capture: 80% of packets include (problem, evidence, options, decision, owner, date).
- Change propagation (MVP-level): editing the decision updates the packet and marks derived sections as “needs review”.

## MVP scope (what we will build)

### 1) Evidence Brief (structured)
**User story:** As a PM, I can create an evidence brief with key facts so stakeholders trust the decision.

**Fields (minimum):**
- Problem statement (1–3 sentences)
- Goal / success metric
- Constraints (time, budget, tech)
- Evidence items (list): link + note + type (metric / customer / competitive / ops)

**AI assist (optional but valuable):**
- “Summarize these links/notes into 5 bullets” (works even if evidence is pasted text)

### 2) Options builder
**User story:** As a PM, I can list 2–5 options with tradeoffs.

**Fields:**
- Option name
- Description
- Pros / cons
- Risks
- Effort (t-shirt)
- Expected impact (qualitative)

**AI assist:**
- “Generate 3 options given the problem + constraints”
- “Fill pros/cons for each option”

### 3) Decision Record (system of record)
**User story:** As a team, we can capture the final decision and why.

**Fields:**
- Decision (selected option)
- Rationale (why this option)
- Owner / approver(s)
- Date
- Confidence level
- Follow-ups (action items)

**Design note (wedge):** model this like ADRs: once “Accepted”, treat as immutable; changes create a new version that supersedes the old one.

Evidence (ADR immutability + superseding):
- https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html

### 4) Shareable packet
**User story:** As a PM, I can share a single artifact that includes evidence, options, and the decision.

**Deliverables:**
- Read-only link (internal)
- Export to Markdown/PDF (choose 1 for MVP; Markdown is fastest)

### 5) Change propagation (MVP-level)
**User story:** When I change the decision or an option, the packet stays consistent.

**MVP behavior:**
- Packet sections derived from structured fields are regenerated automatically.
- If user edits generated narrative text, mark it as “customized”; subsequent changes show a “needs review” badge + diff preview.

### 6) Minimal “Decision Library”
**User story:** As a PM, I can find past decisions.

**MVP behavior:**
- List view of decision records (title, date, owner, tags)
- Search by keyword

## Explicitly out of scope (2-week)
- Full Jira/Linear bi-directional sync
- Multi-workspace permissions/SSO
- Complex evidence ingestion (automatic web scraping, transcript parsing)
- Full dependency graph across many artifacts

## 2-week execution plan

### Week 1: End-to-end creation flow
1. Data model + schema for Evidence/Options/Decision
2. Basic UI/CLI flow to create a packet
3. Packet renderer (Markdown) + share link
4. Basic search/list for decision records

### Week 2: Quality + propagation
1. AI assist prompts (options + pros/cons + summary)
2. Change propagation inside packet (regen + needs-review + diff)
3. Instrumentation: time-to-packet, completion rate, edits
4. Dogfood with 3–5 real decisions; iterate on schema friction

## Key risks + mitigations
- **Risk:** Becomes “another doc tool.”
  - Mitigation: enforce structured decision record + propagation semantics.
- **Risk:** AI output low quality.
  - Mitigation: keep AI optional; require explicit evidence links; show citations in packet.
- **Risk:** Too much scope.
  - Mitigation: single export format; single downstream integration only if time remains.

## Next validation probes (parallel to build)
- Run 5 discovery interviews focused on “decision changed → what broke?”
- Ask 3 design partners to create one packet each; measure time + missing fields.
