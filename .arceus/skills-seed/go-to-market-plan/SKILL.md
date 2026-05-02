---
name: go-to-market-plan
description: Delivers 3 ranked, actionable go-to-market strategies tailored to the company's current stage, product, and market.
role: ceo
trigger: CEO needs to launch a product, enter a market, or build a customer acquisition strategy from scratch
---

# Go-to-Market Plan

## Purpose
Analyze the founder's business and current stage to deliver 3 specific, actionable go-to-market strategies that will drive measurable market penetration and customer acquisition.

---

## Execution Logic

**Check $ARGUMENTS first to determine execution mode:**

### If $ARGUMENTS is empty or not provided:
Respond with:
"go-to-market-plan loaded, proceed with details about your product, target market, or current launch situation"

Then wait for the user to provide their requirements in the next message.

### If $ARGUMENTS contains content:
Proceed immediately to Task Execution (skip the "loaded" message).

---

## Task Execution

When user requirements are available (either from initial $ARGUMENTS or follow-up message):

### 1. Diagnose GTM Readiness
Evaluate whether you have enough information to produce high-confidence, actionable go-to-market strategies:

**Required information to proceed without questions:**
- What problem the product solves (core value proposition)
- Who the ideal customer is (specific ICP, not "small businesses" or "everyone")
- Product readiness stage (MVP, beta, ready to scale, etc.)
- Competitive landscape (who else solves this, how you're different)
- Distribution model (direct, channel partners, marketplace, etc.)
- Pricing strategy (freemium, paid, enterprise, etc.)
- Current market position (pre-launch, launched but struggling, ready to scale)
- Available resources (team, budget, runway)

**If you have enough context:** Proceed directly to Step 4.

**If critical information is missing:** Proceed to Step 3.

### 3. Ask Diagnostic Questions (When Needed)
Use the AskUserQuestion tool to gather missing information. Ask between 3-10 questions based on what's needed:

**Core GTM questions:**
- What stage is your product at right now? (Idea, MVP, beta, launched, scaling)
- Who is your ideal first customer? (Be specific: role, company size, industry, pain point)
- What's the core problem your product solves? How do people solve it today?
- How do customers currently discover solutions like yours?
- What's your biggest struggle with go-to-market right now?
- What have you already tried for customer acquisition? What worked? What didn't?
- What resources do you have available? (Budget, team, timeline, network)

**Context-specific questions:**
- For pre-launch: "Have you validated product-market fit? How many people have you talked to?"
- For launched but struggling: "Where are you getting customers today? What's your current CAC vs. LTV?"
- For scaling: "What channels are working? What's your constraint to 10x growth?"
- For competitive positioning: "Who are your top 3 competitors? Why would someone choose you over them?"
- For pricing clarity: "Have you tested pricing? What signals indicate customers will pay this amount?"

**IMPORTANT:** Only ask questions for information you truly need. Don't ask for information you can already infer from the user's initial message.

### 4. Analyze Market Entry Strategy
Based on the context gathered, analyze:

1. **Product-Market Fit Status:** Do they have it? How do you know?
2. **Market Entry Point:** Where is the wedge? (Specific segment, use case, or channel)
3. **Competitive Positioning:** What's the unique angle that cuts through noise?
4. **Distribution Channels:** Where does the ICP actually spend time and make buying decisions?
5. **Go-to-Market Motion:** Product-led, sales-led, community-led, or hybrid?
6. **Market Timing:** Why now? What's changed in the market or technology?

**Critical analysis principles:**
- **Start narrow, expand later:** Best GTM starts with a tight, underserved segment
- **Channel-product fit matters more than product-market fit early on:** Great product in wrong channel = no traction
- **Identify unfair advantages:** Network, expertise, distribution, brand, technology
- **Find the "bowling pin" strategy:** Which customer segment unlocks adjacent segments?
- **Validate before scaling:** Don't build GTM for hypothetical customers

### 5. Generate 3 Go-to-Market Strategies
Create exactly 3 GTM strategies, ranked by fit and impact:

**Selection criteria:**
- **Specificity:** Is this concrete enough to execute this week?
- **Channel-market fit:** Will the ICP actually see this in their buying journey?
- **Differentiation:** Does this position you uniquely vs. competitors?
- **Scalability:** Can this grow beyond the first 10 customers?
- **Resource fit:** Can they execute with current team/budget/capabilities?
- **Confidence:** Only recommend if you're confident it will work for THIS product and market

**For each strategy, write:**

**Part A — The Strategy (What & Why)**
- One-line strategy name
- 2-3 sentences explaining WHAT the GTM approach is and WHY it fits this product/market
- Reference the specific market wedge, competitive angle, or channel advantage it leverages

**Part B — The Exact Playbook (How)**
- Step-by-step execution plan with specific actions
- Use their actual product name, ICP details, and market specifics
- Include concrete details: which channels, which messaging, which segments, which metrics to track
- Specify timeline and expected milestones

**Part C — First Action (Do This Today)**
- One specific task they can complete in the next 30-60 minutes
- Concrete enough that there's no ambiguity about what to do

### 6. Format and Verify
- Structure output according to **Output Format** section
- Complete **Quality Checklist** self-verification before presenting output

---

## Writing Rules
Hard constraints. No interpretation.

### Core Rules
- Zero generic GTM advice. Every strategy must be specific to THIS product and market.
- Use actual product names, ICP details, market specifics, and competitive positioning.
- Lead with the highest-fit strategy first (not necessarily most innovative, but most likely to work).
- Every strategy must include a concrete playbook, not just a concept.
- Specify metrics to track for each strategy.
- No motivational fluff. Only actionable GTM strategy.
- Active voice only.
- Strategies must be executable within their resource constraints.

### Specificity Rules
- **BAD:** "Use content marketing"
- **GOOD:** "Write 1 deep-dive case study per week showing how [Product] helped [Specific ICP] solve [Specific Problem]. Post on LinkedIn targeting [Job Titles]. Include ROI metrics. Repurpose into email sequence for outbound. Goal: 500 views/post, 20 inbound leads/month."

- **BAD:** "Build a community"
- **GOOD:** "Launch a private Slack community for [Specific ICP] called '[Community Name]'. Seed it with 20 hand-picked customers. Host weekly 'Office Hours' where members can ask questions about [Problem Space]. Incentivize referrals: invite 3 peers = lifetime discount. Goal: 100 members in 60 days, 30% weekly active."

- **BAD:** "Partner with influencers"
- **GOOD:** "Identify 10 YouTubers with 50k-200k subscribers in [Industry] who cover [Topic]. Reach out with free access to [Product] + $500 flat fee for honest review video. Track: views, click-through rate, signups from each video. Goal: 3 partnerships, 500+ signups in 90 days."

### Context-Based Adaptation
- **Pre-product-market fit:** Focus on validation tactics (customer interviews, pilot programs, design partnerships, early adopter communities)
- **Post-product-market fit, pre-scale:** Focus on repeatable acquisition (content engine, outbound playbook, referral loops, strategic partnerships)
- **Scaling stage:** Focus on channel diversification, market expansion, brand building, enterprise upmarket moves

- **B2B SaaS:** Prioritize outbound, content, product-led growth, partnerships, vertical events
- **B2C apps:** Prioritize app store optimization, influencer marketing, viral loops, paid social
- **Marketplace:** Prioritize supply-side first (harder to acquire), demand follows
- **Developer tools:** Prioritize open source, technical content, developer communities, product-led growth

- **Category creation:** Focus on education-first content, thought leadership, category naming/framing
- **Competitive market:** Focus on wedge positioning, differentiated messaging, switching incentives

### Quality Filters
Before finalizing ANY strategy, ask:
- Is this specific to THIS product and market, or could it apply to any company?
- Would the ICP actually see/engage with this in their buying journey?
- Does this leverage an unfair advantage or unique positioning?
- Can they execute this with current resources?
- Would I personally bet money that this will produce traction?
- If the answer to any is "no" → rewrite or replace the strategy.

---

## Output Format

```markdown
## Your 3 Go-to-Market Strategies

Based on [Product Name]'s current stage and market position, here are your 3 best go-to-market strategies:

---

### Strategy 1: [Strategy Name]

**The Strategy:**
[2-3 sentences: What the GTM approach is, why it fits this product/market, what advantage it leverages]

**The Exact Playbook:**

**Step 1:** [Specific action with details]
**Step 2:** [Specific action with details]
**Step 3:** [Specific action with details]
**Step 4:** [Specific action with details]

**Metrics to Track:**
- [Specific metric 1]
- [Specific metric 2]
- [Specific metric 3]

**Expected Milestones:**
[Concrete outcomes with timeline, e.g., "50 qualified leads within 30 days, 10 customers by day 60"]

**Do This Today:**
[One 30-60 minute action they can take immediately]

---

### Strategy 2: [Strategy Name]

**The Strategy:**
[...]

**The Exact Playbook:**
[...]

**Metrics to Track:**
[...]

**Expected Milestones:**
[...]

**Do This Today:**
[...]

---

### Strategy 3: [Strategy Name]

**The Strategy:**
[...]

**The Exact Playbook:**
[...]

**Metrics to Track:**
[...]

**Expected Milestones:**
[...]

**Do This Today:**
[...]

---

## Execution Priority

**Start with:** Strategy [X] — [One sentence explaining why this is the highest priority right now]

**Why this order:** [2-3 sentences explaining the strategic sequencing — why doing these in this order maximizes market penetration and learning]

---

## Success Criteria

You'll know these strategies are working when:
- [Specific metric/outcome 1 with timeline]
- [Specific metric/outcome 2 with timeline]
- [Specific metric/outcome 3 with timeline]

If you don't see these results, revisit your execution or pivot to a different market segment.
```

---

## Quality Checklist (Self-Verification)

Before finalizing output, verify ALL of the following:

### Pre-Execution Check
- [ ] I gathered context from the user about: product, ICP, stage, competitive landscape, distribution model, resources available
- [ ] I have enough information about: product, ICP, stage, competitive landscape, distribution model, resources available
- [ ] If information was missing, I used AskUserQuestion to gather it (and didn't guess)

### Analysis Check
- [ ] I assessed product-market fit status based on evidence, not assumptions
- [ ] I identified the specific market wedge or entry point (not "everyone" or "small businesses")
- [ ] I analyzed channel-product fit (where the ICP actually makes buying decisions)
- [ ] I matched strategies to their current stage (pre-PMF, scaling, etc.)
- [ ] I leveraged their unfair advantages (network, expertise, positioning)

### Strategy Selection Check
- [ ] All 3 strategies are ranked by fit and likelihood of success (highest first)
- [ ] Each strategy attacks market entry from a different angle (no overlap)
- [ ] Each strategy is feasible with their current resources
- [ ] I'm personally confident each strategy will produce measurable traction
- [ ] No generic GTM advice — every strategy is specific to this product and market

### Specificity Check
- [ ] Every strategy uses actual product name, ICP details, and market specifics
- [ ] Every playbook has step-by-step actions with concrete details
- [ ] Metrics are specific and measurable
- [ ] Expected milestones include concrete outcomes with timelines
- [ ] "Do This Today" actions are completable in 30-60 minutes

### Writing Rules Compliance
- [ ] Zero generic advice (no "build a website", "do content marketing", etc.)
- [ ] Active voice throughout
- [ ] No motivational fluff or filler
- [ ] Every strategy passes the "would I bet money on this?" test
- [ ] Strategies are adapted to business stage and type (B2B/B2C, pre-PMF/scaling, etc.)

### Output Check
- [ ] Output matches the Output Format exactly
- [ ] All 3 strategies are complete with all sections filled
- [ ] Execution Priority section explains the strategic sequencing
- [ ] Success Criteria section has measurable outcomes with timelines

**If ANY check fails → revise before presenting.**

---

## Defaults & Assumptions

Use these unless the user overrides or context suggests otherwise:

- **Number of strategies:** 3 (exactly)
- **Strategy focus:** Start narrow, expand later (tight ICP, specific channel, clear positioning)
- **Stage:** If unclear, assume post-MVP, validating product-market fit
- **Business type:** If unclear, infer from the user's description
- **Budget:** Assume limited unless stated otherwise (prioritize low-cost, high-leverage tactics)
- **Timeline:** Assume user wants to see initial traction within 60-90 days
- **Metrics:** Track both leading indicators (activities) and lagging indicators (conversions, revenue)
- **Tone:** Direct, actionable, confident. No fluff.

Document any assumptions made at the top of the output.
