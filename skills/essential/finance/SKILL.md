---
name: finance
description: Essential SaaS and product finance metrics for PMs. Use when evaluating features, pricing, go-to-market, or business health. Covers revenue, margin, CAC, LTV, churn, NRR, payback, and decision frameworks.
always: true
---

## Purpose

Finance metrics help PMs connect product decisions to business outcomes. Every feature, pricing change, or go-to-market investment should be evaluated through unit economics, margin, and cash efficiency.

**Core principle:** Metrics work in systems, not isolation. Always pair metrics (e.g., CAC with LTV, revenue with margin).

## Core Metrics

| Metric | Formula | Benchmark |
|--------|---------|-----------|
| **Revenue** | Total sales before expenses | Growth rate matters; connect every feature to revenue |
| **Gross Margin** | (Revenue - COGS) / Revenue × 100 | SaaS: 70-85% good; <60% concerning |
| **CAC** | S&M Spend / New Customers | Enterprise $10K+ ok; SMB <$500 |
| **LTV** | ARPU × Avg Lifetime (or complex model) | Must be 3x+ CAC |
| **Churn** | Customers Lost / Starting Customers | Monthly: <2% great, 5%+ crisis |
| **ARPU/ARPA** | MRR / Users or MRR / Accounts | Track trend; high ARPA + low ARPU = undermonetized |
| **ACV** | Annual recurring revenue per contract | Excludes one-time fees; normalizes deal size |
| **MRR/ARR** | MRR × 12 = ARR | Heartbeat of subscription; valued at 5-10x multiples |
| **Burn / Runway** | Cash spent - revenue; Cash / Burn | 12+ months good; <6 crisis |
| **LTV:CAC** | LTV / CAC | 3:1 healthy; <1:1 unsustainable |
| **Payback** | CAC / (Monthly ARPU × Gross Margin %) | <12 months great; >24 concerning |
| **NRR** | (Start ARR + Expansion - Churn - Contraction) / Start ARR | >120% excellent; <90% problem |
| **Contribution Margin** | (Revenue - All Variable Costs) / Revenue | 60-80% good; includes support, processing |
| **Rule of 40** | Growth % + Profit Margin % | >40 healthy; <25 concerning |
| **Magic Number** | (Q Rev - Prev Q Rev) × 4 / Prev Q S&M | >0.75 efficient; <0.5 fix before scaling |
| **Quick Ratio** | (New + Expansion MRR) / (Churn + Contraction) | >4 excellent; <2 leaky bucket |

## Decision Frameworks

### Should We Build This Feature?

1. **Revenue connection:** Direct (tier, add-on) or indirect (retention, conversion)?
2. **Cost structure:** Dev cost, COGS, support/OpEx
3. **ROI:** Revenue impact / Dev cost >3x (direct) or LTV impact >10x (retention)
4. **Strategic value:** Reduces CAC? Increases LTV? Reduces concentration?

**Build if:** ROI >3x year one OR LTV impact >10x dev cost OR high strategic value.  
**Don't build if:** Negative contribution margin, payback > customer lifetime.

### Should We Invest in This Channel?

1. **LTV:CAC** >3:1?
2. **Payback** <18 months?
3. **Cohort retention** meets or beats other channels?
4. **Magic Number** >0.75?

**Scale if:** All four. **Test if:** LTV:CAC 2-3:1 with improvement hypotheses. **Kill if:** LTV:CAC <1.5:1, no path to fix.

### Should We Scale GTM Spend?

**Scale if:** Magic Number >0.75, LTV:CAC >3:1, Quick Ratio >2, Payback <12mo, 12+ months runway.  
**Fix product first if:** Magic Number <0.5, NRR <100%, recent cohort churn >2x old, Quick Ratio <1.5.

### Should We Change Pricing?

**Increase prices if:** NRR >110%, churn <3%, underpriced vs. value.  
**Add tier if:** Clear segment willing to pay more, >20% likely to adopt.  
**Usage-based if:** Usage correlates with value, wide variance, can afford revenue variability.

## Red Flags

| Red Flag | Action |
|----------|--------|
| Churn increasing cohort-over-cohort | Stop scaling acquisition; fix retention |
| LTV:CAC <1.5 | Reduce CAC or increase LTV before scaling |
| Payback >18 months | Improve conversion, reduce CAC, or raise price |
| NRR <90% | Fix product value before acquisition |
| Magic Number <0.5 | Fix product, ICP, or sales process |
| Top customer >30% revenue | Diversify immediately |
| Gross margin <60% (SaaS) | Raise prices, reduce COGS |
| Quick Ratio <2 | Plug leaks before pouring in more |
| Refund rate >10% | Fix messaging, targeting, onboarding |

## Common PM Traps

1. **Optimizing wrong metric:** CAC looks great, LTV terrible → optimize LTV:CAC
2. **Vanity metrics:** Revenue up 50%, churn up 50% → net zero
3. **Blended metrics hide segments:** Half the business may be unprofitable
4. **Correlation ≠ causation:** Feature launched, revenue up → feature or seasonality?
5. **Ignoring cohorts:** Business may be degrading under stable blended metrics
6. **Premature scaling:** Low Magic Number + more spend = burn faster
7. **Underinvesting in retention:** Acquisition feels productive; retention invisible until crisis
8. **Treating revenue equally:** $1M from 1 customer ≠ $1M from 1,000
9. **Building for biggest customer:** Concentration risk + custom software, not product

## Metrics to Pair (Never Use Alone)

- **CAC** → **LTV** (LTV:CAC ratio)
- **Revenue growth** → **margin**, **burn**
- **Churn** → **cohort analysis**
- **MRR/ARR** → **NRR** (quality > quantity)
- **Gross margin** → **contribution margin**
- **Magic Number** → **CAC payback**

## Three Loops Mental Model

1. **Acquisition:** S&M → Leads → Customers → New MRR. Metrics: CAC, Magic Number, LTV:CAC.
2. **Retention & Expansion:** Product → Activation → Value → Expansion. Metrics: Churn, NRR, Quick Ratio.
3. **Profitability:** Revenue → Gross Profit → Contribution → Net Income. Metrics: Margin, Rule of 40.

**Healthy:** Loop 1 efficient, Loop 2 retains/expands, Loop 3 converts to profit.  
**Broken:** Inefficient acquisition OR leaking retention OR can't support growth.

## References

### Extended Content (this skill)

- **Full metrics with examples:** [references/metrics.md](references/metrics.md) — Revenue, margin, CAC, LTV, churn, NRR, payback, and 25+ metrics with PM decision scenarios
- **Quick reference table:** [references/quickref.md](references/quickref.md) — One-page lookup
- **Synthesis & decision frameworks:** [references/synthesis.md](references/synthesis.md) — Putting it together, red flag combinations, action plans

### Source Material

Condensed from `experiments/skill-creator/research/finance/`:
- Finance for Product Managers.md
- Finance_QuickRef.md
- Finance_For_PMs.Putting_It_Together_Synthesis.md
- Finance_Metrics_Additions_Reference.md

### Related Workspace Skills

For deeper dives: `finance-metrics-quickref`, `finance-based-pricing-advisor`, `feature-investment-advisor`, `acquisition-channel-advisor`, `business-health-diagnostic`, `saas-revenue-growth-metrics`, `saas-economics-efficiency-metrics`.
