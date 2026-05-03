# Spec 32 Observability — Research Report

*Generated: 2026-04-25 | Sources: 18 | Confidence: High*

## Executive Summary

The industry has converged hard since 2024 on **OpenTelemetry GenAI semantic conventions** as the schema for agent observability — LangSmith, Langfuse, Datadog, Arize, SigNoz, and Braintrust all speak it natively now. The dominant pattern is: **structured typed spans at system seams + a rich enrichment layer (human + LLM-as-judge) + a closed loop back to the agent**. This is exactly the direction spec 32 points.

For Arceus specifically, two concrete opportunities:

1. **Align spec 32's event union with OpenTelemetry's `gen_ai.*` semantic conventions** — free interoperability with every observability backend, zero lock-in.
2. **Instrument at OpenCode's native plugin hook surface** (already in the repo via `.opencode/plugin/arceus.ts`) — OpenCode exposes ~24 hook events including `tool.execute.before/after`, `session.created/updated/idle/error`, `permission.asked/replied`, `message.updated`, and more. We're currently only using 2 of them.

Three patterns stand out as directly applicable to spec 32's "feedback loop to AI agents" goal: **trace clustering for failure-mode detection** (LangSmith Insights Agent), **low-score trace replay into training data** (the agent-improvement loop), and **trajectory-informed memory** (recent arXiv work on making agents self-improve from their own traces).

---

## 1. OpenTelemetry GenAI Semantic Conventions — the emerging standard

The OpenTelemetry GenAI SIG has been shipping agent observability conventions since April 2024. As of 2026 they're still experimental but stable enough that every major vendor supports them. Key points:

- **Two agent span operations** defined: `create_agent` and `invoke_agent` ([OpenTelemetry GenAI Agent Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/))
- **Span kind**: `CLIENT` for remote agents, `INTERNAL` for in-process agents like ours
- **Required attributes**: `gen_ai.operation.name`, `gen_ai.provider.name`, `error.type` on failure
- **Conditionally required**: `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.conversation.id`
- **Opt-in for higher detail**: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.definitions`, `gen_ai.system_instructions`

Datadog, Splunk, Arize, and Langfuse all ingest traces in this format without translation. Using it costs us nothing extra today and gives us drop-in observability backend support tomorrow ([Datadog LLM OTEL support](https://www.datadoghq.com/blog/llm-otel-semantic-convention/), [LangFlow observability comparison](https://www.langflow.org/blog/llm-observability-explained-feat-langfuse-langsmith-and-langwatch)).

**Implication for spec 32:** the `ArceusEvent` union is fine as an internal type, but adding a layer that **maps it to OpenTelemetry spans** on emit gives us optionality. Cofounder's §5 already picks `pino` + stdout — we'd bolt an OpenTelemetry SDK alongside without changing the event union.

---

## 2. The Agent-Improvement Loop — trace → analyze → update → validate

LangChain's canonical ["traces start the agent improvement loop"](https://www.langchain.com/conceptual-guides/traces-start-agent-improvement-loop) formalizes a 6-step cycle that every serious agent-observability vendor now sells:

1. **Collect** traces from production, staging, benchmarks, and dev
2. **Enrich** with automated evals (LLM-as-judge) and human annotations
3. **Identify patterns** across traces — failure-mode clustering
4. **Make targeted changes** to prompts, code, or orchestration
5. **Validate offline** against a curated dataset before shipping
6. **Deploy and repeat** — production traces feed the next cycle

Key insight: "**each improvement is informed by specific, observed behavior rather than hypothetical failure modes**" ([LangChain](https://www.langchain.com/conceptual-guides/traces-start-agent-improvement-loop), [Galileo](https://galileo.ai/blog/logging-tracing-ai-systems)).

**Three practical mechanisms** cited repeatedly:

- **Annotation queues** that route low-scoring traces to human reviewers (LangSmith's flagship feature)
- **Insights Agent** pattern — an LLM auto-clusters production traces and surfaces failure modes without human prompting
- **LLM-as-a-judge** for continuous scoring — cheap, near-realtime ([Langfuse docs](https://langfuse.com/docs/observability/overview))

### Self-correcting agents from logs

NVIDIA's recent work on a [log analysis multi-agent self-corrective RAG system](https://developer.nvidia.com/blog/build-a-log-analysis-multi-agent-self-corrective-rag-system-with-nvidia-nemotron/) shows a live **self-correction loop**: if retrieval scores don't meet a threshold, the agent rewrites its query and retries — driven by the log stream itself.

The [AgentTrace paper](https://arxiv.org/html/2602.10133v1) proposes three tiers of structured log streams that should be captured for agent observability:
- **Operational** — what the system did (tool calls, latencies, status)
- **Cognitive** — why the agent chose it (reasoning, plan state)
- **Contextual** — what the agent knew (retrieved memory, injected skills)

Spec 32's current event union maps cleanly to operational. **Cognitive and contextual are underrepresented** — this is an enhancement opportunity.

### The "living system" framing

Braintrust summarizes the loop as: "**By feeding low-scoring traces and failed evals back into pipelines, agents can learn from their mistakes and become living systems**" ([Braintrust on trace-driven evaluation](https://medium.com/@braintrustdata/evaluating-agents-with-trace-driven-insights-9ad3bfed820e)). Concrete implementations:
- Low-scoring traces become examples in a fine-tuning dataset
- Failure patterns become skill-evolution candidates (mirrors our spec 29)
- Annotated traces become training pairs for LLM-as-judge calibration

---

## 3. OpenCode-Specific Observability — the existing surface

OpenCode is surprisingly well-instrumented. Our current [.opencode/plugin/arceus.ts](.opencode/plugin/arceus.ts) uses only 2 of the ~24 available hooks. The full list, grouped:

### Session lifecycle (9 hooks)
`session.created`, `session.updated`, `session.deleted`, `session.error`, `session.idle`, `session.status`, `session.diff`, `session.compacted`, `experimental.session.compacting`

### Tool execution (2 hooks — the ones we use)
`tool.execute.before`, `tool.execute.after`

### Message events (4 hooks)
`message.updated`, `message.removed`, `message.part.updated`, `message.part.removed`

### Permission events (2 hooks)
`permission.asked`, `permission.replied`

### File events (2 hooks)
`file.edited`, `file.watcher.updated`

### LSP events (2 hooks)
`lsp.client.diagnostics`, `lsp.updated`

### TUI / CLI / server events
`tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, `command.executed`, `server.connected`, `todo.updated`, `shell.env`, `installation.updated`

([OpenCode plugin docs](https://opencode.ai/docs/plugins/), [Oh My OpenCode custom hooks guide](https://www.mintlify.com/code-yeongyu/oh-my-opencode/advanced/custom-hooks), [KristjanPikhof/OpenCode-Hooks](https://github.com/KristjanPikhof/OpenCode-Hooks))

### OpenCode's internal session architecture

From [Moncef Abboud's deep-dive into OpenCode internals](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/):

> "OpenCode structures conversations as **sessions** containing **messages** composed of typed **parts**. Each part represents a discrete element: text, tool call, tool result, or error."

> "The system uses a **shared bus across the app** that broadcasts real-time updates... Each persisted message part emits an event, exposed over HTTP via continuous SSE events."

**Practical consequence:** we can subscribe to OpenCode's SSE stream from Arceus API and get message-level telemetry per session without installing anything. This is a whole observability layer we haven't tapped.

### Existing OpenCode observability tools to learn from

| Tool | Approach | What to steal |
|---|---|---|
| [danilofalcao/opencode-observability](https://github.com/danilofalcao/opencode-observability) | Plugin → HTTP POST → Bun/SQLite → WebSocket → Vue dashboard | The HTTP POST from plugin pattern; captures tool executions, session lifecycle, messages, permissions, full I/O |
| [stolinski/opencode-sentry-monitor](https://github.com/stolinski/opencode-sentry-monitor) | Plugin emits Sentry AI Monitoring spans for session lifecycle, tool execution, token usage | The "emit to external observability" pattern; free vendor-grade dashboards |
| [SigNoz OpenCode integration](https://signoz.io/docs/opencode-observability/) | `@devtheops/opencode-plugin-otel` → OTLP → SigNoz | Direct OpenTelemetry export path |
| [MLflow OpenCode tracing](https://mlflow.org/docs/latest/genai/tracing/integrations/listing/opencode/) | Each session tagged `mlflow.trace.session` + user tagged `mlflow.trace.user`, grouped and filtered in MLflow UI | The session-as-trace model |
| [agentlens](https://github.com/RobertTLange/agentlens) | Local CLI + Fastify + Vite web UI, indexes session files | Local-first inspection pattern; break-detection (>20min idle), daily heatmaps |
| [agent-sessions](https://github.com/jazzyalex/agent-sessions) | Native macOS app unifying Codex / Claude / OpenCode / Gemini / Copilot sessions with search, archive, resume, rate-limit tracking | Shows what users actually want to see across agent sessions |

---

## 4. Observability platforms compared

For context on what "good" looks like, the 2026 market:

| Platform | Strength | Relevance to Arceus |
|---|---|---|
| **Langfuse** | Open source, OpenTelemetry native, `@observe()` decorator pattern | Could self-host alongside our Postgres; already integrates with LangChain/LangGraph ([Langfuse GitHub](https://github.com/langfuse/langfuse)) |
| **LangSmith** | Best-in-class trace clustering + Insights Agent | Commercial; would work with our OTEL output |
| **SigNoz** | Open source OTEL backend, good for self-host | Direct OpenCode plugin exists ([SigNoz docs](https://signoz.io/docs/opencode-observability/)) |
| **Arize** | Strong evaluator library for agents | Good if we want LLM-as-judge pipelines |
| **Splunk** | Enterprise, recently added AI agent observability | Overkill for us |
| **Datadog LLM Observability** | Ingests OTEL GenAI conventions natively | Good if the company already runs Datadog |

**Takeaway:** if we emit OTEL GenAI spans from day one, we can pick any of these later. Langfuse is the strongest free/self-host option.

---

## 5. Gaps in spec 32 worth addressing

Reading spec 32 against this research, five concrete suggestions emerge:

### 5.1 Map `ArceusEvent` → OTEL GenAI spans
Keep the internal union. Add a sink that emits OTEL spans alongside `memorySink` / `pinoSink`. Zero cost today, free backend flexibility tomorrow. Map examples:
- `beat.started` → span `invoke_agent {role}`, `gen_ai.operation.name=invoke_agent`
- `tool.invoked` → child span `execute_tool {tool}`, with `gen_ai.tool.name`
- `role.handoff` → span event inside parent beat span

### 5.2 Capture *cognitive* and *contextual* signals, not just operational
AgentTrace's three-tier taxonomy calls out what's missing. Specifically add:
- `agent.reasoning` — when the model emits chain-of-thought or plan steps
- `memory.recalled` — what memory units were injected into the prompt
- `skill.considered` — which catalog entries the agent saw but didn't use

These are what close the loop to skill evolution (spec 29) — without them, EMA-drop detection can't know *why* the skill underperformed.

### 5.3 Instrument more OpenCode hooks in our plugin
Current `.opencode/plugin/arceus.ts` uses `tool.execute.before` and `tool.execute.after`. Add:
- `session.created` / `session.idle` / `session.error` → map to beat lifecycle events
- `permission.asked` / `permission.replied` → track governance approvals in traces
- `message.part.updated` → watch for plan deltas, partial tool responses
- `file.edited` → correlate edits to task completion evidence

This turns the plugin into a rich emit layer instead of a thin allowlist enforcer.

### 5.4 Plan the enrichment tier
Spec 32 stops at "capture events." The agent-improvement loop needs an **enrichment** stage:
- Run LLM-as-judge scoring on each completed beat
- Cluster traces by failure pattern (Insights Agent pattern — we have an LLM, use it)
- Surface low-scoring clusters in the frontend as proposals for skill evolution (wires into our spec 29 candidate trigger)

Without enrichment, events are just telemetry — they don't *improve* anything.

### 5.5 Close the loop back to the agent
Three concrete patterns from the research:
- **Inject last-beat outcome into next-beat prompt** — "Your previous attempt scored 0.4 because X; here's what to try differently." This is how [self-evolving agents](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining) actually learn.
- **Trajectory-informed memory** — store failure trajectories as memory units that the memory service surfaces when the agent hits a similar task ([arXiv 2603.10600](https://arxiv.org/html/2603.10600)).
- **Post-mortem review by a specialist agent** — a dedicated role reads the trace, writes a correction, feeds it to the producer agent as a handoff.

All three are feasible additions on top of spec 32's emit surface.

---

## 6. Concrete recommendations for Arceus

### Near-term (within spec 32 scope, not expanding it)

1. **Keep cofounder's `ArceusEvent` union as the internal source of truth.** The design is sound; don't redesign it.

2. **Add an OTEL sink alongside `pinoSink`.** 50 LOC. Exports our events as OpenTelemetry spans following GenAI semconv. Day-one lock-in avoidance.

3. **Expand our OpenCode plugin to emit from more hooks.** Specifically `session.created`, `session.idle`, `session.error`, `permission.asked`, `message.part.updated`. Each maps to a spec-32 event. Zero new infra — just extends the plugin we already have.

4. **Decide once: spec-32 events vs. spec-31 `activity_log` table.** Either:
   - Events ARE the activity log (projection pattern — `activity_log` becomes a view over emitted events)
   - OR the activity_log is a separate persistence layer fed by the emitter
   - Pick before both land; otherwise we have two sources of truth for "what happened"

### Medium-term (after spec 32 v1 ships)

5. **Build an LLM-as-judge evaluator.** Per-beat scoring (pass / fail / reasoning quality / tool-use correctness). Cheap, async, drives skill-evolution triggers in spec 29.

6. **Implement trace clustering for failure-mode detection.** LangSmith-style Insights Agent that runs nightly over recent traces and surfaces "X% of CEO beats failed due to Y." Natural input to spec 29 Track C's `trigger=candidate`.

7. **Close the feedback loop to the agent.** Inject the previous beat's verdict + reasoning into the next beat's context. This is the single highest-leverage change — agents that see their own mistakes improve demonstrably ([Galileo](https://galileo.ai/blog/logging-tracing-ai-systems)).

### Long-term (beyond spec 32)

8. **Consider self-hosting Langfuse** for a best-in-class dashboard at zero marginal cost (runs on our Postgres). Alternative: SigNoz for pure OTEL.

9. **Adopt the three-tier AgentTrace taxonomy** (operational / cognitive / contextual) when we revisit the event union for v2. Specifically adds cognitive and contextual emit sites.

---

## Key Takeaways

- **OpenTelemetry GenAI semconv is the standard.** Design spec 32's event shapes to map cleanly onto it; get every major observability backend for free.
- **The real loop is trace → enrich → cluster → change → validate, not just "log more."** Spec 32 covers capture; the value is in enrichment and closing the loop back to the agent.
- **OpenCode's ~24 plugin hooks are our highest-leverage instrumentation surface.** Our plugin currently uses 2. Expanding this is day-one free telemetry.
- **`activity_log` table and spec-32 events are the same thing — decide once.** Pick "events are truth" or "table is truth" before both land.
- **Feeding the agent's previous verdict into the next beat's prompt is the cheapest effective feedback loop.** Implementable in a few hours once events are flowing.

---

## Sources

1. [AI Agent Observability Guide — groundcover](https://www.groundcover.com/learn/observability/ai-agent-observability) — general taxonomy
2. [AI Agent Observability — OpenTelemetry blog](https://opentelemetry.io/blog/2025/ai-agent-observability/) — standards direction
3. [Semantic Conventions for GenAI agent spans — OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) — concrete span / attribute spec
4. [Semantic Conventions for Generative AI systems — OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
5. [Datadog LLM Observability — OTEL GenAI support](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)
6. [LangSmith Observability](https://www.langchain.com/langsmith/observability)
7. [The Agent Improvement Loop Starts with a Trace — LangChain](https://www.langchain.com/conceptual-guides/traces-start-agent-improvement-loop) — the canonical improvement-loop methodology
8. [Langfuse Observability Overview](https://langfuse.com/docs/observability/overview)
9. [Langfuse GitHub](https://github.com/langfuse/langfuse) — open-source self-host option
10. [LLM Observability Explained — Langflow](https://www.langflow.org/blog/llm-observability-explained-feat-langfuse-langsmith-and-langwatch) — vendor comparison
11. [Evaluating agents with trace-driven insights — Braintrust](https://medium.com/@braintrustdata/evaluating-agents-with-trace-driven-insights-9ad3bfed820e)
12. [Master Logging and Tracing for Effective AI Development — Galileo](https://galileo.ai/blog/logging-tracing-ai-systems)
13. [Build a Log Analysis Multi-Agent Self-Corrective RAG System — NVIDIA](https://developer.nvidia.com/blog/build-a-log-analysis-multi-agent-self-corrective-rag-system-with-nvidia-nemotron/)
14. [AgentTrace paper — arXiv](https://arxiv.org/html/2602.10133v1) — three-tier taxonomy
15. [Trajectory-Informed Memory Generation — arXiv](https://arxiv.org/html/2603.10600)
16. [Self-Evolving Agents Cookbook — OpenAI Developers](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining)
17. [OpenCode Plugins docs](https://opencode.ai/docs/plugins/) — full hook event list
18. [How Coding Agents Actually Work: Inside OpenCode — Moncef Abboud](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/) — OpenCode internals deep-dive
19. [SigNoz OpenCode Observability](https://signoz.io/docs/opencode-observability/)
20. [MLflow OpenCode Tracing](https://mlflow.org/docs/latest/genai/tracing/integrations/listing/opencode/)
21. [danilofalcao/opencode-observability](https://github.com/danilofalcao/opencode-observability) — plugin+Bun+SQLite+Vue reference
22. [stolinski/opencode-sentry-monitor](https://github.com/stolinski/opencode-sentry-monitor)
23. [agentlens](https://github.com/RobertTLange/agentlens) — local-first session inspector
24. [agent-sessions](https://github.com/jazzyalex/agent-sessions) — cross-platform session browser
25. [KristjanPikhof/OpenCode-Hooks](https://github.com/KristjanPikhof/OpenCode-Hooks) — YAML-configured hook actions

## Methodology

Searched 5 queries across web sources (observability standards, agent improvement loops, OpenCode-specific observability, plugin hook APIs, self-correcting agents). Deep-read 6 primary sources with WebFetch. Cross-referenced 25 unique sources.

Sub-questions investigated:
- What observability patterns exist for AI agent systems in production (2025–2026)?
- How do production agent frameworks structure event logs for feedback loops?
- What's the state of OpenTelemetry GenAI semantic conventions?
- Does OpenCode have built-in observability hooks? Which, and what do they expose?
- How do agents self-correct from their own trace data?
- Which vendor platforms support OTEL GenAI natively?
