---
title: Product Engineering Practices (2026)
audience: Small teams shipping product under high AI leverage
---

# 05 · Product Engineering (2026)

Practices for small teams building products with AI doing the typing. The common thread: **AI multiplies output; these practices constrain scope and keep shipping focused on user value.**

## 1. Shape Up (Basecamp)

- **Fixed time, variable scope.** Set an "appetite" (2-week / 6-week), shape the work rough but not detailed, let the team discover the details. Commit to ship *something* in the appetite, not a specific feature set. `[high confidence]` ([Basecamp — Shape Up](https://basecamp.com/shapeup))
- **Small integrated teams.** 1-2 engineers + 1 designer per cycle. No hand-offs; pair lives inside the appetite.
- **Shaped work, not spec'd work.** Shaping = fat-marker sketches, rabbit holes marked, no-gos listed. Specs happen during the cycle as the team discovers.
- **Scope hammering** (Ryan Singer's term) — cut aggressively until it fits the appetite; mark remainder "nice to have." Better to ship 60% done well than 100% done poorly.
- **Vertical slices over horizontal layers.** Ship one end-to-end flow, not "all the UI then all the API."
- **Cooldown between cycles.** Fix bugs, polish, experiment. Don't stack cycles back-to-back.

**Why it matters:** AI velocity without scope control ships features nobody asked for. Shape Up is the simplest framework that scales to AI-heavy throughput without ballooning scope.

## 2. Measurement before launch

- **"If we can't measure it, we haven't shipped it."** Every new feature lands with:
  - SLIs (service-level indicators tied to user outcomes, not infra).
  - Event instrumentation (posthog/amplitude/mixpanel with schema'd events).
  - A dashboard — the team sees adoption/success/failure within 24h.
- **Pre-launch hypothesis + success criterion.** "We expect X% of users to use Y within Z days; if below threshold, we cut the feature."
- **Instrument the failure modes, not just the happy path.** Error rates, retry rates, drop-off.
- **Synthetic monitors in prod** for the critical flows — not just alerts from real traffic.

**Why it matters:** shipping without measurement is wishful thinking. The AI can generate 20 features a week; measurement is how you tell the ones that matter from the ones that don't.

## 3. Trunk-based dev + feature flags

- **Trunk-based development.** One main branch; short-lived (< 24h) branches merged frequently. Avoids merge hell and keeps CI meaningful. `[high confidence]` ([LaunchDarkly — Trunk-Based Development](https://academy.launchdarkly.com/tech-talk-trunk-based-development))
- **PR size cap ~400 LOC.** AI will happily write 2000; split into 5 sequenced PRs. Humans (and AI reviewers) degrade above ~400.
- **Feature flags for every new behavior.** GrowthBook (OSS) or LaunchDarkly (SaaS); sync to Vercel Edge Config for zero-latency flag eval in middleware.
- **Progressive rollout** — 1% → 10% → 50% → 100%, with kill-switch at each step. Tie flag state to your SLIs; auto-rollback on budget burn.
- **Decouple deploy from release.** Deploy whenever; flip the flag when the product says so.
- **Delete old flags ruthlessly.** Dead flags become technical debt faster than dead code.

**Why it matters:** trunk + flags is the regime where small teams ship continuously without incident. The alternative — long branches, big PRs, big releases — does not scale past 2-3 engineers in AI-heavy teams.

## 4. RFC / ADR culture

- **ADRs in `docs/adr/NNNN-title.md`** — one file per decision. Status (Proposed/Accepted/Superseded), context, decision, consequences. Each ADR is the "why." `[high confidence]` ([adr.github.io](https://adr.github.io/))
- **Write the ADR before the code** for any non-trivial architectural change. If you can't write the ADR, you haven't thought enough.
- **ADRs accept challenge.** Team reads the draft, leaves comments; author either answers or revises. Merge = commitment.
- **Supersedes, don't delete.** When an ADR is overruled later, mark it "Superseded by ADR-0042" and leave the history.
- **Short form is fine.** Michael Nygard's template (4-5 sections, < 300 words) is the canonical pattern — not "one 10-page doc per decision."

**Why it matters:** architectural decisions compound. Without ADRs the team relitigates the same choices yearly, and new hires (including new Claude sessions) can't understand "why is it this way."

## 5. Documentation — C4 + Diátaxis

- **C4 model** (Context / Container / Component / Code) is the "what" — lightweight diagrams that survive refactors. Pair ADRs ↔ C4 components. ([c4model.com](https://c4model.com/))
- **Diátaxis** splits docs into four modes:
  - **Tutorials** — learning-oriented (new-hire path).
  - **How-tos** — goal-oriented (recipes).
  - **Reference** — info-oriented (API/schema).
  - **Explanation** — understanding-oriented (design rationale).
  - Don't mix them; it's the #1 cause of bad READMEs. ([diataxis.fr](https://diataxis.fr/))
- **README-driven development.** Write the README first. If you can't, the design is unclear.
- **Living docs.** Generate API reference from Zod/OpenAPI/tRPC schemas; never hand-write reference docs.
- **The 2-hour onboarding test.** If a new hire (or a new Claude session) can't grasp a module in 2 hours of reading, it's broken.
- **ADRs and READMEs are version-controlled with the code they describe.** No Notion, no Confluence for architectural state.

**Why it matters:** in AI-heavy teams, **docs are the single highest-leverage artifact** — they become context for every agent session. The team with the best docs now has the best agents.

## 6. Code review in AI teams

- **AI-first review triages, humans decide.** Graphite Agent, Copilot Review, `claude-code review`, Cursor Bugbot run before human review. Humans focus on architecture, security, product intent. Shopify reports +33% PRs/dev with Graphite; Asana +21% code shipped, median PR size −11%.
- **Write code AI reviews well.** Small PRs, descriptive names, colocated tests, ADRs for non-obvious decisions. "AI-reviewable" ≈ "human-reviewable, just more so."
- **AI-generated smells humans catch:**
  - Plausible but wrong APIs (hallucinated imports)
  - Silent error-swallowing
  - Tests that assert what the code just did (tautologies)
  - "Generic" abstractions with one caller
  - Copy-paste patterns spreading a wrong approach
- **Humans still own:** merge, deploy, secrets, customer-facing copy, licenses, trade-off judgment.
- **Require tests + types in every AI-generated PR.** If the PR is "easy to review" because it has no tests, it's not easy — it's unaudited.

**Why it matters:** AI cuts the time to write code; reviewing has to cut proportionally or it becomes the bottleneck.

## 7. Sunset rituals

- **Explicit deprecation plans.** Every feature has a deprecation mechanism (flag, warning header, migration guide).
- **Remove-before-replace for competing patterns.** Don't let "new way" and "old way" coexist for more than one cycle.
- **Dead-code sweeps monthly.** `knip` in CI + monthly ritual to delete anything it flags.
- **Kill zombie flags.** Flags past their rollout: remove the flag and the losing branch within 2 cycles.

**Why it matters:** without explicit sunsetting, AI tooling will cheerfully propagate the legacy pattern forever. Dead code compounds faster in AI-heavy repos than human ones.

## 8. Build for the inflection, not steady state

- **Arceus's bottleneck today is the agent loop itself** — not 100k req/s, not global distribution, not multi-region. Don't over-engineer for problems you don't have.
- **Pre-mature scaling is a rounding error on output.** The same engineers who shipped 5 scaling improvements in a quarter could have shipped 5 product features.
- **Invest scale work when the metric says to.** SLI burn-rate, not gut feeling.
- **Have the architectural path ready.** You don't need read replicas today; you need to know how you'd add them tomorrow. Document the path in an ADR.

**Why it matters:** small teams win by going deep on one thing at a time. "What's blocking *this month's* user value?" is the scaling question.

---

## Applied to Arceus

| Arceus area | Rule from this file |
|---|---|
| Spec planning (`plans/specs/NN-*.md`) | §1 — shape the appetite, not the spec; §5 — ADRs for architectural decisions |
| Sprint cadence | §1 — fixed-time / variable-scope; cooldown built in |
| Feature flags on new agent behaviors | §3 — kill switch on every new sprint review, pattern learner, skill mutator behavior |
| PR size enforcement | §3 — CI warn at 400 LOC, hard fail at 800 |
| `plans/` folder hygiene | §4 — one ADR per architectural decision; supersede, don't delete |
| README / CODEMAPS | §5 — Diátaxis-split; reference auto-generated from contracts |
| Agent-driven code review | §6 — `claude-code review` before human; humans own merge |
| Self-evolution / spec-14 shipping | §2 — measure skill successRate + mutation merge rate pre-launch |

## Key sources

- [Basecamp — Shape Up](https://basecamp.com/shapeup) · [Ch. 14 "Decide When to Stop"](https://basecamp.com/shapeup/3.5-chapter-14)
- [LaunchDarkly — Trunk-Based Development](https://academy.launchdarkly.com/tech-talk-trunk-based-development)
- [GrowthBook × Vercel Edge Config](https://blog.growthbook.io/vercel/)
- [adr.github.io](https://adr.github.io/) · Michael Nygard's ADR template
- [c4model.com](https://c4model.com/)
- [diataxis.fr](https://diataxis.fr/)
- [Graphite — AI code review best practices](https://graphite.com/guides/ai-code-review-implementation-best-practices)
- [Graphite — Reviewing AI-generated code](https://graphite.com/guides/ai-review-ai-generated-code-guide)
