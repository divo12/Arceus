---
name: options-set-generator
description: Generate ≥3 options with constraints, tradeoffs, and second-order effects. Use when comparing alternatives, evaluating choices, or before writing a Decision Record.
type: component
---

## Purpose

Produce an **Options Set** of ≥3 viable alternatives with explicit tradeoffs, constraints, and second-order effects. Use this to avoid anchoring on the first idea, surface hidden tradeoffs, and prepare for a Decision Record.

## Key concepts

### Options Set structure

| Element | Purpose |
|--------|---------|
| **Options** | ≥3 distinct alternatives (not just "do nothing" vs "do something") |
| **Constraints** | What each option must satisfy (time, cost, risk) |
| **Tradeoffs** | What you gain vs give up with each option |
| **Second-order effects** | Unintended consequences, downstream impacts |

### Tradeoff matrix (recommended)

Compare options across dimensions:

| Dimension | Option A | Option B | Option C |
|-----------|----------|----------|----------|
| Value | High | Medium | Low |
| Effort | Low | Medium | High |
| Risk | Medium | Low | High |
| Time-to-learn | 2 weeks | 4 weeks | 8 weeks |

## Application

### Step 1: Define the decision space

- What are we deciding? (e.g. "How to improve onboarding activation")
- What constraints apply? (timeline, budget, team capacity)
- What success looks like (primary metric)

### Step 2: Generate ≥3 options

Each option must be:
- **Actionable** — we could actually do it
- **Distinct** — meaningfully different from others
- **Comparable** — same decision space

Avoid:
- False dichotomy (only 2 options)
- Straw-man options (obviously bad)
- "Do nothing" as the only alternative

### Step 3: Build tradeoff matrix

```markdown
# Options Set: [Decision Title]

**Context:** [1–2 sentences]

## Options

### Option A: [Name]
- **Summary:** [One sentence]
- **Constraints:** [What it requires]
- **Tradeoffs:** Gain X, give up Y
- **Second-order effects:** [Unintended impacts]

### Option B: [Name]
- **Summary:** [One sentence]
- **Constraints:** [What it requires]
- **Tradeoffs:** Gain X, give up Y
- **Second-order effects:** [Unintended impacts]

### Option C: [Name]
- **Summary:** [One sentence]
- **Constraints:** [What it requires]
- **Tradeoffs:** Gain X, give up Y
- **Second-order effects:** [Unintended impacts]

## Tradeoff matrix

| Dimension | Option A | Option B | Option C |
|-----------|----------|----------|----------|
| Value | | | |
| Effort | | | |
| Risk | | | |
| Time-to-learn | | | |

## Recommendation (if ready)

[Which option and why. Otherwise: "Requires Decision Record."]
```

### Step 4: Link to evidence

Cite evidence IDs for constraints and tradeoffs when available.

## When to use

- Comparing alternatives before a decision
- User asks "what are our options?"
- Before writing a Decision Record
- Avoiding anchoring on first idea

## When not to use

- Single obvious choice (skip to Decision Record)
- Pure brainstorming (no structure needed yet)
- Evidence synthesis only (use evidence-brief)

## References

- `decision-record` — use options set as input
- `tradeoff-matrix` — structured comparison (when added)
- `evidence-brief` — support tradeoffs with evidence
