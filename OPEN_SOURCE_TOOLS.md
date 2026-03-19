# Arceus — Open Source Tools & Agent Ecosystem Research

> **Date**: March 2026  
> **Purpose**: Survey of open-source tools, agent frameworks, memory systems, specialized agents, and supporting infrastructure for the Arceus platform.

---

## Table of Contents

1. [Agent Frameworks & Orchestration](#1-agent-frameworks--orchestration)
2. [Memory Systems](#2-memory-systems)
3. [Coding Agents](#3-coding-agents)
4. [Web Agents & Scraping](#4-web-agents--scraping)
5. [Search & Research APIs](#5-search--research-apis)
6. [Tool Platforms & Integrations](#6-tool-platforms--integrations)
7. [Structured Outputs](#7-structured-outputs)
8. [Code Execution Sandboxes](#8-code-execution-sandboxes)
9. [Lightweight / Specialized Frameworks](#9-lightweight--specialized-frameworks)
10. [Comparison Matrix](#10-comparison-matrix)
11. [Arceus-Specific Recommendations](#11-arceus-specific-recommendations)

---

## 1. Agent Frameworks & Orchestration

### 1.1 OpenAI Agents SDK
- **Stars**: 20.1k | **License**: MIT | **Install**: `pip install openai-agents`
- **What**: Lightweight, provider-agnostic multi-agent framework from OpenAI
- **Core Concepts**: Agents, Handoffs, Tools (functions, MCP, hosted), Guardrails, Sessions, Tracing, Realtime voice
- **Key Features**:
  - Supports 100+ LLMs via LiteLLM
  - Both Responses API and Chat Completions backends
  - Built-in tracing and guardrails
  - Simple: `Agent(name, instructions)` + `Runner.run_sync(agent, task)`
- **Best For**: Lightweight agent orchestration with OpenAI-native feel
- **Arceus Fit**: Good for SpawnedAgent layer — minimal overhead, direct tool calling

### 1.2 AutoGen (Microsoft)
- **Stars**: 55.8k | **License**: MIT | **Install**: `pip install "autogen-agentchat" "autogen-ext[openai]"`
- **What**: Multi-agent AI framework with layered architecture
- **Layers**: Core API (message passing, distributed runtime) → AgentChat (rapid prototyping, group chats) → Extensions (OpenAI, Azure clients)
- **Key Features**:
  - AutoGen Studio (no-code GUI)
  - Magentic-One (multi-agent team for web/code/file tasks)
  - MCP support
  - **Note**: Now recommends migrating to Microsoft Agent Framework
- **Best For**: Research prototyping, multi-agent group chat patterns
- **Arceus Fit**: Reference architecture, but prefer lighter frameworks for production

### 1.3 LangGraph
- **Stars**: 26.7k | **License**: MIT | **Install**: `pip install langgraph`
- **What**: Low-level stateful agent orchestration by LangChain
- **Key Features**:
  - Durable execution (survives failures)
  - Human-in-the-loop workflows
  - Comprehensive memory (short-term + long-term)
  - LangSmith debugging and observability
  - Deep Agents (subagent planning + delegation)
  - Inspired by Pregel/Apache Beam graph model
- **Best For**: Complex stateful workflows, production orchestration
- **Arceus Fit**: Strong candidate for Meeting orchestration and multi-step task flows

### 1.4 CrewAI
- **Stars**: 46.3k | **License**: MIT | **Install**: `pip install crewai`
- **What**: Role-based autonomous agent teams + event-driven flows
- **Key Features**:
  - **Crews**: Autonomous agents with roles, goals, backstories
  - **Flows**: Event-driven `@start`, `@listen`, `@router` decorators, `or_`/`and_` operators
  - YAML-based agent/task configuration
  - Sequential and hierarchical processes
  - Standalone (no LangChain dependency), 5.76x faster than LangGraph in some benchmarks
  - CrewAI AMP Suite (enterprise control plane)
- **Best For**: Role-based teams with defined goals — maps well to org hierarchies
- **Arceus Fit**: **HIGH** — Crew model maps directly to Arceus Employee/Team structure. CEO assigns tasks to specialized crews.

### 1.5 PydanticAI
- **Stars**: 15.5k | **License**: MIT | **Install**: `pip install pydantic-ai`
- **What**: "FastAPI for GenAI" — type-safe agent framework from the Pydantic team
- **Key Features**:
  - Model-agnostic (OpenAI, Anthropic, Gemini, Azure, Bedrock, Ollama, 30+ providers)
  - Dependency injection via `RunContext`
  - Structured outputs with Pydantic validation
  - MCP, A2A (Agent-to-Agent), and UI event stream support
  - Human-in-the-loop tool approval
  - Durable execution
  - Graph support for complex control flows
  - Pydantic Logfire for observability (OpenTelemetry)
  - Built-in evals system (`pydantic_evals`)
- **Best For**: Production-grade agents with strong typing and observability
- **Arceus Fit**: **EXCELLENT** — Type safety, DI pattern, structured outputs match Arceus's need for reliable, validated agent outputs. Evals for Verifier loop.

### 1.6 Agno (formerly PhiData)
- **Stars**: 38.8k | **License**: Apache-2.0 | **Install**: `pip install agno`
- **What**: Runtime for agentic software — build, run, manage at scale
- **Architecture**:
  - **Framework**: Agents, teams, workflows with memory, knowledge, guardrails, 100+ integrations
  - **Runtime**: Stateless, session-scoped FastAPI backend (AgentOS)
  - **Control Plane**: AgentOS UI for monitoring, testing, management
- **Key Features**:
  - Per-user, per-session isolation
  - 50+ APIs and background execution
  - Approval workflows, human-in-the-loop
  - Native tracing and audit logs
  - Guardrails + evaluations in the agent loop
  - MCP tool support
  - Production-ready in ~20 lines of code
- **Best For**: Production deployment of agent systems at scale
- **Arceus Fit**: **HIGH** — AgentOS model aligns with Arceus's need for per-Startup isolation and production serving. Reference for runtime design.

---

## 2. Memory Systems

### 2.1 Mem0
- **Stars**: 50.2k | **License**: Apache-2.0 | **Install**: `pip install mem0ai`
- **What**: "Memory Layer for Personalized AI"
- **Key Features**:
  - Multi-level memory: User, Session, Agent state
  - +26% accuracy vs OpenAI Memory, 91% faster, 90% fewer tokens
  - Integrates with LangGraph, CrewAI
  - Self-hosted or cloud API
  - Simple: `memory.add(messages, user_id=...)` / `memory.search(query, user_id=...)`
- **Arceus Fit**: **HIGH** — Multi-level memory maps to Arceus's MemoryUnit/WorkingMemory/Hippocampus layers

### 2.2 Zep
- **Stars**: 4.2k | **License**: Business Source (Cloud primary)
- **What**: "Context Engineering Platform"
- **Key Features**:
  - Temporal knowledge graph (Graphiti)
  - Relationship-aware retrieval
  - <200ms latency
  - Graph RAG
  - SDKs: Python, TypeScript, Go
  - **Note**: Community Edition deprecated → Cloud only
- **Arceus Fit**: Graphiti knowledge graph concept valuable for Pattern extraction, but cloud-only is limiting

### 2.3 Letta (formerly MemGPT)
- **Stars**: 21.6k | **License**: Apache-2.0 | **Install**: `pip install letta-client`
- **What**: Stateful agents with advanced memory + self-improvement
- **Key Features**:
  - `memory_blocks` (human/persona labels)
  - Model-agnostic (recommends Claude Opus 4.5 / GPT-5.2)
  - Letta Code CLI
  - Full API + SDKs
  - Self-editing memory — agents update their own context
- **Arceus Fit**: Self-improving memory concept aligns with Arceus's self-evolving Knowledge → Pattern extraction

---

## 3. Coding Agents

### 3.1 SWE-agent
- **Stars**: 18.8k | **License**: MIT | **Install**: via pip/source
- **What**: Autonomous agent that fixes GitHub issues using LLMs
- **Key Features**:
  - State of the art on SWE-bench (open-source)
  - Free-flowing, leaves maximal agency to the LM
  - Configurable via single YAML file
  - Also: offensive cybersecurity (EnIGMA), competitive coding
  - **Note**: Team now recommends **mini-SWE-agent** (65% on SWE-bench verified in 100 lines of Python!)
  - Built by Princeton/Stanford researchers
- **Arceus Fit**: Reference for CodingEmployee behavior — spawns agents to fix code issues

### 3.2 Aider
- **Stars**: 42.1k | **License**: Apache-2.0 | **Install**: `pip install aider-install`
- **What**: AI pair programming in your terminal
- **Key Features**:
  - Works with Claude 3.7, DeepSeek R1, GPT-4o, o1, o3-mini, and 100+ LLMs
  - **Repo map**: Maps entire codebase for large project awareness
  - 100+ programming languages
  - Git integration with auto-commits
  - IDE integration (watch mode, comment-driven)
  - Images & web pages as context
  - Voice-to-code
  - Automatic linting & testing
  - 15B+ tokens/week processed community-wide
- **Arceus Fit**: **HIGH** — Repo-map concept directly applicable to Arceus CodingEmployee. Aider's architecture (edit/apply/verify cycle) maps to AgentFlow.

### 3.3 OpenHands (formerly OpenDevin)
- **Stars**: 69.3k | **License**: MIT | **Install**: Docker / pip
- **What**: AI-driven development platform — full-stack coding agent
- **Components**:
  - **Software Agent SDK**: Composable Python library for defining agents
  - **CLI**: Claude Code / Codex-like terminal experience
  - **Local GUI**: Devin-like browser interface with REST API
  - **Cloud**: Hosted version with Slack, Jira, Linear integrations
  - **Enterprise**: Self-hosted in VPC via Kubernetes
- **Key Features**:
  - Multi-user support, RBAC, conversation sharing
  - Integrations: Slack, Jira, Linear
  - Benchmark scores published openly
  - Free tier with MiniMax model
- **Arceus Fit**: **HIGH** — Full-stack coding agent model. SDK is reusable. Linear/Jira integration pattern valuable for Arceus's ticket system.

---

## 4. Web Agents & Scraping

### 4.1 browser-use
- **Stars**: 81.1k | **License**: MIT | **Install**: `pip install browser-use`
- **What**: AI browser automation with Playwright
- **Key Features**:
  - Simple: `Agent(task="...", llm=ChatBrowserUse(), browser=browser)`
  - Cloud or local browsers
  - CLI for persistent browser automation (`browser-use open`, `click`, `type`, `screenshot`)
  - Claude Code skill integration
  - Templates: default, advanced, tools
  - Custom tools support
  - Form-filling, shopping, research demos
- **Arceus Fit**: **CRITICAL** — Primary tool for WebEmployee/ResearchEmployee agents. Enables web interaction, data gathering, form filling.

### 4.2 Firecrawl
- **Stars**: 94.3k | **License**: AGPL-3.0 (SDKs: MIT) | **Install**: `pip install firecrawl-py`
- **What**: Turn any website into LLM-ready data (markdown, JSON, screenshots)
- **Key Features**:
  - **Scrape**: URL → markdown/HTML/JSON/screenshot, JS rendering, proxy handling
  - **Search**: Web search + full page content
  - **Browse**: Secure browser sessions with code execution
  - **Map**: Discover all URLs on a site
  - **Crawl**: Scrape entire websites async
  - **Agent**: "Describe what you need" autonomous data gathering
  - Structured data extraction with Pydantic schemas
  - Actions: click, scroll, type, wait before scraping
  - Batch processing thousands of URLs
  - MCP server available
  - SDKs: Python, Node.js, Java, Go, Rust
- **Arceus Fit**: **CRITICAL** — Core web data pipeline. Scrape → extract structured data for ResearchEmployee, DataEmployee.

### 4.3 Crawl4AI
- **Stars**: 62.1k | **License**: Apache-2.0 | **Install**: `pip install crawl4ai`
- **What**: Open-source LLM-friendly web crawler & scraper
- **Key Features**:
  - Async-first: `AsyncWebCrawler` with `arun()`
  - Deep crawling: BFS, DFS, Best-First strategies
  - Crash recovery with `resume_state` + `on_state_change`
  - Prefetch mode (5-10x faster URL discovery)
  - LLM extraction with questions
  - CLI: `crwl` command with markdown/JSON output
  - Docker deployment with monitoring dashboard
  - Self-hosted (no API key required)
- **Arceus Fit**: **HIGH** — Self-hosted alternative to Firecrawl. No API cost. Good for large-scale crawling in data pipelines.

---

## 5. Search & Research APIs

### 5.1 Tavily
- **Stars**: 1.1k (but used by 10.7k projects) | **License**: MIT | **Install**: `pip install tavily-python`
- **What**: AI-optimized search, extract, crawl, map & research API
- **Key Features**:
  - **Search**: Web search with `get_search_context()` for RAG
  - **Extract**: Pull content from URLs (up to 20 simultaneously)
  - **Crawl**: Traverse websites with instructions
  - **Map**: Discover site structure
  - **Research**: Full research reports with citations (`model="pro"`)
  - Q&A mode: `qna_search()` for direct answers
  - Streaming research results
  - Custom session injection for enterprise proxies
  - Free: 1,000 credits/month
- **Arceus Fit**: **HIGH** — Primary search tool for ResearchEmployee. `get_search_context()` perfect for RAG pipelines. Research API for deep topic analysis.

---

## 6. Tool Platforms & Integrations

### 6.1 Composio
- **Stars**: 27.4k | **License**: MIT | **Install**: `pip install composio`
- **What**: 1000+ toolkits, tool search, auth management, sandboxed workbench
- **Key Features**:
  - 500+ app integrations (Gmail, Slack, GitHub, Notion, Jira, Linear, etc.)
  - Provider packages for all major frameworks:
    - OpenAI, OpenAI Agents, Anthropic, LangChain, LangGraph, LlamaIndex, CrewAI, AutoGen, Google ADK, Vercel AI
  - Rube: MCP server for connecting AI tools to 500+ apps
  - Managed authentication (OAuth, API keys)
  - Python + TypeScript SDKs
  - Cross-client integration portability
- **Arceus Fit**: **HIGH** — Composio is the "tool marketplace" for Arceus agents. Provides pre-built SaaS integrations (Slack, GitHub, Jira, etc.) without building custom connectors.

---

## 7. Structured Outputs

### 7.1 Instructor
- **Stars**: 12.6k | **License**: MIT | **Install**: `pip install instructor`
- **What**: Get reliable JSON from any LLM using Pydantic
- **Key Features**:
  - Universal provider support: `instructor.from_provider("openai/gpt-4o")`
  - Automatic validation retries with error feedback
  - Streaming partial objects
  - Nested/complex data structures
  - Multi-language: Python, TypeScript, Ruby, Go, Elixir, Rust
  - 3M+ monthly downloads
  - **Note**: Created by same team, recommends PydanticAI for agent workflows
- **Arceus Fit**: Use for schema-first extraction in non-agent contexts. For agent workflows, use PydanticAI instead (same underlying tech).

---

## 8. Code Execution Sandboxes

### 8.1 E2B Code Interpreter
- **Stars**: 2.3k | **License**: Apache-2.0 | **Install**: `pip install e2b-code-interpreter`
- **What**: Secure isolated cloud sandboxes for AI-generated code
- **Key Features**:
  - Run AI-generated Python/JS in isolated cloud sandboxes
  - Persistent state within sandbox session
  - `sandbox.run_code()` interface
  - Python + JavaScript SDKs
  - Used as execution backend by smolagents, OpenHands, many agent frameworks
- **Arceus Fit**: **HIGH** — Execution environment for CodingEmployee agents. Sandboxed code execution prevents untrusted code from affecting the system.

---

## 9. Lightweight / Specialized Frameworks

### 9.1 smolagents (HuggingFace)
- **Stars**: 26.1k | **License**: Apache-2.0 | **Install**: `pip install "smolagents[toolkit]"`
- **What**: Minimal agent framework — "agents that think in code"
- **Key Features**:
  - Core logic in ~1,000 lines of code
  - **CodeAgent**: Writes actions as Python (30% fewer steps than JSON tool calls)
  - **ToolCallingAgent**: Standard JSON/text tool calling
  - Sandboxed execution: E2B, Blaxel, Modal, Docker, Pyodide+Deno
  - Hub sharing: push/pull agents and tools to HuggingFace Hub
  - Model-agnostic: transformers, ollama, LiteLLM, OpenAI, Anthropic
  - Multi-modal: text, vision, video, audio
  - MCP server tools, LangChain tools, Hub Space as tool
  - CLI: `smolagent` (general) + `webagent` (browser)
- **Arceus Fit**: Reference for SpawnedAgent design — minimal overhead, code-first execution

### 9.2 DSPy (Stanford)
- **Stars**: 32.9k | **License**: MIT | **Install**: `pip install dspy`
- **What**: "Programming—not prompting—foundation models"
- **Key Features**:
  - Declarative Self-improving Python
  - Compositional modules instead of brittle prompts
  - **Optimizers** that auto-tune prompts and weights
  - Works for classifiers, RAG pipelines, and agent loops
  - Signatures define I/O schemas declaratively
  - Automatic prompt optimization (MIPRO, BootstrapFewShot)
  - Research-backed (NeurIPS 2024)
- **Arceus Fit**: **FUTURE** — DSPy's auto-optimization aligns with Arceus's post-MVP Domain-Driven Distillation and RL training goals. Could optimize Employee prompts automatically.

---

## 10. Comparison Matrix

### Agent Frameworks

| Framework | Stars | Approach | Strengths | Weaknesses | Arceus Fit |
|-----------|-------|----------|-----------|------------|------------|
| **OpenAI Agents SDK** | 20.1k | Lightweight multi-agent | Simple, provider-agnostic, handoffs | Less batteries-included | SpawnedAgent |
| **AutoGen** | 55.8k | Multi-agent chat | Research, group chat, Studio GUI | Being deprecated → MS Agent Framework | Reference only |
| **LangGraph** | 26.7k | Stateful graph | Durable execution, memory, debugging | Complex, LangChain coupling | Meeting orchestration |
| **CrewAI** | 46.3k | Role-based crews + flows | Role mapping, fast, standalone | Less fine-grained control | Employee teams |
| **PydanticAI** | 15.5k | Type-safe agents | DI, evals, observability, MCP/A2A | Newer ecosystem | **Primary framework** |
| **Agno** | 38.8k | Production runtime | AgentOS, scaling, monitoring | Vendor-specific UI | Runtime reference |

### Memory Systems

| System | Stars | Approach | Self-Hosted | Arceus Fit |
|--------|-------|----------|-------------|------------|
| **Mem0** | 50.2k | Multi-level (User/Session/Agent) | Yes | MemoryUnit layer |
| **Zep** | 4.2k | Temporal knowledge graph | Cloud only | Pattern extraction |
| **Letta** | 21.6k | Self-editing memory blocks | Yes | Self-improving knowledge |

### Coding Agents

| Agent | Stars | Approach | Arceus Fit |
|-------|-------|----------|------------|
| **SWE-agent** | 18.8k | Issue → fix (SWE-bench SOTA) | CodingEmployee reference |
| **Aider** | 42.1k | Pair programming, repo-map | CodingEmployee architecture |
| **OpenHands** | 69.3k | Full-stack dev platform | CodingEmployee + integrations |

### Web & Data Tools

| Tool | Stars | Type | Self-Hosted | Arceus Fit |
|------|-------|------|-------------|------------|
| **browser-use** | 81.1k | Browser automation | Yes | WebEmployee tool |
| **Firecrawl** | 94.3k | Web → LLM data | Partial (AGPL) | Data pipeline |
| **Crawl4AI** | 62.1k | Web crawler | Yes (Apache-2.0) | Self-hosted crawling |
| **Tavily** | 1.1k | Search API | No (API) | ResearchEmployee search |
| **Composio** | 27.4k | 500+ app tools | Partial | SaaS integrations |

---

## 11. Arceus-Specific Recommendations

### Primary Stack (MVP)

| Layer | Tool | Rationale |
|-------|------|-----------|
| **Agent Framework** | **PydanticAI** | Type-safe, DI, structured outputs, evals, MCP/A2A, Pydantic-native |
| **Orchestration** | **CrewAI Flows** or custom | Crew model maps to Employee teams; Flows for event-driven control |
| **Memory** | **Mem0** (self-hosted) | Multi-level memory, direct mapping to MemoryUnit/WorkingMemory |
| **Coding** | **Aider** (library mode) or **OpenHands SDK** | Repo-map for large projects, git integration, OpenHands for full-stack |
| **Web Browsing** | **browser-use** | Best-in-class browser automation, simple API |
| **Web Scraping** | **Crawl4AI** (self-hosted) + **Firecrawl** (complex) | Crawl4AI for bulk, Firecrawl for structured extraction |
| **Search** | **Tavily** | Best search-for-RAG API, research reports |
| **Tool Integrations** | **Composio** | 500+ apps pre-built (Slack, GitHub, Jira, Linear) |
| **Code Execution** | **E2B** | Sandboxed execution for SpawnedAgent/CodingEmployee |
| **Structured Output** | **Instructor** (via PydanticAI) | Already built into PydanticAI |
| **LLM Provider** | **Azure OpenAI** | Per ARCEUS.md — gpt-5/o4-mini (CEO), gpt-4.1-mini (Employee), gpt-4.1-nano (Spawned) |

### Architecture Mapping

```
Arceus Layer          →  Open Source Tool
─────────────────────────────────────────
Platform/Startup      →  Custom (PostgreSQL + Redis)
CEO Agent             →  PydanticAI Agent (gpt-5)
Employee Agent        →  PydanticAI Agent + CrewAI role patterns
SpawnedAgent          →  smolagents CodeAgent / OpenAI Agents SDK
AgentFlow (P→E→V→M)  →  PydanticAI Graph / LangGraph
Meetings              →  Custom orchestration (CrewAI-inspired)
MemoryUnits           →  Mem0 (multi-level)
Hippocampus           →  Mem0 + Qdrant vector search
WorkingMemory         →  Redis + Mem0 session
Patterns              →  Zep Graphiti concepts (custom impl)
Tasks/Tickets         →  Custom + Composio (Jira/Linear sync)
CodingEmployee        →  Aider/OpenHands SDK + E2B sandbox
WebEmployee           →  browser-use + Firecrawl
ResearchEmployee      →  Tavily + Crawl4AI
PMEmployee            →  PydanticAI + Composio (Linear/Jira tools)
```

### Integration Strategy

1. **PydanticAI as the backbone**: All agents defined as `Agent[Deps, Output]` with typed inputs/outputs
2. **Mem0 as the memory bus**: Every agent reads/writes through Mem0's multi-level API
3. **Composio for external tools**: One auth layer for all SaaS integrations
4. **E2B for sandboxing**: All code generation/execution happens in isolated sandboxes
5. **MCP for extensibility**: PydanticAI's native MCP support for adding custom tool servers
6. **Tavily + Crawl4AI for web intelligence**: Search + deep crawl pipeline

### Post-MVP Considerations

- **DSPy**: Auto-optimize Employee prompts after collecting enough task data
- **LangGraph**: For more complex meeting orchestration with durable execution
- **Letta**: Self-improving memory patterns for long-running Startups
- **Agno**: Reference for production AgentOS patterns when scaling
- **OpenHands Enterprise**: If self-hosting full coding environments per-Startup

---

## Raw Data: Star Counts & Install Commands

```
# Agent Frameworks
pip install openai-agents          # OpenAI Agents SDK (20.1k★)
pip install "autogen-agentchat"    # AutoGen (55.8k★)
pip install langgraph              # LangGraph (26.7k★)
pip install crewai                 # CrewAI (46.3k★)
pip install pydantic-ai            # PydanticAI (15.5k★)
pip install agno                   # Agno (38.8k★)

# Memory
pip install mem0ai                 # Mem0 (50.2k★)
pip install zep-cloud              # Zep (4.2k★)
pip install letta-client           # Letta/MemGPT (21.6k★)

# Coding Agents
# SWE-agent (18.8k★) — install from source
pip install aider-install          # Aider (42.1k★)
# OpenHands (69.3k★) — Docker or pip

# Web & Scraping
pip install browser-use            # browser-use (81.1k★)
pip install firecrawl-py           # Firecrawl (94.3k★)
pip install crawl4ai               # Crawl4AI (62.1k★)

# Search & Research
pip install tavily-python          # Tavily (1.1k★)

# Tools & Integrations
pip install composio               # Composio (27.4k★)

# Structured Outputs
pip install instructor             # Instructor (12.6k★)

# Code Execution
pip install e2b-code-interpreter   # E2B (2.3k★)

# Lightweight Frameworks
pip install "smolagents[toolkit]"  # smolagents (26.1k★)
pip install dspy                   # DSPy (32.9k★)
```
