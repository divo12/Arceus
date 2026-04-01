# `server/src/routes/agents.ts`

This guide explains `[server/src/routes/agents.ts](/Users/divyansh/Arceus/server/src/routes/agents.ts)` as the backend HTTP map for the agent system.

If you want one sentence first:

`routes/agents.ts` is where web requests for agent-related operations are accepted, checked, normalized, and handed to deeper backend services.

## Mental Model

A route file sits between:

- the outside world
- the service layer

So this file answers questions like:

- which URL is allowed?
- what request body shape is allowed?
- who is calling?
- may this caller access this company or agent?
- which service method should handle this?
- how should the response be shaped or redacted?

That means a route file is a boundary layer, not the deepest logic layer.

## What This File Owns

This file owns:

- endpoint registration
- request validation
- actor and company access checks
- response redaction for restricted viewers
- activity around translating HTTP to service calls

It does not own:

- the full domain logic of creating or updating agents
- cost aggregation logic
- org computation logic
- config revision persistence logic

Those belong to `[server/src/services/agents.ts](/Users/divyansh/Arceus/server/src/services/agents.ts)` and related services.

## Why This File Is So Large

This file is huge because “agents” in Paperclip are not one simple resource.

The route surface covers:

- listing and org tree
- detail and configuration
- runtime state and task sessions
- create and hire flows
- permissions
- instructions bundle management
- pause/resume/terminate/delete
- keys
- wakeup and invoke
- heartbeat run inspection
- workspace operation logs

So the size reflects how central agents are to the product.

## Read This File In Clusters, Not Linearly

The route list is easiest if you read it in endpoint families.

## 1. Adapter/Skill Support Endpoints

Near the top of the route list, you see endpoints like:

- adapter models
- adapter environment testing
- agent skills
- skill sync

These routes exist because an agent is partly defined by:

- what adapter it uses
- what skill material is available in its runtime

These are not “run the agent” routes. They are runtime capability and setup routes.

## 2. Company-Level Agent Views

These are endpoints like:

- `GET /companies/:companyId/agents`
- `GET /companies/:companyId/org`
- `GET /companies/:companyId/org.svg`
- `GET /companies/:companyId/org.png`
- `GET /companies/:companyId/agent-configurations`

These routes answer questions about a company’s overall agent population.

Notice what the route layer does here:

- assert company access
- decide whether the viewer may read full config or only restricted views
- call the relevant service
- optionally redact the result

That is classic route-file work:

- permission gate
- response shaping

## 3. Self-Identity Endpoints

Endpoints like:

- `GET /agents/me`
- `GET /agents/me/inbox-lite`

show that the backend serves not only board operators but also authenticated agents themselves.

This is important for repo understanding.

Paperclip is not only a human dashboard. It is also a control plane that agents can call back into.

So the route layer must understand actor type:

- board user
- instance admin
- agent principal

## 4. Detail And Delegation Endpoints

These include:

- `GET /agents/:id`
- `GET /agents/:id/delegation-authority`
- `GET /agents/:id/can-delegate-to/:targetId`
- `GET /agents/:id/configuration`
- config revision endpoints

This cluster shows the route layer doing more than “load by id.”

It also:

- checks whether the caller may see sensitive configuration
- decides whether to return restricted detail
- exposes governance-related data like delegation authority

That is why it helps to stop thinking of agents as plain CRUD resources.

## 5. Runtime State Endpoints

These include:

- `GET /agents/:id/runtime-state`
- `GET /agents/:id/task-sessions`
- `POST /agents/:id/runtime-state/reset-session`

This cluster is your first strong hint that agent execution is stateful over time.

The route layer does not define what runtime state means, but it exposes it in a controlled way to the UI and operators.

## 6. Creation Routes: `hire` And `create`

There are separate creation-related routes:

- `POST /companies/:companyId/agent-hires`
- `POST /companies/:companyId/agents`

That separation matters.

It suggests the system distinguishes:

- ordinary create behavior
- governance-aware or approval-aware hiring flow

The route file is where those flows become explicit API surface.

This is a good example of how route design reveals product concepts.

## 7. Update And Configuration Routes

This cluster includes:

- `PATCH /agents/:id`
- `PATCH /agents/:id/permissions`
- instructions path/bundle/file routes
- config revision rollback

This is where the route layer shines as a safety boundary:

- validate body shape
- verify caller can update this agent
- log actor identity
- call service methods
- return updated shape

Routes are often the best place to see what the product is willing to expose as mutable state.

## 8. Lifecycle Routes

These are the operational control endpoints:

- pause
- resume
- terminate
- delete

This cluster matters because it shows the backend does not treat “agent status” as a dumb column the UI can patch freely.

Instead, status-changing actions are exposed as intentional verbs.

That is usually a sign of a well-modeled backend:

- the system wants lifecycle transitions to happen through named operations
- not arbitrary field editing

## 9. Key Management Routes

These routes handle:

- listing keys
- creating keys
- revoking keys

Again, this shows agents are principals in the system, not just records.

They can authenticate and call APIs.

## 10. Wakeup / Invoke / Run Inspection Routes

This cluster is where Phase 3 really starts touching Phase 4:

- `POST /agents/:id/wakeup`
- `POST /agents/:id/heartbeat/invoke`
- `GET /companies/:companyId/heartbeat-runs`
- `GET /heartbeat-runs/:runId`
- `GET /heartbeat-runs/:runId/events`
- `GET /heartbeat-runs/:runId/log`
- workspace operation endpoints

These routes expose runtime execution artifacts and control entrypoints.

The route layer’s job is:

- make them addressable
- make them secure
- make them understandable to the UI

The heartbeat engine will do the deeper execution work later.

## What To Notice In The Route Logic

Several patterns repeat throughout the file:

- load the agent or company
- assert company access
- assert board or permission requirements
- call a service or heartbeat helper
- redact if the caller is restricted
- return JSON or proper status codes

Once you see this repeating pattern, huge route files become much easier to parse.

## Why Redaction Shows Up Here

A subtle but important theme in this file is response redaction.

This file is one of the main places where the backend decides:

- who can see sensitive config
- who only gets restricted detail
- which runtime/session payloads should be sanitized before leaving the server

That is route-layer responsibility because this is the final boundary before data leaves the backend.

## How To Read This File Efficiently

Do not read all 2000+ lines as one story.

Read it like this:

1. find the endpoint cluster you care about
2. identify access guard
3. identify validation schema
4. identify service call
5. identify response shaping or redaction

That is the route-file pattern in this repo.

## Self-Check

You understand this file if you can answer:

1. Why is it useful that this file exposes many verbs like `pause`, `resume`, and `wakeup` instead of one generic patch?
2. Why does response redaction belong naturally in a route file?
3. How can the same backend file serve both board users and agent principals?

