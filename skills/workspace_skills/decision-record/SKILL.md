---
name: decision-record
description: Generate a lightweight Decision Record (DR/ADR-style) with context, decision, alternatives, rationale, risks, metrics, and revisit triggers. Use when documenting a product or technical decision, creating an ADR, or when the user asks "what would change this decision?"
type: component
---

## Purpose

Produce a **Decision Record** that captures *why* a decision was made, *what alternatives were considered*, and **what new evidence would change this decision** (revisit triggers). Use this to reduce re-litigation, improve trust, and make decisions auditable.

## Key concepts

### DR structure (required fields)

| Section | Purpose |
|--------|---------|
| **Context** | What situation prompted this decision? |
| **Decision** | What we decided (one clear statement). |
| **Alternatives considered** | ≥2 options we rejected and why. |
| **Rationale** | Why this option, why now. |
| **Risks** | What could go wrong; mitigations. |
| **Metrics** | How we'll measure success. |
| **Revisit triggers** | What new evidence would change this decision? (first-class) |

### Revisit triggers (critical)

Answer: *"What would make us revisit or reverse this decision?"*

Examples:
- "If activation rate does not improve by 20% within 60 days, we revisit."
- "If 3+ enterprise customers request SSO in the next quarter, we prioritize."
- "If competitor X ships feature Y with >50% adoption, we reassess."

## Application

### Step 1: Gather inputs

- Problem statement or PRD context
- Options considered (use `options-set-generator` if needed)
- Evidence cited (use `evidence-brief` if needed)

### Step 2: Fill the template

```markdown
# Decision Record: [Title]

**ID:** DEC-YYYYMMDD-NNN  
**Date:** YYYY-MM-DD  
**Owner:** [Name/team]  
**Status:** Proposed | Accepted | Superseded

## Context

[What situation prompted this decision? 2–3 sentences.]

## Decision

[One clear statement: "We will [do X] because [reason]."]

## Alternatives considered

| Option | Why not chosen |
|--------|----------------|
| A | [Reason] |
| B | [Reason] |

## Rationale

[Why this option, why now. Link to evidence if available.]

## Risks

- [Risk 1]: [Mitigation]
- [Risk 2]: [Mitigation]

## Metrics

- **Primary:** [Metric] — target [X] by [date]
- **Guardrails:** [What should NOT get worse]

## Revisit triggers

**What new evidence would change this decision?**

- [ ] [Trigger 1: e.g. "If metric X does not reach Y by date Z"]
- [ ] [Trigger 2: e.g. "If N customers request feature F"]
- [ ] [Trigger 3: e.g. "If competitor ships X with adoption >Y%"]
```

### Step 3: Cite evidence

Every rationale and risk should cite evidence IDs (e.g. `EVD-xxx`) when available. Use the evidence store for traceability.

## When to use

- Documenting a product or technical decision
- Creating an ADR (Architecture Decision Record)
- User asks "what would change this decision?"
- Before committing to a major initiative

## When not to use

- Exploratory brainstorming (use options-set-generator first)
- Evidence synthesis only (use evidence-brief)
- Full PRD (use prd-development)

## References

- `options-set-generator` — generate ≥3 options before writing the DR
- `evidence-brief` — confidence + gaps for cited evidence
- `packet-export-spec` — DR entries feed into shareable packets
