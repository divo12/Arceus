---
name: strategic-planning
description: Identifies the single highest-leverage growth constraint and delivers 3 specific, sequenced next moves for marketing or sales.
role: ceo
trigger: CEO needs to identify highest-impact next moves, break a growth bottleneck, or plan the next phase of the business
---

# Strategic Planning

## Purpose
Analyze the founder's business and current situation to deliver 3 specific, actionable next moves that will drive measurable results in marketing or sales.

---

## Execution Logic

**Check $ARGUMENTS first to determine execution mode:**

### If $ARGUMENTS is empty or not provided:
Respond with:
"strategic-planning loaded, proceed with additional details about your current situation or business goals"

Then wait for the user to provide their requirements in the next message.

### If $ARGUMENTS contains content:
Proceed immediately to Task Execution (skip the "loaded" message).

---

## Task Execution

When user requirements are available (either from initial $ARGUMENTS or follow-up message):

### 1. Diagnose Current Situation
Evaluate whether you have enough information to produce high-confidence, actionable strategies:

**Required information to proceed without questions:**
- What the business does (product/service)
- Who they serve (ICP/target audience)
- Current revenue stage (pre-revenue, $X MRR/ARR, etc.)
- Primary growth goal (more leads, higher conversion, retention, etc.)
- Current biggest bottleneck or struggle
- What they've already tried
- Available resources (team size, budget, technical capability)

**If you have enough context:** Proceed directly to Step 4.

**If critical information is missing:** Proceed to Step 3.

### 3. Ask Diagnostic Questions (When Needed)
Use the AskUserQuestion tool to gather missing information. Ask between 3-10 questions based on what's needed:

**Core diagnostic questions:**
- What's your biggest struggle in the business right now?
- What have you already tried to solve this?
- What's your current main bottleneck preventing growth?
- How are you currently getting clients/customers?
- What's working? What's not working?
- What resources do you have available (budget, team, time)?
- What's your timeline for seeing results?

**Context-specific questions:**
- For lead generation issues: "Where does your ICP spend time? What conferences, communities, or platforms?"
- For conversion issues: "At what stage do prospects drop off? What objections do they have?"
- For retention issues: "Why do customers churn? Have you asked them?"
- For scaling issues: "What breaks when you try to grow? What's the constraint?"

**IMPORTANT:** Only ask questions for information you truly need. Don't ask for information you can already infer from the user's initial message.

### 4. Analyze and Identify Opportunities
Based on the context gathered, analyze:

1. **Current state:** Where they are now (revenue, channels, constraints)
2. **Desired state:** Where they want to be (goals gathered from the user)
3. **Gap analysis:** What's blocking them from getting there
4. **Leverage points:** Where small actions create outsized results
5. **Quick wins vs. long-term moves:** Balance immediate impact with sustainable growth

**Critical analysis principles:**
- Identify the ONE constraint that, if removed, would unlock the most growth
- Look for underutilized assets (audience, content, network, product features)
- Find competitive gaps (what competitors aren't doing that would work)
- Spot channel-market fit mismatches (selling in wrong places)
- Detect execution issues vs. strategy issues

### 5. Generate 3 Next Moves
Create exactly 3 strategic moves, ranked by impact:

**Selection criteria:**
- **Impact:** Will this measurably move the needle? (revenue, leads, conversion, retention)
- **Specificity:** Is this concrete enough to execute today?
- **Feasibility:** Can they actually do this with current resources?
- **Differentiation:** Each move should attack the problem from a different angle
- **Confidence:** Only recommend if you're confident it will work for THIS business

**For each move, write:**

**Part A — The Strategy (What & Why)**
- One-line strategy name
- 2-3 sentences explaining WHAT to do and WHY it will work for this specific business
- Reference the real constraint or opportunity it addresses

**Part B — The Exact Playbook (How)**
- Step-by-step execution plan with specific actions
- Use their actual company name, product, ICP, and industry
- Include concrete details: which platforms, which conferences, which messaging, which metrics to track
- Specify timeline and expected results

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
- Zero generic advice. Every recommendation must be specific to THIS business.
- Use actual company names, product names, ICP details, and industry specifics.
- Lead with the highest-impact move first.
- Every strategy must include a concrete playbook, not just a concept.
- Specify metrics to track for each move.
- No motivational fluff. Only actionable strategy.
- Active voice only.
- Strategies must be executable within their resource constraints.

### Specificity Rules
- **BAD:** "Run Facebook ads"
- **GOOD:** "Run Facebook lead ads targeting healthcare CFOs in Texas with this exact hook: [hook]. Budget: $500/month. Track: cost per qualified lead. Goal: 15 leads in 30 days."

- **BAD:** "Network at events"
- **GOOD:** "Attend HealthTech Summit in Austin (March 15-17). Book a booth ($2,500). Approach 30 attendees with your value proposition. Collect LinkedIn profiles. Follow up 2 days later with a personalized connection message referencing your conversation."

- **BAD:** "Improve your website"
- **GOOD:** "Add a self-serve product demo at try.yourcompany.com. No signup required. Pre-load it with dummy data showing your product solving [specific problem]. Add CTA at end: 'Want this for your team? Start free trial.' Track: demo completion rate, demo-to-trial conversion."

### Context-Based Adaptation
- **Early-stage / bootstrapped:** Prioritize low-cost, high-leverage tactics (content, outbound, partnerships, guerrilla marketing)
- **Growth-stage / funded:** Include strategies that require budget or team (paid acquisition, events, product-led growth)
- **B2B:** Focus on outbound, LinkedIn, partnerships, conferences, case studies, product-led growth
- **B2C:** Focus on virality, social, influencers, retention loops, community
- **Product issues:** Don't recommend marketing if the product isn't solving a real problem yet. Recommend customer development instead.
- **Distribution issues:** If product is great but nobody knows about it, recommend distribution-first moves.

### Quality Filters
Before finalizing ANY recommendation, ask:
- Would this work if they executed it exactly as written?
- Is this specific enough that they could start in the next hour?
- Does this leverage their unique position, audience, or assets?
- Would I personally bet money that this will produce results for THIS business?
- If the answer to any is "no" → rewrite or replace the recommendation.

---

## Output Format

```markdown
## Your 3 Next Moves

Based on [Company Name]'s current situation, here are your 3 highest-impact next moves:

---

### Move 1: [Strategy Name]

**The Strategy:**
[2-3 sentences: What to do, why it works for this business, what constraint/opportunity it addresses]

**The Exact Playbook:**

**Step 1:** [Specific action with details]
**Step 2:** [Specific action with details]
**Step 3:** [Specific action with details]
**Step 4:** [Specific action with details]

**Metrics to Track:**
- [Specific metric 1]
- [Specific metric 2]
- [Specific metric 3]

**Expected Results:**
[Concrete outcome with timeline, e.g., "15-20 qualified leads within 30 days"]

**Do This Today:**
[One 30-60 minute action they can take immediately]

---

### Move 2: [Strategy Name]

**The Strategy:**
[...]

**The Exact Playbook:**
[...]

**Metrics to Track:**
[...]

**Expected Results:**
[...]

**Do This Today:**
[...]

---

### Move 3: [Strategy Name]

**The Strategy:**
[...]

**The Exact Playbook:**
[...]

**Metrics to Track:**
[...]

**Expected Results:**
[...]

**Do This Today:**
[...]

---

## Execution Priority

**Start with:** Move [X] — [One sentence explaining why this is the highest priority right now]

**Why this order:** [2-3 sentences explaining the strategic sequencing — why doing these in this order maximizes impact]

---

## Success Criteria

You'll know these moves are working when:
- [Specific metric/outcome 1 with timeline]
- [Specific metric/outcome 2 with timeline]
- [Specific metric/outcome 3 with timeline]

If you don't see these results, revisit your execution or reach out for a strategy adjustment.
```

---

## Quality Checklist (Self-Verification)

Before finalizing output, verify ALL of the following:

### Pre-Execution Check
- [ ] I gathered context from the user about: product, ICP, current stage, main bottleneck, resources available
- [ ] I have enough information about: product, ICP, current stage, main bottleneck, resources available
- [ ] If information was missing, I used AskUserQuestion to gather it (and didn't guess)

### Analysis Check
- [ ] I identified the real constraint blocking growth (not just symptoms)
- [ ] I analyzed leverage points specific to THIS business
- [ ] I considered what they've already tried (don't repeat failed approaches)
- [ ] I matched strategies to their resources (team, budget, capabilities)

### Strategy Selection Check
- [ ] All 3 moves are ranked by impact (highest first)
- [ ] Each move attacks the problem from a different angle (no overlap)
- [ ] Each move is feasible with their current resources
- [ ] I'm personally confident each move will produce measurable results
- [ ] No generic advice — every recommendation is specific to this business

### Specificity Check
- [ ] Every move uses actual company name, product, ICP, and industry details
- [ ] Every playbook has step-by-step actions with specific details
- [ ] Metrics are specific and measurable
- [ ] Expected results include concrete outcomes with timelines
- [ ] "Do This Today" actions are completable in 30-60 minutes

### Writing Rules Compliance
- [ ] Zero generic advice (no "send more cold emails", "improve your website", etc.)
- [ ] Active voice throughout
- [ ] No motivational fluff or filler
- [ ] Every recommendation passes the "would I bet money on this?" test
- [ ] Strategies are adapted to business stage and type (B2B/B2C, early/growth, etc.)

### Output Check
- [ ] Output matches the Output Format exactly
- [ ] All 3 moves are complete with all sections filled
- [ ] Execution Priority section explains the strategic sequencing
- [ ] Success Criteria section has measurable outcomes with timelines

**If ANY check fails → revise before presenting.**

---

## Defaults & Assumptions

Use these unless the user overrides or context suggests otherwise:

- **Number of moves:** 3 (exactly)
- **Move focus:** Balanced between quick wins and sustainable growth
- **Stage:** If unclear, assume early-stage/growth (limited resources)
- **Business type:** If unclear, infer from the user's description
- **Budget:** Assume limited unless stated otherwise (prioritize low-cost, high-leverage tactics)
- **Timeline:** Assume user wants to see initial results within 30 days
- **Metrics:** Track leading indicators (actions taken) and lagging indicators (revenue/growth)
- **Tone:** Direct, actionable, confident. No fluff.

Document any assumptions made at the top of the output.
