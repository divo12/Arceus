

## Update — 2026-02-23 03:30 IST (Instrumentation: Time-to-Verify + Stakeholder Pull)

### 1) New ideas surfaced

- Anchor analytics on two north stars:
  1) **Time-to-Verify (TTV)**: recommendation shown → stakeholder reaches “verified” state.
  2) **Stakeholder Pull**: stakeholders seek/share/re-use outputs (not just consume).

- Instrument **verification effort**, not just time:
  - Add `verification_blocker_reported` (missing data, unclear rationale, conflicting sources).
  - This distinguishes “citations speed things up” vs “citations add friction but increase correctness,” and becomes a roadmap signal for evidence UX.

### 2) Tools/capabilities to implement

**Canonical event taxonomy (minimum viable)**
- `recommendation_shown`
- `evidence_opened`
- `decision_log_opened`
- `packet_generated`
- `packet_opened`
- `packet_forwarded`
- `packet_commented`
- `verification_blocker_reported` (with reason enum)
- `verified` (explicit user action)

**Derived metrics**
- `TTV_p50/p90` = time(`verified`) - time(`recommendation_shown`)
- `Verification effort rate` = % sessions with `verification_blocker_reported`
- `Stakeholder pull rate` = % packets with `packet_forwarded` or `packet_commented`

### 3) Actionable TODOs

- [ ] Define “verified” UX (button / checkbox / status) so TTV is measurable.
- [ ] Add blocker reason enums: `missing_evidence`, `unclear_rationale`, `conflicting_sources`, `permissions_blocked`.
- [ ] Create a simple dashboard: TTV, pull rate, blocker rate (weekly).
- [ ] A/B: cited vs uncited recommendation packets; compare TTV + blocker rate + pull rate.


## Update — 2026-02-23 03:30 IST (Consolidated “what to build next” recommendation)

### 1) New ideas surfaced (synthesis)

**North Star wedge:** **Audit-ready Decision Log + Shareable Packet Mode**
- Differentiation: not “write PRDs,” but **defensible decisions** with provenance, governance, and exportable evidence packs.
- Strong pull from non-PM stakeholders (Security/Legal/Audit) if we support redaction, chain-of-custody, and verification.

### 2) Gaps in `workspace_skills` to add (top 5)

- **validation-planner** (next best learning step + evidence threshold)
- **prioritization-sensitivity** (rank stability under uncertainty)
- **roadmap-change-control** (decision log required)
- **forecast-calibration-review** (predicted vs actual)
- **wsjf-sequencing** (platform sequencing)

### 3) Tools/capabilities to implement (top 5)

1. **Decision lifecycle state machine + events** (`decision_state_changed`)
2. **Decision Log store** (append-only, versioned decisions, alternatives)
3. **Evidence hashing + optional hash-chain**
4. **Packet generator** (snapshot PDF + `manifest.json`)
5. **Permissions model** (RBAC + scopes + labels + dual-control; view vs export plane)

### 4) Actionable TODO list (next 2 weeks)

**Build thin vertical slice (wedge demo)**
- [ ] Create decision → attach evidence → add alternative → finalize → generate packet (PDF + manifest) in <10 minutes.
- [ ] Implement `DEC-####` IDs + decision state machine + event emission.
- [ ] Implement evidence hashing + store minimal audit fields (actor/action/before-after hashes).
- [ ] Implement packet snapshot + manifest hashing + verification script.

**Validate (PoL, governance-first)**
- [ ] Run 3 PoL sessions using a SOC2/vendor-security-review scenario.
- [ ] Include restricted evidence + redaction request + external export attempt.
- [ ] Track: packet generation time, completeness (% with evidence), reopen rate, export accepted without rework, stakeholder pull.

## Update — 2026-02-22 20:29 UTC

No action required. This feedback only confirms the append succeeded and doesn’t add any new angles or constraints to validate.
