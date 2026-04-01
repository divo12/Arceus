# `ui/src/pages/AgentDetail.tsx`

This guide explains [`ui/src/pages/AgentDetail.tsx`](/Users/divyansh/Arceus/ui/src/pages/AgentDetail.tsx) as the agent workbench page.

If you want one sentence first:

`AgentDetail.tsx` is one large page that brings many agent-related subsystems together: profile, configuration, instructions, skills, runtime sessions, heartbeat runs, authority, budget, memory, and keys.

## Mental Model

Do not think of this file as “a detail view.”

Think of it as:

“the control room for one agent.”

That is why it is large.

It is not just showing a name and status. It is coordinating:

- route params
- many queries
- many mutations
- tab selection
- run detail drill-down
- configuration editing
- runtime introspection

This is a workbench screen, not a simple CRUD page.

## Why The File Looks So Big

There are two reasons this file is large:

1. the agent concept touches many subsystems in Paperclip
2. the UI chooses to keep those related experiences in one screen with tabs

That means the file contains many internal helper components like:

- `AuthorityTab`
- `AgentOverview`
- `CostsSection`
- `ConfigurationTab`
- `PromptsTab`
- `AgentSkillsTab`
- `RunsTab`
- `RunDetail`
- `LogViewer`
- `KeysTab`

The file is large, but the important thing is that most of it is still page-level composition, not backend business logic.

## Start With The Top-Level Question

When the route lands here, what is this page trying to answer?

Usually some combination of:

- who is this agent?
- what configuration does it have?
- what has it been doing recently?
- can it delegate or spawn?
- what session state is it carrying?
- what logs and runs exist?

That mental model helps the whole file feel less random.

## 1. Utility Helpers At The Top

The first big chunk of the file contains helper utilities:

- redaction helpers for environment values
- markdown detection helpers
- scroll container helpers
- usage metric helpers
- log parsing helpers
- workspace operation status helpers

Why are these here?

Because the page needs to display sensitive and operational data safely:

- some env values must be redacted
- logs need parsing and formatting
- long run transcripts need smart scrolling
- workspace operations need human-friendly badges

These helpers are not the main business story of the page, but they make the operational UI readable and safer.

## 2. `AgentDetailView`: Route State Becomes Tab State

The file defines allowed tab names:

- `dashboard`
- `instructions`
- `configuration`
- `skills`
- `runs`
- `budget`
- `memory`
- `authority`

That means one URL family can open multiple sub-experiences of the same agent.

So when you see a route like `/agents/:agentId/configuration`, this file parses the tab from the URL and activates the right section.

This is the same idea you saw in `Agents.tsx`, but more advanced.

## 3. `AgentDetail()`: The Real Page Coordinator

This is the most important function in the file.

It reads route params and then loads a lot of state in parallel.

### Main query families

The page asks for:

- agent detail
- runtime state
- task sessions
- heartbeat runs
- issues and related context
- full agent list for some delegation/workbench flows
- budget overview

This is why the file feels like a control room: it needs information from many domains to make the page useful.

### Main mutations

The page also owns actions like:

- invoke agent
- pause
- resume
- terminate
- reset session
- update permissions
- update configuration-related settings

So this page is both:

- a reader of system state
- a launcher of agent actions

That combination is what makes it operational rather than purely informational.

## 4. Dashboard Tab: The Human Overview

The dashboard area is where the page answers:

- what is this agent’s role?
- what is its status?
- what is its latest run?
- what does cost look like?
- what’s the quick operational picture?

Components like `AgentOverview`, `LatestRunCard`, and `CostsSection` live here.

This is the most “summary-first” part of the workbench.

## 5. Authority Tab: Who This Agent Is Allowed To Be

`AuthorityTab` is especially important for understanding Paperclip’s governance model.

It shows delegation and spawn-related authority:

- what roles the agent may delegate to
- what delegation style it uses
- what spawn budget remains
- what org position it has

This matters because agents in Paperclip are not all identical generic bots.

They are organizational actors with limits.

This page makes those limits visible to the operator.

## 6. Configuration Tab: What This Agent Is Configured To Run As

The configuration area is where you start seeing the difference between:

- identity
- runtime
- adapter
- policy

An agent is not just a name.

It also has:

- adapter type
- adapter config
- runtime config
- budget settings
- instructions setup
- permissions

This tab surfaces that shape for editing and review.

The important architectural point is:

the page edits configuration, but the rules for what changes are valid live on the backend service layer.

## 7. Instructions Tab: What The Agent Is Told

The instructions area deals with instruction bundles and instruction files.

This is where the workbench becomes very Paperclip-specific.

The system is not only storing rows like “status = active.”

It is also managing the material that shapes an agent’s behavior:

- managed instructions
- external instructions roots
- per-file editing

This is one of the clearest examples of how Paperclip mixes control-plane data with agent-runtime concerns.

## 8. Skills Tab: What Capabilities Are Attached

`AgentSkillsTab` lets the operator inspect and synchronize skills.

This page is not the skill system itself, but it is the operator-facing surface for:

- seeing current skills
- seeing available skills
- syncing desired skill sets

That is important because runtime capability in Paperclip is often mediated through skill materialization.

## 9. Runs Tab: The Best Runtime Window In The UI

`RunsTab`, `RunDetail`, and `LogViewer` together make this page one of the best windows into the heartbeat engine from the frontend.

This tab answers:

- what runs has this agent executed?
- which one is selected?
- what status did it end with?
- what did stdout/stderr/system logs look like?
- what workspace operations happened?
- what token usage happened?

This is where Phase 3 begins touching Phase 4.

The page is not executing the run itself, but it is the main place a human inspects run artifacts.

## 10. Runtime State And Task Sessions

This page also surfaces:

- current runtime state
- task sessions

That distinction matters:

- runtime state is “what this agent is carrying right now”
- task sessions are “how the system preserves continuity for specific task scopes”

The page does not invent these concepts. It only exposes them.

But this is a great place to notice that Paperclip cares about continuity between runs, not just isolated one-shot executions.

## 11. Keys Tab

`KeysTab` is the operator surface for agent API keys.

This is another example of how one workbench screen collects related but different concerns:

- business identity
- runtime activity
- security credentials

That does make the file larger, but it also makes the agent experience operationally coherent.

## 12. What This File Owns Vs What It Delegates

This file owns:

- route/tab interpretation
- query orchestration
- mutation wiring
- operational rendering of runs/logs/configuration

This file delegates:

- actual HTTP calls to [`ui/src/api/agents.ts`](/Users/divyansh/Arceus/ui/src/api/agents.ts)
- backend permission rules to [`server/src/routes/agents.ts`](/Users/divyansh/Arceus/server/src/routes/agents.ts)
- domain behavior to [`server/src/services/agents.ts`](/Users/divyansh/Arceus/server/src/services/agents.ts)
- runtime execution to heartbeat/adapters

That division is what keeps the page big but still conceptually manageable.

## How To Read This File Without Drowning

Use this reading order:

1. find `AgentDetail()`
2. list all queries it makes
3. list all mutations it makes
4. identify each tab and what data it depends on
5. treat the lower helper components as render helpers for that tab

If you do that, the page stops feeling like a 4000-line wall and starts feeling like:

- one coordinator
- several tab sections
- several display helpers

## Why This File Is Important For Repo Understanding

This one page teaches several repo truths at once:

- one screen can depend on many backend surfaces
- UI pages often assemble multiple subsystems into one operator experience
- runtime inspection is a first-class feature in Paperclip
- agent identity, configuration, governance, and execution are tightly related

If you understand this page well, many other “detail workbench” pages in the repo will make much more sense.

## Self-Check

You understand this file if you can answer:

1. Why does one agent detail page need both agent detail data and heartbeat run data?
2. Why is this page better described as a workbench than a profile screen?
3. Which parts of this page are about display, and which parts are about launching actions?
4. Why does this page naturally connect Phase 3 to the heartbeat runtime in Phase 4?
