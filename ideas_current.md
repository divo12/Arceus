# Ideas Current — Arceus (Cursor for Product Managers)

**Generated:** 2026-02-23 (IST)

This is a curated snapshot of the latest “what to build next” direction, distilled from `new_ideas.md`.

---

## 1) What to build next (single 2-week wedge)

### Decision
Build **Decision Packets MVP as a trust primitive**.

### Why
Primary buyer value: **defensible decisions under audit / incident review**.
This becomes the substrate for later wedges:
- diff/propagation (change → propagation → verification)
- outcome labeling/backtesting (closed-loop accuracy)
- portfolio optimization (constraints-first roadmap)

### Day-10 “done artifact”
- Exportable packet (HTML) + `manifest.json`
- Deterministic verification script
- Immutability/versioning (`supersedes`)
- Redaction boundary (view vs export plane; policy can be stubbed)

---

## 2) Validation plan (PoL)

### Scenario
SOC2 / vendor security review decision.

### Pass/fail rubric
- verifier recomputes digest successfully
- packet survives PM → Eng → Security handoff with minimal rework
- export attempt respects redaction boundary

### Must-ask stop condition
“What would make you refuse / escalate / block this?”

---

## 3) Reliability prerequisite

### Fix Azure 400 tool/tool_calls mismatch
Add `validate_and_repair_messages(messages)` to enforce:
- every `role:"tool"` has `tool_call_id`
- matching earlier assistant `tool_calls[].id` exists

Auto-repair: drop orphan tool messages (default).

---

## 4) Next wedges (post-MVP)

1) **Outcome Labeler + Backtester** (accuracy loop)
- backtest roadmap items vs baseline (PM gut/RICE)
- measure uplift + calibration (Brier score)

2) **Causal Driver Map** (retention/expansion)
- identify causal drivers of churn/NRR changes

3) **Portfolio Optimizer** (constraints-first roadmap)
- optimize a set of bets under capacity/deps/risk constraints

---

## 5) Actionable TODOs

- [ ] Lock Day-10 artifact definition (export + manifest + verify).
- [ ] Implement view vs export boundary (policy stub ok).
- [ ] Implement evidence hashing + manifest generator + verification script.
- [ ] Run 3-person handoff PoL and record failures.
- [ ] Implement message invariant validator to prevent Azure 400.
- [ ] Define Arceus “accuracy” metric (uplift vs baseline + calibration).
