# Self-Evolving Agents — Research Digest

**Source:** [CharlesQ9/Self-Evolving-Agents](https://github.com/CharlesQ9/Self-Evolving-Agents) (1.1k★, 97 forks, Apache-2.0)
**Underlying paper:** "A Survey of Self-Evolving Agents: On the Path to Artificial Super Intelligence" — Gao et al. 2025 — [arXiv 2507.21046](https://arxiv.org/abs/2507.21046)
**Generated:** 2026-04-18
**Purpose:** Systematic digest of the repo + paper to guide Arceus agentic evolution work (Spec 14, Spec 23, and the to-be-written Spec 25).

---

## 0. Why this matters for Arceus

The survey's core argument: LLMs are **fundamentally static** — they can't adapt their internal parameters to novel tasks, evolving domains, or dynamic interaction contexts. Self-evolving agents close that gap by continuously updating one or more of **memory, prompts, tools, architecture** — without requiring model fine-tuning.

Arceus already has pieces of this: SkillArtifact (procedural memory), ATA mutation pipeline (prompt evolution), Hippocampus (episodic + semantic memory scaffolding). The survey gives us the vocabulary and missing mechanisms.

---

## 1. The "What / When / How / Where" Taxonomy

The survey's organizing principle. Use this as a checklist when designing Arceus evolution features.

### 1.1 WHAT to Evolve

| Axis | What it covers | Arceus surface today |
|---|---|---|
| **Models** | Parameters, fine-tunes | **Not applicable** — Arceus uses external LLMs |
| **Context (Memory)** | Episodic, semantic, procedural | Hippocampus (partial) + SkillArtifact (procedural) |
| **Context (Prompts)** | Role prompts, operating instructions | `getRoleSoul` static prompts |
| **Tools** | Callable capabilities | OpenCode native tools + filesystem |
| **Architecture** | Agent graph, handoffs, role definitions | Fixed role set (ceo, pm, dev, tester, skills_lead) |

### 1.2 WHEN to Evolve

- **Intra-test-time** — during a single task execution (adaptive planning, test-time training)
- **Inter-test-time** — between tasks (bootstrapping, multi-turn RL, curriculum)
- **Continuous** — ongoing in deployment
- **Episodic** — triggered by task completion or failure
- **Competence-based** — triggered by performance thresholds
- **Curriculum-based** — staged by difficulty

**Arceus today:** inter-test only (ATA runs between sprints). Missing: intra-test adaptation.

### 1.3 HOW to Evolve

- **Gradient-based** — parameter updates (N/A without fine-tune)
- **Evolutionary algorithms** — population-based search, genetic operators
- **Reinforcement learning** — reward-driven policy improvement
- **In-context learning** — prompt-based adaptation, no parameter changes
- **Feedback-driven refinement** — direct incorporation of error signals
- **Imitation learning** — self-generated, cross-agent, hybrid demonstrations
- **Population-based + adversarial** — multi-agent co-evolution, self-play

**Arceus today:** feedback-driven (ATA uses failure patterns) + partial in-context. Missing: evolutionary search, self-play.

### 1.4 WHERE to Evolve

- **Within-episode** — single task
- **Between-episode** — across attempts
- **Cross-domain** — transfer across task categories
- **Population-level** — multi-agent

**Arceus today:** between-episode (sprint-to-sprint). Missing: cross-domain (per-company → cross-company learnings), population-level.

---

## 2. Named Techniques — The Repo's Paper Map

Organized by Arceus-relevant category. Each is a candidate to port.

### 2.1 Self-Improvement & Refinement

| Technique | One-liner | Arceus mapping |
|---|---|---|
| **Self-Refine** | Iteratively improves outputs through self-critique | Per-beat reflection before commit |
| **Reflexion** | Learns from trajectory summaries in context | Already implemented in feedback loop |
| **Self-Evolving Prompts** | Auto-prompt optimization via evolutionary search | Candidate for CEO/role prompts |
| **PromptBreeder** | Genetic algorithm for prompts: mutation + crossover | Skills Lead mutation pipeline upgrade |
| **TextGrad** | Text-based "gradient" computation via perturbation | Alternative to PromptBreeder for ATA |

### 2.2 Memory Evolution

| Technique | One-liner | Arceus mapping |
|---|---|---|
| **Mem0** | Persistent memory management system | Hippocampus companion |
| **MemInsight** | Memory extraction + refinement from interactions | Post-beat curator agent |
| **MemEvolve** | Evolutionary memory structure optimization | Prune/compact stored memories |
| **MemGen** | Generative memory creation for novel scenarios | Synthetic memory for cold-start |
| **Episodic Memory Banking** | Store & retrieve past episodes for learning | Missing — add beat-transcript store |

**Concrete mechanisms surveyed:**
- Episodic memory pruning + consolidation
- Semantic memory refinement via clustering
- Retrieval-augmented memory updating
- Long-term/short-term balance optimization
- Experience replay with importance weighting
- Memory compression via summarization
- Hierarchical memory organization
- Novelty-based memory prioritization

### 2.3 Tool Evolution

| Technique | One-liner | Arceus mapping |
|---|---|---|
| **ToolFormer** | Learns when/how to use external tools | Per-role tool-use scoring |
| **ToolLLM** | Instruction-tunes on 16k+ real APIs | Reference for external-MCP adoption |
| **AutoGuide** | Auto-generates usage guidance for tools | Tool SKILL.md writer |
| **ToolGen** | Generative tool discovery + creation | Dev role proposes new internal tools |
| **Tool-Ret** | Adaptive tool retrieval & selection | Replace hardcoded per-role tool lists |
| **ATLASS** | Advanced Tool Learning and Selection System | Framework for tool-gated roles |

**Concrete mechanisms:**
- Tool discovery — learning which tools exist + what they do
- Composition learning — chaining tools in novel sequences
- Parameter adaptation — adjusting invocation arguments
- Tool creation — generating new tool definitions from base capabilities
- Contextual selection — per-task tool choice
- Tool specialization — fine-tuning tools for domains
- Skill bundling — grouping tools into reusable packages

### 2.4 Architecture Evolution

| Technique | One-liner | Arceus mapping |
|---|---|---|
| **EvoAgent** | Multi-agent generation via evolutionary search | Spawn specialized sub-roles on demand |
| **Darwin Framework** | Genetic programming for agent architectures | Auto-designed org chart |
| **AutoEnv** | Automatic environment adaptation + evolution | Workspace/scaffold evolution |
| **SEW (Self-Evolving Workflows)** | Evolving agentic workflows for code gen | Sprint flow as evolvable object |
| **Agent Evolution with Genetic Operators** | Mutation/crossover/selection of agents | CEO could cull/spawn roles |
| **NAS adapted for agents** | Neural architecture search → agent-arch search | N/A without training |

**Concrete mechanisms:**
- Component-level evolution (encoders, controllers, policies)
- Connection evolution (inter-component wiring)
- Modular recombination (mix/match learned components)
- Growth mechanisms (expanding architecture during learning)
- Pruning (removing ineffective components)
- Morphogenesis (developmental structural changes)

### 2.5 RL + Reward-Based Evolution

| Technique | One-liner |
|---|---|
| **Policy Gradient Methods** | Gradient-based policy optimization |
| **DPO (Direct Preference Optimization)** | Learn from preferences without explicit reward |
| **RLHF** | Human-feedback-guided optimization |
| **Best-of-N Selection** | Sample many, keep best |
| **Process Reward Modeling** | Reward intermediate steps, not just outcome |

**Arceus mapping:** trust/successRate EMA is a lightweight reward signal; Best-of-N and Process Reward are the next upgrades.

### 2.6 Curriculum & Competence

| Technique | One-liner |
|---|---|
| **Curriculum Learning** | Ordered easy → hard progression |
| **Competence-Based Progression** | Advance on performance thresholds |
| **Self-Paced Learning** | Agent-controlled difficulty |
| **Adaptive Curriculum** | Dynamic difficulty adjustment |
| **Mastery-Based Advancement** | Move on when skill mastered |

**Arceus mapping:** CEO currently proposes sprint scope flat. Add a curriculum agent that tracks company "capability level" and proposes next-best-task.

---

## 3. Domain Applications (from §6 of the survey)

The repo indexes domain-specific self-evolving systems. Relevant exemplars:

| Domain | System | Arceus analog |
|---|---|---|
| **Code generation** | SEW (Self-Evolving Agentic Workflows), Self-Improving Coding Agent | Developer role + sprint loop |
| **Medical** | MDTeamGPT (multi-agent medical consult) | N/A but good multi-role template |
| **Finance** | QuantAgent | N/A |
| **Education** | LLM-Empowered Classroom Simulation | Skills Lead teaching dev role |
| **Web/Mobile** | WebArena agents, Mobile agents | External MCP targets |
| **Reasoning** | LADDER (recursive problem decomposition) | Task planner upgrade |
| **Vision-language** | Vision-Zero (VLM self-improvement via gamified self-play) | Not immediately relevant |

---

## 4. Benchmarks (from §7)

Use these when building evaluation harness for Arceus:

| Benchmark | What it tests |
|---|---|
| **SWE-Bench** | Software engineering tasks — **directly applicable to dev role** |
| **AgentBench** | Multi-domain agent capability |
| **GAIA** | General AI agent capability |
| **WebArena / Mind2Web / WebShop** | Web interaction |
| **OSWorld** | OS interaction & automation |
| **ToolBench** | Tool usage & integration |
| **ScienceAgentBench** | Scientific reasoning |
| **ACEBench** | Autonomous coding + engineering |
| **LifelongAgentBench** | Continual learning — **directly applicable to ATA** |
| **The Agent Company** | Organizational simulation — **closest to Arceus** |
| **LiveBench** | Continuously updated eval set |

**Action:** run SWE-Bench Lite + LifelongAgentBench against the developer role after each ATA mutation to catch regressions.

---

## 5. Future Directions (from §8) — Arceus Priorities

The survey's future-directions list, ranked by Arceus-relevance:

1. **Personalize AI Agents** — per-company customization. **Already core to Arceus.**
2. **Safe & Controllable Agents** — governance, policy rules. **Governance Gateway exists; formalize.**
3. **Ecosystems of Multi-Agents** — co-evolution, population dynamics. **Missing.**
4. **Generalization** — cross-domain transfer. **Missing — skills are per-company-scoped.**
5. **Catastrophic Forgetting prevention** — maintain old skills while learning new. **Partial via versioning.**
6. **Long-Horizon Planning** — extended task sequences. **Sprint structure helps; need episodic eval.**
7. **Sample Efficiency** — reduce beats-per-mutation. **EMA already smooths; unknown floor.**
8. **Multi-Objective Evolution** — balance trust, cost, speed. **Missing — only trust tracked.**
9. **Theory of Evolution** — formal dynamics. **Academic; skip.**

---

## 6. Concrete Enhancements for Spec 23 (and Spec 25)

Mapping the survey's mechanisms onto concrete Arceus work items:

### 6.1 Quick wins (1-2 days each)

1. **Add episodic memory store** — beat transcripts indexed by sprint → retrieve on similar tasks. (Mem0/MemInsight pattern.)
2. **Ship `request_human_approval` tool** — interrupt pattern from LangGraph.
3. **Per-skill multi-objective score** — trust × (1/cost) × (1/latency). Today only trust.
4. **SWE-Bench Lite smoke test** — run after every ATA merge; block regressions.
5. **Best-of-N on CEO sprint proposals** — generate 3, score, keep best.

### 6.2 Medium (1-2 weeks)

6. **PromptBreeder-style role-prompt mutation** — current ATA only mutates skills; extend to soul prompts.
7. **Curriculum agent** — tracks company capability, proposes next-best-task, replaces naive backlog-first.
8. **Tool-Ret adaptive tool selection** — today per-role tool lists are fixed; make them retrieved per-task.
9. **Reflector + Curator pair** — post-beat review agent that writes to episodic memory + proposes skill mutations. (This formalizes ATA.)
10. **Process reward modeling** — reward intermediate beat progress, not just sprint outcome.

### 6.3 Larger bets

11. **EvoAgent-style role spawning** — CEO can propose a new role (e.g. `devops`) when skills show structural gap.
12. **Cross-company skill transfer** — a skill that works well in Company A becomes a candidate seed for Company B (with governance review).
13. **Self-play for tester vs. developer** — adversarial co-evolution where tester tries to break, dev tries to fix; both improve.
14. **Formal safety envelope** — policy rules compiled to deny-by-default capability grants (see guardrails-as-infra arxiv).

---

## 7. Mapping to Arceus Specs

| Survey concept | Target spec |
|---|---|
| Episodic memory, Mem0, MemInsight | Spec 16 (memory consolidation) |
| PromptBreeder, TextGrad | Spec 14 (ATA pipeline upgrade) |
| ToolGen, Tool-Ret, ATLASS | Spec 23 (tool integration — this is the active one) |
| EvoAgent, Darwin, SEW | New spec — role/workflow evolution |
| Curriculum learning | Spec 15 (long-horizon execution) |
| Reflector + Curator | Spec 17 (night-shift self-healing) |
| SWE-Bench / LifelongAgentBench | Spec 14 verification gate |
| Self-play | New spec — adversarial testing |

---

## 8. Open Gaps Worth Investigating Further

- **The repo has hundreds of paper links** not fully enumerated here; the ones above are the high-signal subset. For a specific subsection (e.g., just memory), do a targeted second pass of the repo's §3.2 section.
- **No code** in the repo — it's purely a paper index. Implementation references live in each paper's own artifact.
- **Survey is pre-2026** (v4 of 2507.21046, 2025). Check arXiv for v5+ or a 2026 follow-up before making strategic bets.
- **License: Apache-2.0** — safe to fork and use as Arceus-internal reference.

---

## 9. Canonical Paper Shortlist (to actually read)

If you only read 10 papers from the full index, pick these:

1. **[Voyager (2305.16291)](https://arxiv.org/abs/2305.16291)** — lifelong skill library in code, foundational for Arceus's SkillArtifact-as-code move.
2. **Reflexion (Shinn et al. 2023)** — trajectory summarization; already half-implemented in Arceus.
3. **Self-Refine (Madaan et al. 2023)** — iterative critique; directly usable in verification gate.
4. **ToolFormer (Schick et al. 2023)** — tool use as self-supervised learning.
5. **ToolLLM (Qin et al. 2023)** — 16k-API tool integration — blueprint for external MCP.
6. **PromptBreeder (Fernando et al. 2023)** — genetic prompt evolution — direct ATA upgrade.
7. **TextGrad (Yuksekgonul et al. 2024)** — text as gradient — alternative ATA backend.
8. **Mem0 / MemInsight** — persistent memory systems — Hippocampus companions.
9. **EvoAgent (Yuan et al. 2024)** — multi-agent evolutionary generation — role-spawning reference.
10. **SEW (Self-Evolving Workflows)** — sprint-flow-as-object reference.

---

## 10. References

- Repo: [github.com/CharlesQ9/Self-Evolving-Agents](https://github.com/CharlesQ9/Self-Evolving-Agents)
- Paper (v4): [arxiv.org/abs/2507.21046](https://arxiv.org/abs/2507.21046)
- Paper PDF: [arxiv.org/pdf/2507.21046](https://arxiv.org/pdf/2507.21046)
- BibTeX: `@misc{gao2025surveyselfevolvingagentspath, ...}` (Apache-2.0)
- Voyager: [arxiv.org/abs/2305.16291](https://arxiv.org/abs/2305.16291)
- MineDojo/Voyager: [github.com/MineDojo/Voyager](https://github.com/MineDojo/Voyager)

---

## Methodology

This doc was synthesized from:
- Full README of the CharlesQ9/Self-Evolving-Agents repo (structure + paper list)
- Abstract of arXiv 2507.21046
- Full-text PDF extract of arXiv 2507.21046v4 (taxonomy, techniques, benchmarks, future directions)

**Not done** (would take dozens more fetches):
- Reading each individual paper linked in the repo (~200+)
- Fetching each domain-specific subsection

For a specific subsection deep-dive (e.g., just memory evolution), do a targeted second pass re-fetching §3.2 and following every arxiv link.
