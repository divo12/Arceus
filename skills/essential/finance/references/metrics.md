# Finance Metrics — Detailed Reference

Condensed from experiments/skill-creator/research/finance. Full examples and quizzes in source files.

---

## Revenue

**Formula:** Total sales before expenses (top line).

**Why PMs care:** Every feature should connect to revenue—direct (tier, add-on) or indirect (retention, conversion). Quantify impact even when indirect.

**Common mistakes:** Confusing revenue with profit; ignoring indirect impact; celebrating vanity metrics; forgetting denominator (growth vs. headcount).

**When to use:** Evaluating business health, prioritizing features with monetization paths, company goals. Don't use for profitability (use margin) or capital efficiency (use LTV:CAC).

---

## Gross Margin

**Formula:** (Revenue - COGS) / Revenue × 100. COGS = hosting, infra, payment processing, onboarding.

**Why PMs care:** $1M revenue at 80% margin > $1M at 30% margin. Features with expensive infra (video, AI, real-time) dilute margin.

**Common mistakes:** Ignoring margin dilution; forgetting infra costs scale with usage; not pricing for margin.

**When to use:** Evaluating new product lines, feature profitability, pricing tiers. Don't use in isolation without CAC, LTV.

---

## CAC (Customer Acquisition Cost)

**Formula:** Total S&M Spend / New Customers.

**Why PMs care:** Shapes go-to-market. High-CAC channels (enterprise sales) require high LTV. Evaluate marketing proposals, pricing, segment viability.

**Common mistakes:** Comparing CAC across channels without LTV context; ignoring payback period; blended vs. channel CAC; low CAC with poor quality.

**When to use:** Evaluating channels, GTM efficiency, sales structure. Always pair with LTV (LTV:CAC ratio).

---

## LTV (Lifetime Value)

**Formula:** ARPU × Avg Lifetime (simplified). Sophisticated: expansion, margin, discount rate.

**Why PMs care:** What you can afford to spend (CAC). Which segments are valuable. Retention ROI: +20% lifetime often > +20% acquisition.

**Common mistakes:** LTV without churn; ignoring expansion; forgetting gross margin; using averages across segments.

**When to use:** Segment value, affordable CAC, retention vs. acquisition priority. Don't use without CAC.

---

## Churn Rate

**Formula:** Customers Lost / Total Customers at Start. 5% monthly churn ≈ 46% annual.

**Why PMs care:** Silent killer of SaaS. Leaky bucket undermines acquisition. Prioritize retention features.

**Common mistakes:** Treating all churn equally (weight by revenue); ignoring cohort trends; confusing monthly vs. annual.

**When to use:** Product-market fit, retention features, LTV calculation. Don't use for short-term tactics.

---

## ARPU / ARPA

**ARPU:** Revenue / Total Users. **ARPA:** MRR / Active Accounts.

**Why PMs care:** Revenue growth = more customers OR more per customer. ARPU improvements often have better unit economics (no CAC).

**Common mistakes:** Confusing ARPU with ARPA (B2B multi-seat); celebrating mix shift; ignoring margin.

**When to use:** Pricing changes, upsell effectiveness, segment comparison. Don't use for usage-based pricing alone.

---

## ACV (Annual Contract Value)

**Formula:** Annualized recurring revenue per contract. Excludes one-time fees. Multi-year: total / years.

**Why PMs care:** $36K 3-year deal and $12K annual = same $12K ACV. Prevents celebrating "huge enterprise" that's just long duration.

**Common mistakes:** Confusing ACV with TCV; including one-time fees; not considering contract length.

**When to use:** Sales comp, deal economics, forecasting. Don't use for cash flow (use TCV).

---

## MRR / ARR

**Formula:** MRR × 12 = ARR. Predictable recurring revenue.

**Why PMs care:** $100K ARR valued at 5-10x ($500K-$1M+). One-time $100K = $100K. Shapes deal structures, product strategy.

**Common mistakes:** Including non-recurring in ARR; confusing bookings with ARR; ignoring ARR quality.

**When to use:** Company health, growth targets, valuation. Don't use for profitability.

---

## Burn Rate / Runway

**Formula:** Burn = Monthly spend - revenue. Runway = Cash / Burn.

**Why PMs care:** Determines what you can build. Every feature has cost; shrinks runway.

**Common mistakes:** Ignoring runway when planning; gross vs. net burn; revenue growth without checking burn.

**When to use:** Roadmap planning, feature scope, hiring, fundraising. Don't use for feature value in isolation.

---

## LTV:CAC Ratio

**Formula:** LTV / CAC. 3:1 often considered healthy.

**Why PMs care:** Core efficiency metric. Is growth sustainable or buying revenue at a loss?

**Common mistakes:** Ignoring payback period; segment differences; celebrating underinvestment.

**When to use:** Channel efficiency, scale decisions, business model sustainability. Don't use without payback.

---

## Payback Period

**Formula:** CAC / (Monthly ARPU × Gross Margin %). Months to recover CAC.

**Why PMs care:** Cash efficiency. 24-month payback with 18-month lifetime = lose money per customer.

**Common mistakes:** Using revenue instead of margin; not segmenting; ignoring annual prepay impact.

**When to use:** Pricing models (monthly vs. annual), channel efficiency, segment priority. Don't use without LTV.

---

## NRR (Net Revenue Retention)

**Formula:** (Start ARR + Expansion - Churn - Contraction) / Start ARR.

**Why PMs care:** NRR >100% = grow without new logos. 120%+ = premium valuation.

**Common mistakes:** Celebrating NRR from price increases vs. real expansion; ignoring cohort NRR; not breaking into components.

**When to use:** Product-market fit, expansion potential, growth strategy. Don't use for new products without history.

---

## Contribution Margin

**Formula:** (Revenue - All Variable Costs) / Revenue. Includes support, processing, variable costs.

**Why PMs care:** Gross margin can hide unprofitable products. 80% gross + high support = lower contribution.

**Common mistakes:** Confusing with gross margin; ignoring product/segment variance; not allocating variable costs.

**When to use:** True product profitability, pricing, unit economics. Don't use for fixed costs.

---

## Expansion Revenue

**Formula:** Upsells + cross-sells + usage growth from existing customers.

**Why PMs care:** Most capital-efficient revenue (no CAC). Drives NRR >100%.

**Common mistakes:** Treating like new revenue; not building expansion paths; celebrating catch-up.

**When to use:** Upsell features, packaging, customer success. Don't use without considering initial pricing.

---

## Rule of 40

**Formula:** Growth Rate % + Profit Margin %. >40 = healthy.

**Why PMs care:** Framework for growth vs. efficiency trade-offs. Acceptable to burn if growing fast; acceptable to grow slowly if profitable.

**Common mistakes:** Treating as hard law; gaming with unsustainable tactics; ignoring stage.

**When to use:** Business health, growth vs. efficiency, investor communication. Don't use for product decisions directly.

---

## Other Key Metrics

- **Gross vs. Net Revenue:** Net = Gross - Discounts - Refunds. Refunds >10% = red flag.
- **Revenue Concentration:** Top customer <10%; Top 10 <40% ideal.
- **Magic Number:** (Q Rev - Prev Q Rev) × 4 / Prev Q S&M. >0.75 efficient.
- **Quick Ratio:** (New + Expansion MRR) / (Churn + Contraction). >4 excellent; <2 leaky.
- **Unit Economics:** Revenue per unit - Cost per unit. Must be positive.
- **Cohort Analysis:** Group by join date; track behavior. Blended metrics hide trends.
- **CAC Payback by Channel:** Segment by acquisition source. Not all channels equal.
- **Gross Margin Payback:** CAC / (Monthly Price × Gross Margin %). More accurate than simple payback.

---

**Source:** experiments/skill-creator/research/finance/ (Finance for Product Managers.md, Finance_QuickRef.md, Finance_For_PMs.Putting_It_Together_Synthesis.md, Finance_Metrics_Additions_Reference.md)
