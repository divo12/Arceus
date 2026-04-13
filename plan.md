## Plan: Arceus Demo MVP

Build a greenfield investor-demo MVP as a web product that sits above OpenCode, not inside its native UI. The MVP should make the CEO chat, approvals, hierarchy, tasks, meetings, and worker execution feel like a real AI company while keeping the deepest memory/orchestration machinery intentionally shallow. The core loop should be real: user idea -> CEO refinement -> dynamic team proposal -> approved hires -> delegated execution -> runnable local prototype. Non-critical realism such as rich long-term memory evolution and fully general multi-agent autonomy should be simplified behind strict schemas, bounded role types, and guided fallback behavior.

**Steps**
1. Phase 1 - Foundation and demo constraints. Define the demo contract first: the product accepts arbitrary ideas, but the CEO must always narrow them into a demoable first release before execution begins. Lock the supported employee role types for MVP to CEO, CTO, PM, and Developer while keeping hierarchy generation dynamic and type-checked. Choose OpenCode server plus JS SDK as the agent runtime layer, with your own application responsible for orchestration, state, UI, audit, and approvals.
2. Phase 1 - Monorepo bootstrap. Create a new monorepo with separate apps for web and API, shared packages for contracts and company runtime, and an isolated demo workspace where employee agents scaffold or modify generated projects. This step blocks all other work because every later subsystem depends on shared types, startup state, and event contracts.
3. Phase 1 - Shared contracts and schemas. Define strict typed schemas for Startup, FundamentalIdea, Hierarchy, Role, EmployeeAgent, Task, Meeting, Approval, MemorySummary, ActivityEvent, and CEO structured outputs. Make the CEO chat and every orchestration decision schema-first so cards, approvals, hierarchy diffs, and task events can be rendered without brittle prompt parsing. This step blocks the API, web UI, and OpenCode integration.
4. Phase 2 - CEO chat and startup initialization. Build the CEO conversational flow as the primary entry point. The CEO must refine the idea, produce a structured startup brief, propose a dynamic hierarchy, and surface approval cards for hiring. On approval, instantiate employee identities with role prompts, permissions, goals, and reporting lines. This is the first real user-facing loop and should be implemented before deeper worker logic.
5. Phase 2 - OpenCode runtime adapter. Build a backend adapter that launches or connects to headless OpenCode sessions through the SDK/server, maps each employee or spawned worker to an isolated session, submits prompts with JSON-schema output where possible, handles permission requests, and converts OpenCode session events into Arceus activity events. This can begin in parallel with the CEO UI once shared schemas are stable, but it blocks actual worker execution.
6. Phase 2 - Company orchestration layer. Implement the thin company brain above OpenCode: hierarchy service, task router, spawn manager, approval manager, meeting service, and memory summary service. Keep orchestration deterministic where possible. Employees should not chat freely; instead they exchange structured meeting records and task handoffs. Parent verification should exist in simplified form for every spawned execution result. This depends on steps 3 through 5.
7. Phase 3 - Execution surfaces. Build the investor-facing product surfaces around the event stream: CEO chat workspace with rich cards, approval queue, org hierarchy, task board, meeting timeline, and memory summary view. Keep worker chat limited to drill-down follow-up or transcript style; direct control still routes through the CEO. This can proceed in parallel with backend orchestration after event contracts stabilize.
8. Phase 3 - Project generation and controlled execution. Add the demo workspace pipeline where Developer agents can scaffold a fresh runnable local app, create files, iterate on tasks, and produce a local prototype. The safest MVP shape is: CEO narrows scope -> CTO/PM create backlog -> Developer executes in a fresh generated workspace -> output is runnable locally with a minimal smoke test. This depends on the OpenCode adapter and task orchestration.
9. Phase 3 - Meetings and memory summaries. Implement standup and escalation constructs as structured generated artifacts, not open-ended multi-agent conversations. Each meeting should capture agenda, updates, blockers, decisions, and task modifications. Memory for MVP should be hybrid: short-term working context plus durable summaries of decisions, learnings, agent profile, active patterns, and recent history. Design the storage boundary so deeper semantic memory can be swapped in later without rewriting the UI contracts.
10. Phase 4 - Demo hardening and narrative polish. Add seeded demo templates, latency masking states, failure fallbacks, investor-friendly copy, and graceful degradation when ideas are too broad. The CEO should automatically restate the narrowed first release and ask for approval before hiring or building. Ensure every major step emits visible progress so the product never looks idle or opaque.
11. Phase 4 - Reliability guardrails. Constrain the MVP with explicit limits: one startup at a time, one active delivery track per startup, one generated app workspace per run, local runnable output only, bounded spawn depth, bounded meeting types, and bounded role catalog. Add fallback states where the CEO converts blocked execution into approvals or narrowed scope instead of letting worker sessions fail silently.
12. Phase 4 - Demo script and rehearsal. Prepare a default investor walkthrough using 2 or 3 representative ideas, each showing the same lifecycle: onboarding, hierarchy proposal, hiring approvals, task delegation, meeting visibility, worker execution, and final local app preview. Rehearsal is a deliverable, not an afterthought, because perceived autonomy depends as much on pacing and visibility as on actual backend capability.

**Relevant files**
- q:\projects\arc2.0\apps\web - Next.js application for CEO chat workspace, cards, hierarchy, tasks, meetings, approvals, and memory views.
- q:\projects\arc2.0\apps\api - Backend API for startup lifecycle, orchestration, OpenCode adapter endpoints, SSE/WebSocket events, and approval handling.
- q:\projects\arc2.0\packages\contracts - Shared schemas and typed event contracts for all structured outputs and UI cards.
- q:\projects\arc2.0\packages\company-runtime - Role templates, hierarchy generator, task router, meeting protocol, memory summaries, and orchestration services above OpenCode.
- q:\projects\arc2.0\packages\opencode-adapter - SDK/server integration for session management, prompt submission, permission handling, and event translation.
- q:\projects\arc2.0\demo-workspace - Controlled generated project workspace where Developer agents scaffold and iterate on runnable outputs.
- q:\projects\arc2.0\docs - Demo script, product narrative, fallback rules, and operator runbooks.

**Verification**
1. Verify startup creation end to end: user enters idea -> CEO refines it -> CEO emits structured startup brief -> hierarchy proposal renders as cards -> user approves hires.
2. Verify dynamic hierarchy generation: different ideas produce different role combinations and reporting lines within the bounded CEO, CTO, PM, Developer role set.
3. Verify task delegation flow: approved hierarchy produces tasks that move down the chain with visible status transitions and parent verification.
4. Verify worker execution: a Developer session can scaffold a fresh local app in the demo workspace and produce a runnable prototype for at least 2 representative product ideas.
5. Verify meeting protocol: standup and escalation records appear in the timeline, update task state, and surface user approvals when needed.
6. Verify memory summaries: each employee page shows current goals, recent learnings, decisions, active patterns, and last meeting outcomes without exposing raw low-level memory internals.
7. Verify dual-surface approvals: the same approval appears in CEO chat and the queue, and resolving it updates both surfaces in real time.
8. Verify failure handling: when the idea is too broad or execution blocks, the CEO narrows the scope into a demoable first release instead of dead-ending.
9. Verify demo polish: every major backend transition emits a UI-visible event within a predictable time window so investors always see progress.

**Decisions**
- Build Arceus as a separate web product that embeds OpenCode through its server and SDK rather than trying to extend the native OpenCode UI.
- Keep the real core loop in MVP: CEO conversation, hierarchy proposal, approvals, task routing, worker execution, and runnable local output.
- Keep memory hybrid for MVP: lightweight summaries now, architecture ready for deeper semantic retrieval later.
- Keep hierarchy dynamic but strictly typed, with the initial role catalog limited to CEO, CTO, PM, and Developer.
- Allow the CEO to be the primary interface, with optional limited worker drill-down rather than full unconstrained direct worker chat.
- Treat meetings as the canonical inter-employee communication surface, but implement them as structured artifacts first rather than sophisticated multi-agent discussion loops.
- Allow arbitrary user ideas at the entry point, but force the CEO to narrow them into a demoable first release before execution begins.
- Target local runnable output, not public cloud deployment, for the first investor demo.

**Scope boundaries**
- Included: CEO chat workspace, structured cards, approvals, dynamic hierarchy, bounded employee identities, task system, meeting timeline, memory summaries, worker execution in a controlled generated workspace, and local runnable prototype output.
- Excluded from MVP: deep semantic memory, long-horizon continual learning, arbitrary role catalog expansion, unconstrained worker-to-worker chat, multi-startup operations at scale, public deployment pipelines, full cost accounting, and fully general support for every possible software archetype without graceful narrowing.

**Further Considerations**
1. The strongest demo path is to bias the CEO toward web product first releases even when the user describes something much broader. This preserves the promise of arbitrary ideas while keeping execution credible.
2. Investor confidence will come more from visible coordination and artifact quality than from exposing every internal reasoning detail. Prefer clean cards, meeting outputs, and progress evidence over raw traces.
3. If execution reliability lags, cut direct worker chat before cutting CEO chat, approvals, hierarchy, or runnable output. Those four surfaces carry the demo narrative.