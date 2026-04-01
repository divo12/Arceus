# `server/src/adapters/arceus/execute.ts`

This guide explains [`server/src/adapters/arceus/execute.ts`](/Users/divyansh/Arceus/server/src/adapters/arceus/execute.ts) as the concrete Arceus runtime handoff.

If you want one sentence first:

`arceus/execute.ts` prepares environment, skills, AGENTS.md, and prompt context for a run, then sends the actual work to an OpenCode HTTP runtime and converts the response back into Paperclip’s standard adapter result shape.

## The Most Important Truth First

This file answers a question that easily confuses people:

Does Arceus directly execute the work itself?

Today, not fully.

This adapter currently delegates the actual conversational/tool-execution runtime to an OpenCode service over HTTP.

So the shape is:

`heartbeat -> Arceus adapter -> OpenCode session/message API -> returned result -> Paperclip result`

That is the most important architectural fact in this file.

## Mental Model

Think of this file as a runtime translator and packager.

It does not decide whether a run should happen. Heartbeat already decided that.

It does not decide the database consequences. Heartbeat will persist those later.

Its job is:

1. take the standardized adapter execution context
2. prepare the runtime environment OpenCode expects
3. launch the prompt
4. stream back logs/metadata/result
5. return a normalized `AdapterExecutionResult`

## 1. `ocRequest(...)`: OpenCode HTTP Client

This helper is the raw transport to the OpenCode service.

It:

- builds an HTTP request
- sends JSON body when needed
- attaches the OpenCode directory header
- parses JSON response when possible
- enforces a timeout

This is the first clear sign that Arceus is currently OpenCode-backed.

The adapter is not spawning a model process itself here.

It is speaking to a service endpoint.

## 2. Skill Injection

The skill-related helpers do something very practical:

- discover desired Paperclip runtime skills
- create symlinks into `~/.claude/skills`
- remove maintainer-only skills that should not remain

Why?

Because the downstream runtime reads skills from that location automatically.

This is a very important runtime detail:

the adapter does not only send a prompt.

It also shapes the tool/skill environment the agent will experience.

## 3. Helper Functions For Context Normalization

Small helpers like:

- `getEnvOrConfig(...)`
- `asString(...)`
- `asRecord(...)`
- `asStringArray(...)`
- `asNumber(...)`
- `asDelegationStyle(...)`

exist because adapter config and context are partly dynamic data.

The adapter needs to safely extract:

- model/provider settings
- delegation style
- role definition fields
- spawn budget values
- org position context

This is classic boundary hygiene:

- normalize messy input before building runtime output

## 4. `buildRoleContextBlock(...)`

This function is one of the most revealing parts of the file.

It takes role-definition-related context and turns it into a readable block for `AGENTS.md`.

That block includes things like:

- role label
- role prompt
- delegation authority
- delegation style hints
- spawn authority and budget
- org position

This is important because it shows Paperclip does not treat an agent like a raw model call.

It tries to embed organizational context into the runtime prompt/instruction environment.

So the adapter is not only plumbing. It is packaging identity and authority.

## 5. `writeAgentsMd(...)`

This is the most operationally important helper in the file.

It writes an `AGENTS.md` file into the OpenCode directory for the run.

That file includes:

- exported `PAPERCLIP_*` environment variables
- quick reference values like agent id and run id
- role context
- hiring guidance
- instruction to load the `paperclip` skill
- optional session handoff
- optional memory context
- optional meeting context

### Why this matters

Instead of relying on one huge prompt only, the runtime environment is being shaped through:

- environment variables
- skill injection
- generated `AGENTS.md`
- short user prompt

That is a deliberate runtime design choice.

It spreads control-plane context into the environment the agent actually sees.

## 6. `execute(...)`: Main Adapter Flow

This is the function heartbeat ultimately calls.

At a high level it does:

1. resolve provider/model
2. build canonical Paperclip env vars
3. add wake-related env vars
4. inject skills
5. write `AGENTS.md`
6. build the user prompt
7. create OpenCode session
8. send the message
9. handle errors
10. collect text, tools, and token counts
11. return standardized result

That is the real Arceus execution story today.

## 7. Environment Construction

The adapter builds environment like:

- `PAPERCLIP_RUN_ID`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_TASK_ID`
- `PAPERCLIP_WAKE_REASON`
- `PAPERCLIP_APPROVAL_ID`
- `PAPERCLIP_LINKED_ISSUE_IDS`
- meeting-related values

This is important because a Paperclip run is not a generic chat.

The runtime receives strong control-plane context.

That lets the agent interact with the Paperclip API and understand why it woke up.

## 8. Session Creation And Message Send

After setup, the adapter:

- creates an OpenCode session
- sends a message containing the user prompt

This is the moment actual runtime execution begins.

If session creation fails or the prompt call fails, the adapter returns a standardized error result to heartbeat.

That is a good adapter design:

- failures are normalized
- heartbeat does not have to understand raw OpenCode internals

## 9. Result Extraction

The adapter reads:

- text parts
- tool invocation parts
- token usage
- final content

Then it returns a standard Paperclip result with fields like:

- `exitCode`
- `model`
- `provider`
- `billingType`
- `usage`
- `resultJson`
- `summary`

This is where a concrete runtime becomes a common control-plane result.

That normalization is what allows heartbeat to treat adapters uniformly later.

## 10. `buildUserPrompt(...)`

The user prompt itself is intentionally small.

It mainly says:

- here is the wake reason
- begin heartbeat
- load the `paperclip` skill
- run the env export block from `AGENTS.md`

That is a subtle but important design signal:

most of the runtime context is not being jammed into one giant user message.

Instead, context is distributed across:

- AGENTS.md
- env vars
- skills
- short prompt

This is a fairly sophisticated runtime-shaping pattern.

## What This File Does Not Own

This file does not own:

- queueing
- budget checks
- workspace policy decisions
- persistence of heartbeat runs
- session state transitions in the database

Those remain heartbeat responsibilities.

The adapter only owns the concrete runtime handoff.

## Self-Check

You understand this file if you can answer:

1. Does Arceus currently execute work directly or via OpenCode?
2. Why does the adapter write `AGENTS.md` instead of using only one prompt?
3. Why is it valuable that the adapter returns a standardized `AdapterExecutionResult` instead of raw OpenCode output?
