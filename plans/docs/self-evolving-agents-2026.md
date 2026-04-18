# Self-Evolving Agents: Comprehensive Research Digest (mid-2025 → April 2026)

*Generated: 2026-04-18 | Sources: 80+ | Confidence: High on research frameworks and benchmarks, Medium on enterprise-deployment self-reports*

---

## Executive Summary

Between mid-2025 and April 2026 the self-evolving-agents field consolidated around three observations:

1. **The dominant axis of improvement shifted from pre-training scale to closing a feedback loop around a deployed agent.** Every major system with strong gains this window — SEAL, DGM/HGM, AZR, R-Zero, Agent0, AgentEvolver, GEPA, ACE, TTRL, TTC-RL — instantiates a *generation → reflection/verification → update* loop. The discriminating design choice became **what to evolve**: weights (SEAL, DGM), prompts/graphs (GEPA, MIPROv2, TextGrad, Trace), context playbook (ACE), training distribution (AZR/R-Zero/Agent0), or architecture (EvoAgent, HGM).

2. **"Zero-data" self-play with a verifier became the default recipe for capability expansion past human-curated benchmarks.** Code executors and math verifiers enabled AZR → R-Zero → Agent0. Open questions: difficulty-frontier stability, generalization beyond verifiable domains, and safety under open-ended self-modification.

3. **Production reality lags research by a wide margin.** Shipped systems are "static agent + growing memory store," not self-modifying policies. On lifelong-learning axes **even frontier models score 17.9/100** (LifelongAgentBench), **24% task completion** (TheAgentCompany), **42.1% pass@1** (Gaia2). SWE-Bench Verified is effectively deprecated after contamination audits; frontier models drop from 80.9% (Verified) to 45.9% (SWE-Bench Pro) on unseen code.

Anthropic's **Agent Skills** (Oct 16 2025, open standard Dec 18 2025) is the ecosystem-defining event of the window — its three-tier progressive disclosure architecture is now the reference pattern for skill packaging, with Simon Willison arguing it is "maybe a bigger deal than MCP."

---

## 1. New Surveys & Taxonomies (post-July 2025)

- **A Survey of Self-Evolving Agents: What, When, How, and Where to Evolve** — Fang/Gao et al., [arXiv:2507.21046](https://arxiv.org/abs/2507.21046). Canonical four-axis taxonomy; v4 revised Jan 2026. Baseline referent for almost all 2025-26 follow-on work.
- **A Comprehensive Survey of Self-Evolving AI Agents** — EvoAgentX group, [arXiv:2508.07407](https://arxiv.org/abs/2508.07407). Complementary taxonomy built around a *System Inputs / Agent System / Environment / Optimisers* feedback loop, with explicit domain track (biomedicine, programming, finance). Companion list: [EvoAgentX/Awesome-Self-Evolving-Agents](https://github.com/EvoAgentX/Awesome-Self-Evolving-Agents).
- **Lifelong Learning of LLM-based Agents: A Roadmap** — Zheng et al., [arXiv:2501.07278](https://arxiv.org/abs/2501.07278). Revised Jan 2026; accepted TPAMI 2026. Continual-learning framing across perception/memory/action, catastrophic forgetting, knowledge consolidation. List: [qianlima-lab/awesome-lifelong-llm-agent](https://github.com/qianlima-lab/awesome-lifelong-llm-agent).
- **Evolutionary Perspectives on Evaluation of LLM Agents** — [arXiv:2506.11102](https://arxiv.org/abs/2506.11102). Evaluation-focused; `[unverified — single source]`.
- **Memory in the Age of AI Agents** — [arXiv:2512.13564](https://arxiv.org/abs/2512.13564) + [Shichun-Liu/Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List). Canonical 2025-26 memory bibliography.
- Curated indexes: [XMU Awesome-Self-Evolving-Agents](https://github.com/XMUDeepLIT/Awesome-Self-Evolving-Agents); [ICLR 2026 Lifelong Agents workshop](https://lifelongagent.github.io/).

---

## 2. Self-Improvement / Policy-Evolution Frameworks

Systems that modify **weights or policy** at test-time or post-deployment.

| System | Date | Mechanism | Headline result |
|---|---|---|---|
| **SEAL** ([2506.10943](https://arxiv.org/abs/2506.10943), [code](https://github.com/Continual-Intelligence/SEAL)) | Jun 2025 (MIT) | Model emits "self-edit" specifying synthetic data + hyperparameters; outer RL loop on downstream accuracy | SQuAD no-ctx 33.5→47.0; ARC small subset 20%→72.5% |
| **Darwin-Gödel Machine (DGM)** ([2505.22954](https://arxiv.org/abs/2505.22954), [Sakana](https://sakana.ai/dgm/)) | May 2025 | Archive of agent variants; each proposes edits to its own codebase; Darwinian selection | SWE-bench 20.0→50.0; Polyglot 14.2→30.7 |
| **Huxley-Gödel Machine (HGM)** ([2510.21614](https://arxiv.org/abs/2510.21614)) | Oct 2025 (ICLR 2026 oral) | Introduces *Clade Metaproductivity*: scores agents by descendants' performance, not their own | Human-level SWE-bench Lite with GPT-5 |
| **Absolute Zero Reasoner (AZR)** ([2505.03335](https://arxiv.org/abs/2505.03335)) | May 2025 (NeurIPS spotlight) | Single model = proposer + solver under RLVR; code executor as verifier; **zero human data** | SOTA zero-data coding+math |
| **R-Zero** ([2508.05004](https://arxiv.org/abs/2508.05004)) | Aug 2025 (ICLR 2026) | Splits AZR into independent Challenger + Solver; Challenger rewarded for boundary-difficulty | +6.49 math / +7.54 general on Qwen3-4B-Base |
| **Agent0** ([2511.16043](https://arxiv.org/abs/2511.16043)) | Nov 2025 | Extends R-Zero to tool-using agents; tool availability pressures curriculum | +18% math / +24% general on Qwen3-8B-Base |
| **Self-Challenging Agents** ([2506.01716](https://arxiv.org/abs/2506.01716)) | Jun 2025 | Alternating challenger/executor with "Code-as-Task" verifier | +20.2% avg on 4 tool-use envs (Llama-3.1-8B) |
| **AgentEvolver** ([2511.10395](https://arxiv.org/abs/2511.10395), [code](https://github.com/modelscope/AgentEvolver)) | Nov 2025 | Self-questioning + self-navigating + self-attributing (per-step credit) | Focuses on sample efficiency vs. RL baselines |
| **TTRL** ([2504.16084](https://arxiv.org/abs/2504.16084)) | Apr/Jun 2025 | RL on unlabeled test inputs via majority-vote pseudo-reward | Qwen-2.5-Math-7B AIME24 pass@1 ~+211% |
| **TTC-RL** ([2510.04786](https://arxiv.org/html/2510.04786v1)) | Oct 2025 | Automatic test-time curriculum selection | Qwen3-8B AIME25 pass@1 ~1.8× |
| **Self-Rewarding follow-ups** | 2025 | Process-based ([2503.03746](https://arxiv.org/abs/2503.03746)), Temporal ([2508.06026](https://arxiv.org/abs/2508.06026)), Meta-Rewarding | Temporal: 19.69→29.44 on AlpacaEval 2 |

**Cross-cutting:** HGM's "Metaproductivity-Performance Mismatch" is the most important conceptual result of the window — **good benchmark performance ≠ good self-improvement potential**. Selecting agents by current score selects against improvement capacity.

---

## 3. Prompt / Architecture Evolution

Weights frozen; what evolves is **prompts, modules, or context**.

- **GEPA — Reflective Prompt Evolution** ([2507.19457](https://arxiv.org/abs/2507.19457), [dspy.GEPA](https://dspy.ai/api/optimizers/GEPA/overview/), [code](https://github.com/gepa-ai/gepa)). Genetic-Pareto search; mutation = NL reflection over full trajectories. **Beats GRPO by 6–20% with up to 35× fewer rollouts**; beats MIPROv2 by >10% (+12% AIME-2025). ICLR 2026 oral. This is the window's clearest signal that text-space optimization is a real alternative to RL fine-tuning for agentic pipelines.
- **TextGrad — Automatic Differentiation via Text** ([2406.07496](https://arxiv.org/abs/2406.07496), [Nature Mar 2025](https://hai.stanford.edu/news/textgrad-autograd-text), [code](https://github.com/zou-group/textgrad)). LLM-generated textual gradients backprop through compound LLM systems.
- **DSPy MIPROv2** ([docs](https://dspy.ai/api/optimizers/MIPROv2/)). Bayesian-optimization joint search over instructions + few-shots. Now the default strong baseline GEPA compares against.
- **ACE — Agentic Context Engineering** ([2510.04618](https://arxiv.org/abs/2510.04618), [SambaNova blog](https://sambanova.ai/blog/ace-open-sourced-on-github), [InfoQ](https://www.infoq.com/news/2025/10/agentic-context-eng/)). Stanford/SambaNova/UC Berkeley, Oct 2025. Treats context as an evolving playbook updated by **delta edits** rather than rewrites — explicitly prevents brevity bias and "context collapse." **+10.6% agents / +8.6% finance**; matches top AppWorld agent with smaller open model.
- **EvoAgent — Multi-Agent Generation via Evolutionary Algorithms** ([2406.14228](https://arxiv.org/abs/2406.14228), NAACL 2025). Prompts + agent configs as genomes; mutation/crossover builds multi-agent systems from a single seed.
- **Trace — "Trace is the New AutoDiff"** ([2406.16218](https://arxiv.org/html/2406.16218v2)). Optimizes non-differentiable workflows via execution traces + LLM updates. +10% over DSPy COPRO on BigBenchHard.
- **OpenAI Cookbook — Self-Evolving Agents / Autonomous Agent Retraining** ([cookbook](https://cookbook.openai.com/examples/partners/self_evolving_agents/autonomous_agent_retraining)). Industrial reference pattern comparing Platform Optimizer, static metaprompt loops, and GEPA for production retraining.
- PromptBreeder-lineage 2025: *ReflectivePrompt* (Aug 2025), *EvoTest* (Oct 2025). `[unverified]` — single summary reference each.

---

## 4. Memory Evolution

### Production frameworks

- **Mem0 / Mem0g** ([2504.19413](https://arxiv.org/abs/2504.19413), [site](https://mem0.ai/)). Extraction + consolidation pipeline; graph variant adds relational structure. Reports **26% response-quality improvement, >90% token reduction, 91% lower latency** vs. full-context on LOCOMO. **Selected as exclusive memory provider in AWS Strands Agent SDK** (May 2025) — [InfoWorld](https://www.infoworld.com/article/4026560/mem0-an-open-source-memory-layer-for-llm-applications-and-ai-agents.html).
- **Zep + Graphiti** ([2501.13956](https://arxiv.org/abs/2501.13956), [Graphiti GitHub](https://github.com/getzep/graphiti)). **Bitemporal** knowledge graph (event time vs. ingestion time). DMR 94.8% vs MemGPT 93.4%; context tokens 115k→1.6k; latency 29–31s→2.5–3.2s. Neo4j primary, FalkorDB/Kuzu/Neptune supported.
- **Letta (née MemGPT)** — Platform evolution: [Letta v1 agent loop](https://www.letta.com/blog/letta-v1-agent) (Oct 2025) rearchitected for frontier reasoning models; [Sleep-time compute](https://www.letta.com/blog/sleep-time-compute) shipped in 0.7.0 (5× lower inference, 2.5× lower cost/query, up to +18% accuracy); **Conversations API** (Jan 2026) for shared memory across parallel sessions; [Letta Code](https://www.letta.com/blog/letta-code) (Dec 2025) — #1 open-source model-agnostic agent on Terminal-Bench; [Letta Code app](https://www.letta.com/blog/introducing-the-letta-code-app) (Apr 2026).
- **Sleep-time compute** ([2504.13171](https://arxiv.org/html/2504.13171v1)). Formalizes offline context restructuring between queries.
- **LangMem SDK** ([launch blog](https://blog.langchain.com/langmem-sdk-launch/), [docs](https://langchain-ai.github.io/langmem/)). Memory Managers + Prompt Optimizers; three-type taxonomy (episodic / semantic / procedural).

### Research — consolidation and evolution

- **A-Mem** ([2502.12110](https://arxiv.org/abs/2502.12110), Feb 2025). Zettelkasten-inspired dynamic indexing/linking; new memories **mutate existing ones** rather than append. Claims SOTA across six foundation models.
- **MemInsight** ([2503.21760](https://arxiv.org/abs/2503.21760), Amazon Mar 2025, EMNLP 2025). Autonomous semantic augmentation. +14% persuasiveness on LLM-REDIAL; +34% recall vs. RAG on LoCoMo.
- **MemGen** ([2509.24704](https://arxiv.org/pdf/2509.24704), Sep 2025). Generative *latent* memory: Memory Trigger + Memory Weaver interleave latent tokens with reasoning. **+38.22%** over traditional memory systems; spontaneously develops planning/procedural/working sub-structures.
- **MemEvolve** ([2512.18746](https://arxiv.org/abs/2512.18746), Dec 2025). *Meta*-evolution: jointly evolves experience AND memory architecture. **+17.06%** on SmolAgent / Flash-Searcher; cross-task/cross-LLM generalization.
- **Mem^p** ([2508.06433](https://arxiv.org/html/2508.06433v2), Aug 2025). Procedural-memory focused.
- **LightMem** ([2510.18866](https://arxiv.org/html/2510.18866v1), Oct 2025). Efficient memory-augmented generation.

---

## 5. Skill Acquisition

### Anthropic Agent Skills — the ecosystem event of the window

- **Launch — Oct 16, 2025**. [Anthropic news](https://www.anthropic.com/news/skills) + [engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).
- **Architecture** — SKILL.md + optional scripts/resources. **Three-tier progressive disclosure**: name+description (~20–50 tokens) at startup; full instructions only when activated; reference files/scripts only when instructions demand them. [Platform docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).
- **Open standard — Dec 18, 2025**. [VentureBeat](https://venturebeat.com/technology/anthropic-launches-enterprise-agent-skills-and-opens-the-standard).
- **Simon Willison** ([Oct 16, 2025](https://simonwillison.net/2025/Oct/16/claude-skills/)): *"Claude Skills are awesome, maybe a bigger deal than MCP"* — MCP's token-overhead is its weak point; progressive disclosure is the decisive win.
- **Ecosystem scale (early 2026)** — "85,000+ public Agent Skills, 27 major platforms supporting the standard" `[unverified — single Infostreamly source]`.
- **Community registries** — [obra/superpowers](https://github.com/obra/superpowers) (Oct 2025), [obra/superpowers-skills](https://github.com/obra/superpowers-skills), [anthropics/skills](https://github.com/anthropics/skills) (skill-creator, MCP-server-generation, document-format skills).

### Skill-library research (Voyager lineage applied to code/web)

- **SkillWeaver** ([2504.07079](https://arxiv.org/abs/2504.07079), OSU-NLP Apr 2025, [code](https://github.com/OSU-NLP-Group/SkillWeaver)). Proposal → Synthesis → Honing loop synthesizes reusable Python APIs from practice trajectories. **+31.8% on WebArena, +39.8% on real sites; weak agents gain up to +54.3%** when given strong-agent-synthesized APIs.
- **AutoSkill** ([ECNU-ICALK repo](https://github.com/ECNU-ICALK/AutoSkill)). Online extraction–maintenance–reuse lifecycle; versioned skills from real user chat traces.
- **Agentic Context Engineering (ACE)** — overlaps skills and context evolution; see §3.
- **Agent Skills for LLMs — Architecture, Acquisition, Security, Path Forward** ([2602.12430](https://arxiv.org/html/2602.12430v3)). Survey treating "skills" as bundles of instructions + workflows + scripts + docs.
- **RL for Self-Improving Agent w/ Skill Library** ([2512.17102](https://arxiv.org/abs/2512.17102)). CodeAct-based; RL loop grows/refines tool-use skill library.
- **MindForge** ([2411.12977](https://arxiv.org/html/2411.12977v1)). Voyager + theory-of-mind + NL inter-agent communication.

**Honest note — Voyager lineage**: the original Minecraft pattern (hand-designed curriculum + code skill library + self-verification) **has not scaled as a standalone research program**. Its decomposition — curriculum from weaknesses, reusable programmatic skills, self-verification — has instead been absorbed into the broader self-evolving stack (AZR, R-Zero, Agent0, AgentEvolver, SkillWeaver, ACE), typically with *learned* curricula rather than hand-prompted ones.

---

## 6. Tool Evolution + MCP Ecosystem

### MCP through April 2026

- **MCP Registry preview — Sep 8, 2025**. [Blog](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/). Minimal upstream feed; subregistries layer UX.
- **One Year of MCP — Nov 25, 2025**. [Blog](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/). Formal governance, Working Groups, Spec Enhancement Proposals.
- **Scale (Dec 2025)** — ~97M monthly SDK downloads, 10,000+ active MCP servers in production `[single-source, treat cautiously]`. [2026 roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/).
- **2026 roadmap priorities** — stateful sessions that don't fight load balancers; `.well-known` discoverability; horizontal scaling of transport layer. [The New Stack](https://thenewstack.io/model-context-protocol-roadmap-2026/).
- **Production reference — Pinterest** deployed MCP at scale for internal agent workflows (Apr 2026). [InfoQ](https://www.infoq.com/news/2026/04/pinterest-mcp-ecosystem/).
- **Governance transfer** — Anthropic donating MCP to an Agentic AI Foundation. [Anthropic news](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation).

### Tool retrieval and synthesis

- **ToolGen** (ICLR 2025, [paper](https://openreview.net/pdf?id=XLMAMmowdY)). Represents each tool as a unique token inside the LM vocabulary; scales to 47,000+ tools.
- **Tool-RAG / Toolshed** ([Red Hat](https://next.redhat.com/2025/11/26/tool-rag-the-next-breakthrough-in-scalable-ai-agents/), [Toolshed paper](https://www.scitepress.org/Papers/2025/133030/133030.pdf)). **+46% / +56% / +47% Recall@5** on ToolE single/multi-tool and Seal-Tools.
- **Tool-to-Agent Retrieval** ([2511.01854](https://arxiv.org/html/2511.01854v1), Nov 2025). Embeds tools + parent agents in shared space. **+19.4% Recall@5, +17.7% nDCG@5** on LiveMCPBench.
- **Online-Optimized RAG for Tool Use** ([2509.20415](https://arxiv.org/html/2509.20415v1)).
- **Self-Tooling Agent (STA)** ([OpenReview](https://openreview.net/forum?id=VnMcTvEqhd)). LLM dynamically chooses between invoking existing tools and synthesizing new specialized ones.
- **Tool-R0** ([2602.21320](https://arxiv.org/html/2602.21320v1)). Self-play Generator/Solver co-evolution for tool-use RL with zero seed data.
- **ToolTweak** ([2510.02554](https://arxiv.org/html/2510.02554)). Adversarial security work on tool selection.

---

## 7. Benchmark State of the Art

**The defining story: benchmark contamination.** OpenAI's late-2025 audit showed every frontier model could reproduce gold patches from SWE-Bench Verified. **OpenAI stopped reporting Verified scores**, recommending SWE-Bench Pro — [Scale SWE-Bench Pro blog](https://scale.com/blog/swe-bench-pro), [Morph LLM analysis](https://www.morphllm.com/swe-bench-pro). Same model drops from 80.9% (Verified, Claude Opus 4.5) to **45.9% on SWE-Bench Pro** on unseen code.

| Benchmark | SOTA April 2026 | System | Source |
|---|---|---|---|
| SWE-Bench Verified | 93.9% (self-reported preview) | Claude Mythos Preview | [llm-stats](https://llm-stats.com/benchmarks/swe-bench-verified) |
| SWE-Bench Verified (audited) | ~80.9% | Claude Opus 4.5 | [codeant.ai](https://www.codeant.ai/blogs/swe-bench-scores) |
| SWE-Bench Pro (public) | ~46% top, ~23% median | Frontier models | [Scale Labs leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public) |
| Terminal-Bench 2.0 | 82% (preview); 58.75% (Factory Droid) | Claude Mythos / Droid | [tbench.ai](https://www.tbench.ai/leaderboard/terminal-bench/2.0) |
| GAIA v2 (Gaia2) | **42.1% pass@1** | GPT-5 (high) | [Gaia2 OpenReview](https://openreview.net/forum?id=9gw03JpKK4) |
| OSWorld-Verified | 72.7% (Opus 4.6); 75.0% (GPT-5.4 self-report) | Claude / GPT-5.4 | [o-mega guide](https://o-mega.ai/articles/the-2025-2026-guide-to-ai-computer-use-benchmarks-and-top-ai-agents) |
| τ-bench | <50% pass^k reliability | GPT-4o-class | [τ-bench paper](https://arxiv.org/abs/2406.12045) |
| **LifelongAgentBench** | **17.9/100** | GPT-5 | [2505.11942](https://arxiv.org/abs/2505.11942) |
| **TheAgentCompany** | **24% task completion** | Claude 3.5 Sonnet | [site](https://the-agent-company.com/) / [CMU news](https://www.cs.cmu.edu/news/2025/agent-company) |

### New self-evolution benchmarks

- **LifelongAgentBench** ([2505.11942](https://arxiv.org/abs/2505.11942), May 2025). First skill-grounded lifelong benchmark (DB/OS/KG); shows experience replay is **mostly ineffective** for LLM agents due to context limits; proposes group self-consistency.
- **MemoryArena / MemoryAgentBench / AMA-Bench** — [Memory survey](https://arxiv.org/abs/2512.13564). Sequential causally-dependent subtasks probing retrieval, test-time learning, long-range understanding, selective forgetting.
- **SWE-EVO** ([2512.18470](https://arxiv.org/html/2512.18470v2), Dec 2025). Long-horizon software-evolution coding tasks.
- **Experience-Driven Lifelong Learning** ([2508.19005](https://arxiv.org/html/2508.19005v5)).
- **LIVE-SWE-AGENT** ([2511.13646](https://arxiv.org/pdf/2511.13646)). On-the-fly SWE-agent self-evolution.
- **ICLR 2026 Lifelong Agents Workshop** — [lifelongagent.github.io](https://lifelongagent.github.io/).

**The clear signal: on lifelong/self-evolving axes, frontier models score in the teens to low 40s.** SWE-Bench-style patch generation is near-saturated; genuine continual learning is not.

---

## 8. Production Systems — Memory vs. Evolution

**Sharp distinction:** memory ≠ evolution. Most "agents with memory" are **static policies with a retrieval cache**. True self-evolution requires persistent skill/prompt/tool modification.

### Has memory (static policy + retrieval)

| System | Memory | Self-evolves? | Source |
|---|---|---|---|
| **Claude Code** | SKILL.md dynamic load | ❌ user-authored skills | [Agent Skills engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) |
| **Cursor Memory Bank** | File-based persistent context | ❌ user-curated | [vanzan01/cursor-memory-bank](https://github.com/vanzan01/cursor-memory-bank) |
| **Windsurf Cascade** | Session/project scope + SWE-1.5 (40.08% SWE-Bench @ 950 tok/s) | ❌ | [Dextra comparison](https://dextralabs.com/blog/claude-code-vs-cursor-vs-windsurf/) |
| **Devin** (Cognition) | Project memory | ❌ not publicly documented | [SWE-bench report](https://cognition.ai/blog/swe-bench-technical-report) |
| **Google Jules / Gemini CLI** | Async VM-based on Gemini 3 Pro | ❌ no skill-learning loop | [Google blog](https://developers.googleblog.com/jules-gemini-3/) |
| **OpenAI Codex / Codex CLI** | 2M WAU by Mar 2026; GPT-5.3/5.4-Codex | ❌ no public mechanism | [Codex page](https://openai.com/codex/) |
| **OpenHands** | $18.8M Series A Nov 2025; 87% same-day bug resolution | ❌ composable SDK, static policy | [Series A](https://www.businesswire.com/news/home/20251118768131/) |
| **GitLab Duo Agent Platform** | GA 2026; runs Claude Code + Codex CLI as external agents | ❌ | [GitLab IR](https://ir.gitlab.com/news/news-details/2026/GitLab-Announces-the-General-Availability-of-GitLab-Duo-Agent-Platform/default.aspx) |
| **Replit Agent 3** | 200-min autonomous runtime; project-scoped memory | ❌ | [Replit blog](https://blog.replit.com/introducing-agent-3-our-most-autonomous-agent-yet) |

### Actually evolves skills/prompts/tools

- **Amazon Bedrock AgentCore Memory** — added **episodic memory** ("learn from experiences") GA across late-2025/Q1 2026. Paired with **AgentCore Evaluations** (GA Mar 31 2026) closes basic feedback loop — but the "learning" is *memory persistence*, not autonomous skill synthesis. [AWS blog](https://aws.amazon.com/blogs/aws/amazon-bedrock-agentcore-adds-quality-evaluations-and-policy-controls-for-deploying-trusted-ai-agents/).
- **OpenSpace** (HKUDS, open-source) — skills continuously evolve; **46% fewer tokens, 4.2× performance** self-reported across Claude Code / OpenClaw wrappers. [HKUDS/OpenSpace](https://github.com/HKUDS/OpenSpace). `[self-reported]`
- **Memento-Skills / SkillRL / SAGE** — research systems where the agent rewrites executable tools and an RL loop promotes successful skills. [SkillRL](https://github.com/aiming-lab/SkillRL), [SAGE 2512.17102](https://arxiv.org/abs/2512.17102), [VentureBeat coverage](https://venturebeat.com/orchestration/new-framework-lets-ai-agents-rewrite-their-own-skills-without-retraining-the). None are shipping at enterprise scale.
- **OpenAI Self-Evolving Agents cookbook** ([link](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining)) — explicit recipe, positioned as reference not product.

**Bottom line:** in production, the dominant paradigm is "static agent + growing memory store." Actual prompt/skill/tool self-modification remains research-grade.

---

## 9. Integration Patterns — The April 2026 Production Stack

Consensus stack across Spring AI pattern series, Supermemory VP-Eng guide, Mem0 State of AI Agent Memory 2026, and Letta Code architecture:

1. **Three-layer separation**
   - **Tools** (MCP servers + self-authored helpers) — the I/O surface.
   - **Skills** (progressive-disclosure folders) — procedural memory describing *how* to use tools.
   - **Memory** (episodic + semantic, vector+graph hybrid) — *what the agent knows*.
   Sources: [Spring AI Generic Agent Skills](https://spring.io/blog/2026/01/13/spring-ai-generic-agent-skills/); [Spring AI Memory Tools](https://spring.io/blog/2026/04/07/spring-ai-agentic-patterns-6-memory-tools/); [Supermemory VP-Eng guide](https://blog.supermemory.ai/agentic-workflows-vp-engineering-guide/).

2. **Memory-as-tool pattern** — Agents manage memory through tools scoped to a sandboxed directory (index MEMORY.md + per-topic Markdown files). Architecturally identical to what Claude Code itself does; now dominant in Spring AI 2026 guidance.

3. **Hybrid vector + graph storage** — Mem0 + Postgres for facts/episodic; Graphiti + Neo4j (or FalkorDB/Kuzu) for temporal relational reasoning. [Atlan head-to-head](https://atlan.com/know/zep-vs-mem0/): Zep wins temporal reasoning and multi-entity queries; Mem0 wins dev-experience and latency.

4. **Offline consolidation loop** — Sleep-time compute (Letta), ACE's Generator/Reflector/Curator playbook evolution, MemGen/MemEvolve latent consolidation. Shared pattern: collect trajectories → offline LLM pass → update a durable artifact (memory, context, or skill).

5. **Skill ↔ MCP complementarity** — Widely cited (Willison; [DEV "MCP vs Agent Skills"](https://dev.to/phil-whittaker/mcp-vs-agent-skills-why-theyre-different-not-competing-2bc1)): MCP exposes *tools*; Skills teach *workflows*. Skills' progressive disclosure compensates for MCP's token-bloat problem when a registry has 100s of servers.

6. **Tool-retrieval tier** — At enterprise scale (100s–1000s of tools), Tool-RAG / Tool-to-Agent retrieval is becoming required infrastructure; vector-only search on tool descriptions has measurable false-negative issues.

---

## 10. Evaluation & Observability for Evolving Agents

- **Langfuse acquired by ClickHouse — Jan 16, 2026** at ~$15B round (ClickHouse Series D $400M led by Dragoneer). Langfuse keeps OSS/self-hosting; architecture was already ClickHouse-backed. 2,000+ paying customers, 19 of Fortune 50. [Langfuse announcement](https://langfuse.com/blog/joining-clickhouse); [ClickHouse](https://clickhouse.com/blog/clickhouse-raises-400-million-series-d-acquires-langfuse-launches-postgres); [InfoWorld](https://www.infoworld.com/article/4118621/clickhouse-buys-langfuse-as-data-platforms-race-to-own-the-ai-feedback-loop.html).
- **LangSmith** — deep LangGraph 1.0 integration (Oct 2025); annotation queues feed datasets. [LangChain 1.0 blog](https://www.langchain.com/blog/langchain-langgraph-1dot0).
- **Braintrust** — prompt-centric eval with CI/CD deployment blocking; statistical comparisons. [Guide](https://www.braintrust.dev/articles/best-llm-tracing-tools-2026).
- **Arize Phoenix** — OpenTelemetry-native; most portable for polyglot stacks.
- **Inspect (UK AISI)** — 100+ built-in evals; supports Claude Code/Codex CLI/Gemini CLI as external agents; includes GAIA, SWE-Bench, GDM CTF, Cybench; 2025 sandboxing toolkit. [inspect.aisi.org.uk](https://inspect.aisi.org.uk/); [Inspect Evals GitHub](https://github.com/UKGovernmentBEIS/inspect_evals).
- **AgentCore Evaluations** — 13 built-in evaluators, GA Mar 31, 2026 — first hyperscaler-native agent-eval service.

**Honest gap:** No vendor ships a turnkey "skill-version regression" view. The assembled pattern is LangGraph checkpointing + LangSmith annotation + Braintrust statistical diff.

---

## 11. Cross-Cutting Synthesis

### The three big shifts (mid-2025 → April 2026)

1. **Feedback-loop over scale** — optimization effort moved from pre-training to post-deployment loops. The knob that matters: *what* to evolve — weights, prompts, context, curriculum, or architecture.

2. **Zero-data self-play is the default capability-expansion recipe** in verifiable domains (code, math). Open questions: frontier-difficulty stability, generalization past verifier-rich domains, and safety under open-ended self-modification.

3. **Production lags research by a wide margin** on self-evolution specifically. Memory shipped at scale; skills shipped as a packaging standard (Agent Skills); autonomous skill/tool/prompt *mutation* remains research-grade.

### Emerging coupling

Expect **2026 headline systems to couple three loops**: ACE-style evolving context + SEAL-style weight self-edits + GEPA-style reflective prompt search inside one deployment loop. Memory (2501.07278 roadmap, MemEvolve, ACE playbook) is quietly becoming the binding mechanism that lets prompt evolution, policy evolution, and skill libraries co-exist in a long-lived agent.

### Unaddressed challenges

- **Safety of self-evolution** — if skills auto-promote to production (OpenSpace-style), who authorizes a behavior change? [AgentCore Policy](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-bedrock-agentcore-policy-evaluations-preview/) (Cedar-based, GA Mar 2026) is the earliest hyperscaler answer.
- **HGM's Metaproductivity-Performance Mismatch** — selecting agents by current score mis-selects their self-improvement capacity. Gao and EvoAgentX surveys both flag this; no mature solution.
- **Skill-version regression testing** — no turnkey product category.
- **τ-bench reliability** — production agents in multi-turn customer domains remain inconsistent across trials (pass^k <50%).

---

## 12. Unverified or Self-Reported Claims (Flagged)

- WebArena 71.2% top figure (single source).
- Claude Mythos Preview SWE-Bench Verified 93.9% and Terminal-Bench 82% (preview, self-reported).
- GPT-5.4 OSWorld 75.0% (OpenAI self-reported Mar 5, 2026).
- OpenSpace 4.2× / 46% token reduction (project-reported).
- "85,000 public Agent Skills, 27 platforms" (single-source Infostreamly).
- MCP scale figures (97M monthly downloads, 10k+ servers) — single-source MCP roadmap.
- *Mem0-v2* as a named release — does not appear to exist; Mem0 iterates without "v2" branding.
- *ATLASS*, *Agent-K* — did not surface credible sources; possibly misremembered names.
- *ReflectivePrompt*, *EvoTest*, *WebXSkill*, *EffiSkill*, *Evolutionary Perspectives Survey* — single-source each.

---

## 13. Canonical Reading Shortlist

The ~15 papers/resources to read first:

1. [Fang/Gao SEA Survey](https://arxiv.org/abs/2507.21046) — taxonomy baseline
2. [EvoAgentX Survey](https://arxiv.org/abs/2508.07407) — complementary taxonomy
3. [Lifelong LLM Agents Roadmap](https://arxiv.org/abs/2501.07278) — TPAMI 2026
4. [SEAL](https://arxiv.org/abs/2506.10943) — weight self-edit
5. [Darwin-Gödel Machine](https://arxiv.org/abs/2505.22954) — agent archive + Darwinian
6. [Huxley-Gödel Machine](https://arxiv.org/abs/2510.21614) — Metaproductivity insight
7. [Absolute Zero Reasoner](https://arxiv.org/abs/2505.03335) — zero-data self-play
8. [R-Zero](https://arxiv.org/abs/2508.05004) / [Agent0](https://arxiv.org/abs/2511.16043) — challenger-solver split + tool extension
9. [GEPA](https://arxiv.org/abs/2507.19457) — reflective prompt evolution beats RL
10. [ACE](https://arxiv.org/abs/2510.04618) — evolving context playbook
11. [Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — production packaging standard
12. [Mem0](https://arxiv.org/abs/2504.19413) / [Zep](https://arxiv.org/abs/2501.13956) — production memory
13. [Sleep-time compute](https://arxiv.org/abs/2504.13171) — offline consolidation
14. [MemEvolve](https://arxiv.org/abs/2512.18746) — meta-evolution of memory architecture
15. [SkillWeaver](https://arxiv.org/abs/2504.07079) — Voyager applied to web
16. [LifelongAgentBench](https://arxiv.org/abs/2505.11942) — the reality check

---

## Methodology

Three parallel research agents (general-purpose) executed web search + web fetch across:
- Core self-evolution papers and surveys (mid-2025 → April 2026)
- Memory, skill, and tool evolution frameworks
- Production deployments and benchmark results

Each agent produced 15–20 sourced bullets; this digest is the synthesis. Claims with single-source backing are flagged `[unverified]`. Self-reported vendor metrics are flagged separately in §12. Publication dates prioritized for recency (preference for post-July-2025).

Gaps acknowledged: some 2026-branded preprints (e.g., WebXSkill, EffiSkill) have single-source backing and may reflect submission-dated arxiv IDs rather than published work; treat their specific numbers with skepticism.
