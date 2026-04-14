# The Future of AI Coding: Async Agents & Self-Driving Codebases

> **Speaker:** Aman Sanger, Co-founder of Cursor
> **Source:** Conference talk, 2026
> **Summary by:** Divyansh

---

## The Evolution of AI Coding

### Era 1: Autocomplete (2021-2023)

The first AI coding application that worked was tab completion. Models looked at the last few minutes of work in the editor and predicted the next edits — where you'd jump, what you'd type. This was the era when Cursor launched.

### Era 2: Synchronous Agents (2024-2025)

Models got strong enough that you could ask with natural language for agents to implement full changes. 2025 was the year coding agents completely took off. By the end of 2025, the vast majority of code written in Cursor came from agents rather than people using tab. The data is striking — it's not just tracking "users are using agents vs tab" but agent requests vs tab accepts. With tab, every keystroke triggers a potential request. Yet people are now submitting whole prompts far more than individual keystrokes.

### Era 3: Async Agents (Now → Near Future)

Synchronous agents work but have limitations. They run on local machines, eat up resources. If you want to scale to tens of agents, local execution becomes impossible. Async agents need:

- **Their own cloud environments** — VMs, full desktops
- **Full developer tool suite** — everything you could do locally
- **Long-running capability** — hours, not minutes
- **Computer use** — ability to click around, test features, take screenshots

Internally at Cursor, 30% of merged PRs now come from cloud agents. These aren't trivial bug fixes:
- A video rendering refactor that made things 25x faster, migrating from React to Rust — took 8 hours
- A 10,000-line PR adding network policy controls for sandbox processes

### Era 4: Self-Driving Codebases (Future)

The terminal state. Involves:
- Self-healing and fixing (changes no human ever reviews)
- Building full projects or products with little to no human intervention
- No human-written code

---

## The Artifact Inflection Point

The thing that caused rapid internal adoption of cloud agents was **artifacts** — reviewable outputs beyond just code diffs.

### Why Artifacts Matter

When agents produce 2-4x more code than they could locally, reviewing all those code changes manually becomes intractable. In the same way a manager reviews outputs rather than reading every line of code, engineers need to review what the model produced — not how.

### Types of Artifacts

**Video Artifacts:** After implementing a feature, the agent takes a video of the fully functioning feature. If there's a bug, you watch the video and reprompt. You never need to read the code until you're confident the feature works correctly.

**Research Reports:** For ML experiments, agents run small-scale experiments and produce research reports. You review the report (far faster than reviewing code), iterate on direction, then look at code only when you have high confidence.

**Architecture Diagrams / Plans:** For backend and infra, agents could iterate on architecture diagrams and plans before writing code. Still an open area being explored.

### Model UX

An underrated concept: models need to get really good at producing useful, understandable artifacts. If the agent recorded a video of a useless part of the feature, it wouldn't help. Models need to:
- Focus on areas of maximum ambiguity
- Show the parts the user didn't specify enough
- Make the unclear decisions visible for human review
- Format outputs for quick comprehension

This matters more and more as models get arbitrarily good at producing correct code from well-defined specs.

---

## Multi-Agent Architecture for Long-Running Tasks

### The Core Problem: Train-Time / Test-Time Mismatch

Agents are trained using reinforcement learning (RL) on tasks of bounded length — hundreds of thousands, maybe millions of tokens. When deployed, if agents run for far too long (tens of millions of tokens), they exit the distribution of their training:
- They lose track of things
- They can't go into enough detail
- They make mistakes that wouldn't happen on shorter tasks

### The Solution: Hierarchical Multi-Agent

The simplest and most effective pattern: **main agent + sub agents**.

```
High-Level Planner
    │
    ├── Sub-Planner 1
    │     ├── Worker A
    │     └── Worker B
    │
    ├── Sub-Planner 2
    │     └── Worker C
    │
    └── Sub-Planner 3
          ├── Worker D
          └── Worker E
```

Each sub-task is a much simpler task well within the model's training distribution. The outer planner runs for maybe a few hundred thousand tokens, calling sub-agents and fanning out work. Each worker runs for a bounded time on a focused task.

**Key insight:** This is a recursive structure. Sub-planners can call other sub-planners. At the leaf nodes, you have workers. This compresses the token consumption per agent while achieving extremely long-running total execution.

### Model Specialization

Different models excel at different things:

| Capability | Best Models |
|-----------|------------|
| High-level planning and orchestration | OpenAI |
| Computer use / multimodal understanding | Gemini, Anthropic |
| UI generation | Anthropic |
| Fast execution of simpler sub-tasks | Smaller, faster models |

Cursor's cloud agents use OpenAI as the planner, then route to other models for specialized tasks (recording videos, using features, proving things work).

### Limitations

Even multi-agent systems have limits:
- As total task length grows, the planner itself starts running too long
- Models aren't trained well to be excellent orchestrators yet
- RL benefits worker-level tasks more than orchestration
- Cursor is training their own models specifically for this orchestration layer

---

## Self-Driving Codebases

### Part 1: Self-Healing and Fixing

**Automations** — agents triggered by events:
- **Issue tracker:** On every new issue, an agent proposes a potential fix
- **On-call pages:** Every time you get paged at 2 AM, an agent investigates and proposes a solution. You wake up groggy and might just need a single click to fix the problem.
- **Training runs:** Agents monitor logs and Weights & Biases every few steps, flag potential issues, catch failures early before training silently degrades
- **Code review and security:** Agents find vulnerabilities in PRs that would have otherwise shipped

The goal: agents are always the primary on-call. Humans are escalated to as a secondary.

Some changes in this world get into main with no human ever reviewing them. Issues easy enough to fix + agents with high enough confidence = auto-merge.

### Part 2: Building Full Projects

**The Browser Experiment:** Cursor attempted to build a working web browser using agents. A browser is extremely complicated — rendering engine for arbitrary HTML/CSS, JavaScript sandbox, animations, and more.

The experiment:
- One-week run
- Billions of tokens
- Tens of thousands of dollars of compute
- Produced something that works but is far from production browsers
- Can render lots of arbitrary pages with several hiccups

**The Harness:**

Extended the async agent harness with recursive multi-agent:

```
High-Level Planner
    ├── Sub-Planner → Sub-Planner → Workers (leaf nodes)
    ├── Sub-Planner → Workers
    └── Sub-Planner → Sub-Planner → Workers
```

They tried many architectures. This recursive planner → sub-planner → worker pattern worked best. It's simpler than the alternatives and leverages token compression effectively.

**What they're excited about:**
- Making this multimodal (different models for computer use, planning, UI)
- Training models specifically for this harness — no model has been trained with the idea of being used in extremely long-running recursive harnesses
- Training a model to act as planner/sub-planner and be good at calling out to itself or other models

### The UX Challenge

Right now, getting these systems to work requires detailed spec engineering:
- Really detailed specs with clear rubrics for correctness
- Lots of attempts and nudging the harness
- Similar to prompt engineering a few years ago

As agents improve:
- The burden of spec quality will decrease
- Models will help build better specs
- For long runs, you need to intervene at sub-points (not wait until the end)
- Artifacts become critical for mid-run review

---

## Cursor as an R&D Cloud

In the same way traditional clouds (AWS, GCP) deliver infrastructure for running products, Cursor aims to be a new kind of cloud — an **R&D cloud** that helps enterprises build more ambitious software.

---

## The Future Role of Engineers

What will be missing from agents for a while:

**Real agency** — deciding WHAT should get built. There will be details and product taste that are really hard to learn. Ultimately deciding what are the right things to build that matter in the world is the most important piece.

**Taste** — in two places:
1. **Product taste:** Making sure you're building the right features, the right UX. Don't let velocity take over. "Don't lose the battle to slop."
2. **Architectural taste:** Making sure you don't just merge sloppy code changes and bad architecture. State this clearly as a company value.

**Key skills that still matter:**
- **Holding a lot in your head** — the bar increases. Instead of holding one part of the codebase in your head, you may need to hold the entire codebase but at a higher abstraction level.
- **Attention to detail** — the details change (product decisions, architectural proposals, model outputs) but the skill of noticing what's wrong still matters.

**Cursor's approach:** Scaling engineering 3x this year. Not cutting headcount because of AI productivity gains — instead, tackling more ambitious things. Compounding excellent engineers with excellent tools.

---

## Key Takeaways

1. **Single agents fall apart at scale.** Multi-agent with recursive decomposition is the solution.
2. **Review artifacts, not code.** Videos, reports, and demos are faster to review than diffs.
3. **Self-healing is real today.** Automations triggered by issues, pages, and PRs already show serious signs of life.
4. **Building full projects is possible but early.** The browser experiment proves the concept. UX and harness design are the bottlenecks.
5. **Model UX matters.** As models get better at code, the quality of their non-code outputs (artifacts, plans, reports) becomes the differentiator.
6. **Spec quality drives output quality.** Today you need detailed specs. Tomorrow models help write the specs. The spec is becoming the product.
7. **Engineers become directors, not typists.** Deciding what to build, maintaining taste, reviewing outputs — not writing code.
8. **Train-time / test-time match is crucial.** Keep each agent's work within the distribution of its training. Decompose aggressively.
9. **The future is async, multi-model, and recursive.** Planners orchestrate sub-planners orchestrate workers, each using the best model for the job.
10. **Don't lose the battle to slop.** Product taste and architectural quality still matter. Value it explicitly.
