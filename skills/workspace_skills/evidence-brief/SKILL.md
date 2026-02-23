---
name: evidence-brief
description: Produce an Evidence Brief with confidence, coverage, contradictions, and open questions. Use when synthesizing research, assessing evidence quality, or before making a decision.
type: component
---

## Purpose

Produce an **Evidence Brief** that summarizes what we know, how confident we are, where evidence conflicts, and what gaps remain. Use this to improve trust, avoid false precision, and identify when more research is needed.

## Key concepts

### Evidence Brief structure

| Section | Purpose |
|--------|---------|
| **What we know** | Key findings with source citations |
| **Confidence** | Per-finding or overall (High/Medium/Low) |
| **Coverage** | What areas are well-covered vs thin |
| **Contradictions** | Where evidence conflicts |
| **Open questions** | Gaps that would change the decision |

### Confidence levels

- **High:** Multiple independent sources agree; recent; representative sample
- **Medium:** Some support; may be dated or limited sample
- **Low:** Single source; anecdotal; or conflicting

## Application

### Step 1: Gather evidence

- User research, analytics, support tickets
- Web search results, documents
- Evidence store items (EVD-xxx) when available

### Step 2: Fill the template

```markdown
# Evidence Brief: [Topic/Decision]

**Date:** YYYY-MM-DD  
**Scope:** [What this brief covers]

## What we know

| Finding | Sources | Confidence |
|---------|---------|------------|
| [Finding 1] | [EVD-xxx, interview 3] | High |
| [Finding 2] | [Analytics, support] | Medium |
| [Finding 3] | [Single source] | Low |

## Coverage

- **Well-covered:** [Areas with strong evidence]
- **Thin:** [Areas with weak or no evidence]
- **Missing:** [Critical gaps]

## Contradictions

- [Where evidence conflicts and how to interpret]

## Open questions

**What would change our decision if we knew?**

- [ ] [Question 1]
- [ ] [Question 2]

## Recommendation

[Proceed / Need more research / Proceed with caveats]
```

### Step 3: Cite sources

Use evidence IDs (EVD-xxx) and URIs. Link to evidence store for traceability.

## When to use

- Synthesizing research before a decision
- User asks "what do we know about X?"
- Assessing evidence quality
- Before writing Decision Record or Options Set

## When not to use

- Raw data dump (synthesize first)
- Single-source summary (expand sources)
- Full PRD (use prd-development)

## References

- Evidence store: `data/state/evidence_store.json` — idempotent evidence items
- `decision-record` — Evidence Brief feeds rationale
- `options-set-generator` — Evidence Brief informs constraints
