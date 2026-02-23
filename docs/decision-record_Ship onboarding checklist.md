# Decision Record: Ship onboarding checklist

**ID:** DEC-20260223-001
**Date:** 2026-02-23
**Owner:** 
**Status:** Proposed

## Context

60% of trial users drop off in the first 24 hours due to lack of guidance. Support tickets show 'How do I get started?' is the #1 question.

## Decision

We will add a 3-step guided onboarding checklist that appears on first login.

## Alternatives considered

| Option | Why not chosen |
|--------|----------------|
| Video tutorial | Higher effort to produce; lower completion rate for video content. |
| Do nothing | Drop-off continues; churn OKR at risk. |

## Rationale

Minimal friction, measurable (completion rate), and aligns with activation OKR.

## Risks

- **Users dismiss immediately**: Track dismissal rate; A/B test messaging.
- **Checklist feels generic**: Start with primary persona; personalize later.

## Metrics

- **Primary:** Activation rate — target 60% (from 40%) by Q2
- **Guardrails:** Sign-up conversion rate must not drop

## Revisit triggers

**What new evidence would change this decision?**

- [ ] If activation rate does not improve by 20% within 60 days
- [ ] If dismissal rate exceeds 50%
- [ ] If 3+ enterprise customers request SSO instead
