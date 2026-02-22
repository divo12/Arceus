# New Ideas — Arceus (Cursor for Product Managers)

**Date:** 2026-02-23 (IST)

Arceus is “Cursor for PMs”: a PM agent that recommends what to build next via **Problem → Evidence → Options → Decision → Plan**.

This sweep converges on a defensible wedge: **Decision Packets** — an audit-ready decision log + evidence + versioning + shareable packet (with manifest) that survives cross-functional handoffs.

---

## 1) New ideas surfaced (agent + subagents)

### A. Wedge: Decision Packets (Decision Intelligence layer)

1. **Decision Packets as the core product primitive**
   - From messy inputs → **evidence-backed options** → **final decision** → **shareable packet**.
   - Differentiation: not doc drafting; **defensibility** (citations, assumptions, confidence, “what would change this”).

2. **Audit-ready decision log (enterprise pull)**
   - Treat decision logging like an **approval audit trail**: append-only, attributable, reconstructable.
   - Capture: before/after state, justification, evidence pointers (hashes), approval chain.

3. **Packet manifest for verification (PDF + JSON)**
   - Ship a **machine-readable manifest** (hashes of included artifacts, decision IDs, timestamps, signer identities).
   - Differentiates from “export PDF” and enables verification.

4. **ADR-style immutability + supersedes**
   - Accepted decisions are versioned; updates create a new version that **supersedes** the prior one.
   - Proves traceability without a full dependency graph.

5. **Governance as a product wedge (view vs export plane)**
   - “Shareable packet mode” anchored in a threat model: leak deterrence + traceability + least-privilege.
   - Explicit **view plane vs export plane** (export disabled by default).

6. **Prioritization evidence layer (reduces churn)**
   - Capture *why* an item scored the way it did (metrics, quotes, incidents) so prioritization is auditable.

7. **Validation angle: cross-functional handoff quality**
   - PoL should test whether the packet survives PM → Eng → Security/Legal without rework.

---

## 2) Gaps in `workspace_skills` to add (top candidates)

1. **decision-packet-template** — canonical schema + sections.
2. **validation-planner** — next best learning step + evidence threshold.
3. **prioritization-sensitivity** — rank stability under uncertainty.
4. **wsjf-sequencing** — platform sequencing; RICE as cross-check.
5. **roadmap-change-control** — decision log required for roadmap changes.
6. **forecast-calibration-review** — predicted vs actual; update priors.
7. **governance-first-packet-review** — least-privilege review + redaction + export acceptance checklist.

Design principle: skills should be **templates + checklists + calculators** and emit a **Decision Log record** + **Assumption Register**.

---

## 3) Tools / capabilities to implement (repo-level)

### A. Decision Log + Evidence Graph (MVP)

Minimal primitives (avoid full knowledge graph):
- `Decision` (versioned)
- `DecisionAlternative` (counterfactuals)
- `Evidence` (append-only, immutable)
- `Edge` (typed links)
- *(Optional)* `Claim` (decisionable evidence)

Storage:
- Prefer **SQLite** for indexing + versioning + edge lookups.
- JSONL acceptable for ultra-fast iteration.

Indexes (MVP):
- `(run_id, iteration)`
- `(decision_type, created_at)`
- `(from_id, to_id)`

### B. Decision lifecycle + instrumentation

Canonical state machine:
- `draft → in_review → proposed → finalized → communicated/implemented`

Emit events:
- `decision_created`
- `decision_state_changed`
- `evidence_attached`
- `alternative_added`
- `dissent_logged`
- `decision_reopened`
- `packet_generated`
- `packet_viewed`
- `packet_exported`

Guardrail metric:
- **Decision Quality Index (DQI)**
  - `DQI = evidence_quality_score + stakeholder_diversity_score + dissent_captured_flag - reopen_penalty`

### C. Shareable Packet Mode (security primitives)

- Snapshot packet (recommended for MVP) with immutable content hash.
- Controls:
  - redaction overlay + redaction log
  - watermarking (recipient + timestamp + packet ID)
  - access scope + expiry
  - view vs export policy flags

### D. Enterprise permissions model (minimal but plausible)

- **RBAC + scoped ABAC + sensitivity labels**
- Roles (5): Viewer, Contributor, Approver, Admin, Auditor
- Scopes: Tenant/Org → Workspace → Case/Matter → Record
- Labels: Internal / Confidential / Restricted
- Dual-control for irreversible actions: publish/export/redaction approval
- Break-glass access: time-bound, logged, post-hoc review

### E. Reliability

- Persist subagent outputs to `sessions/` or `data/state/subagents/` to avoid “started but no results”.

---

## 4) Actionable TODO list (checkboxes)

### A. 2-week thin vertical slice (golden path demo)

- [ ] Create Decision Packet → attach 3 evidence snippets → generate 3 options → select decision → render packet → export.
- [ ] Implement `DEC-####` IDs + decision versioning (`supersedes_decision_id`).
- [ ] Implement evidence hashing + store minimal audit fields (actor/action/before-after hashes).
- [ ] Implement packet snapshot renderer (HTML first) + `manifest.json` + verification script.
- [ ] Seed a sample packet so demo works in a fresh repo.

### B. Governance-first PoL (handoff survival)

- [ ] Run 1 integrated handoff session: PM → Eng lead → Security/Legal on the same packet.
- [ ] Include: restricted evidence + redaction request + external export attempt.
- [ ] Track: time-to-first-useful output, # clarifications, grounding rate, actionability score, reopen rate, export accepted without rework.
- [ ] Ask stop-condition: “What would make you refuse/escalate/block this?”

### C. 6-week wedge demo target

- [ ] Build a SOC2/vendor-security-review scenario and run 3 PoL sessions.
- [ ] Goal: raw inputs → audit-ready decision log → immutable packet (PDF + manifest) in <10 minutes.

---

## Evidence notes (web)

- Approval audit trail best practices and required fields (Sirion, Jan 2026):
  - https://www.sirion.ai/de/library/contract-insights/approval-audit-trail-explained/


## Update — 2026-02-23 04:20 IST (Doc hygiene: make new_ideas.md append-only WAL)

### 1) Problem observed

- `new_ideas.md` behaves like a scratchpad with **no stable append-only contract** (no index, no boundary marker, no rotation rule), making it easy for agents/tools to overwrite and cause thrash.

### 2) Proposed structure (guardrails)

Treat `new_ideas.md` as a **Write-Ahead Log (WAL)** of “idea events”:
- **Capture** is append-only and immutable.
- **Curation** happens in a separate generated view (e.g., `ideas_current.md`).

Add explicit invariants inside the file:
- Fixed header (rarely edited): purpose + rules + small index.
- Hard boundary marker:
  - `<!-- DO NOT EDIT ABOVE / APPEND BELOW -->`
- Each entry is self-contained and timestamped.

### 3) Rotation / archiving policy

- Keep `new_ideas.md` as “current month WAL”.
- Archive older months to `pm_ideas/archive/new_ideas_YYYY-MM.md`.
- Keep diffs small by ensuring only the newest entry changes.

### 4) Minimal tooling changes to enforce

- Add a tiny script (e.g., `scripts/append_idea_entry.py`) that:
  - appends a new timestamped block at EOF,
  - optionally updates only a bounded index region,
  - and rotates/archives when month changes.

### 5) Actionable TODOs

- [ ] Add boundary marker + rules header to `new_ideas.md`.
- [ ] Add `scripts/append_idea_entry.py` (append-only writer).
- [ ] Add `scripts/build_ideas_current.py` to generate `ideas_current.md` from WAL.
- [ ] Add monthly archive folder + rotation rule.

## Update — 2026-02-22 21:10 UTC

No further work required. This feedback only confirms the append succeeded and doesn’t introduce any new angles or constraints to validate.
