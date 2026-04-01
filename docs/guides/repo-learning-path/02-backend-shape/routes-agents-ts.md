# `server/src/routes/agents.ts`

## Mental Model

This file is the **public HTTP control panel for agents**.

It is one of the best “system map” files in the backend because the agent feature touches almost everything:

- auth
- company access
- approvals
- budgets
- skills
- instructions
- heartbeat runs
- org structure
- delegation
- spawning
- memory seeding

So if you want one file that shows how many moving parts Paperclip has, this is a great one.

## First: what is a route file?

A route file answers questions like:

- which URL exists?
- which HTTP method handles it?
- what request body is allowed?
- who may call it?
- which service should do the real work?
- what JSON should be returned?

That is exactly what this file does.

It is big because the **agent feature** is big, not because route files are supposed to contain all business logic.

## What This File Owns

This file owns four main kinds of work.

### 1. HTTP surface

It defines many endpoints like:

- list agents
- get one agent
- create/hire an agent
- update an agent
- manage keys
- manage instructions
- inspect runtime state
- wake an agent
- inspect heartbeat runs

### 2. edge validation and access checks

It checks:

- company access
- board-only actions
- whether an agent may manage another agent
- whether config data is readable
- whether instructions paths are manageable

### 3. route-layer shaping

It builds response shapes like:

- restricted agent view
- detailed agent view with chain of command and access
- scheduler heartbeat summaries
- org chart lean trees

### 4. service coordination

It calls into many services such as:

- `agentService`
- `heartbeatService`
- `accessService`
- `approvalService`
- `delegationGuardService`
- `spawnGovernanceService`
- `secretService`
- `companySkillService`

That means this file is a coordinator at the HTTP edge.

## How To Read This File Without Drowning

Do **not** read it endpoint by endpoint from top to bottom.

Instead, read it in layers.

## Layer 1: the collaborators at the top

At the start of `agentRoutes(db)`, the file constructs:

- `svc` for agent domain logic
- `access` for permission logic
- `approvalsSvc`
- `budgets`
- `delegationGuard`
- `heartbeat`
- `secretsSvc`
- `spawnGovernance`
- `instructions`
- `companySkills`
- `workspaceOperations`
- `instanceSettings`
- `roleDefs`

This is the first big clue about what “agent” means in this repo.

It is not just a row in a table.

An agent is connected to:

- governance
- runtime
- skills
- secrets
- memory
- org structure

## Layer 2: route-local helper functions

Before the real endpoints, the file defines many helper functions.

These are worth studying because they explain the route’s job.

### `buildAgentAccessState(...)`

This function computes a special view of what the agent can do, especially around task assignment.

It looks at:

- company membership
- grants
- CEO role
- whether the agent can create agents

This is not raw database logic.

It is route-layer response shaping.

### `buildAgentDetail(...)`

This builds a richer response for one agent by combining:

- the agent data
- chain of command
- access state

This is a classic route job:

take several backend facts and shape one useful response for the UI.

### permission/assert helper functions

There are several important helper gates:

- `assertCanCreateAgentsForCompany(...)`
- `assertCanReadConfigurations(...)`
- `assertCanUpdateAgent(...)`
- `assertCanReadAgent(...)`
- `assertCanManageInstructionsPath(...)`

These are route-level access decisions.

They answer things like:

- may this caller even try this action?
- may this agent view restricted config?
- may this caller mutate instructions path settings?

This keeps the endpoints themselves cleaner.

### `seedRoleDefinitionMemory(...)`

This is a very interesting helper.

When an agent has a role definition, the route may seed that role prompt into Hippocampus memory.

That means the route is not only “saving agent rows.”

It is also coordinating post-create side effects into the memory system.

## Layer 3: endpoint families

Now the file becomes easier if you read endpoint *families* rather than individual lines.

### Family A: adapter and skills endpoints

Examples:

- list adapter models
- test adapter environment
- list/sync agent skills

These endpoints are about:

- what runtime options are available
- whether a runtime is usable
- what skills an agent should have

They are more “agent runtime configuration” than “agent identity.”

### Family B: agent list and detail endpoints

Examples:

- list company agents
- get `/agents/me`
- get `/agents/:id`
- get org views
- get configuration snapshots

These endpoints are mostly about reading agent state.

But even here, the route sometimes returns:

- full detail
- or restricted detail

depending on who the caller is.

That is very important.

The backend does not assume everyone may see all configuration data.

### Family C: governance/authority endpoints

Examples:

- delegation authority
- can-delegate-to checks
- permissions updates

These endpoints expose governance rules in a way the UI can use.

So the agent route file is also one of the public entry points into company-governance behavior.

### Family D: runtime state and session endpoints

Examples:

- runtime state
- task sessions
- reset session

These are not normal CRUD endpoints.

They are operational endpoints.

They let operators inspect or reset execution continuity.

That is one of the clearest examples of Paperclip being a control plane.

### Family E: create and hire endpoints

There are two very important creation paths:

#### `/companies/:companyId/agent-hires`

This is the more governed path.

It supports:

- hire requests
- agent spawning
- approval creation when required
- linking source issues
- memory delegation events

This path is rich because it models a company hiring/spawning workflow.

#### `/companies/:companyId/agents`

This is the more direct create path.

It creates the agent, logs activity, grants default permissions, and sets up budget policy if needed.

### Why two creation paths?

Because the product distinguishes:

- a straightforward creation operation
- and a governed hire/spawn flow

That is product structure showing up in the routes.

### Family F: instructions and config endpoints

Examples:

- update instructions path
- get/update instructions bundle
- read/write/delete bundle files
- patch agent config
- config revision history
- rollback config revision

These endpoints show that Paperclip treats agent instructions as first-class managed configuration, not as a hidden text blob.

The route does a lot of careful work here:

- normalize adapter config
- sync instructions bundle paths
- validate whether the caller may manage those paths
- record config revisions

### Family G: lifecycle endpoints

Examples:

- pause
- resume
- terminate
- delete

These endpoints are simple to describe but operationally very important.

For example:

- pause and terminate cancel active heartbeat work
- delete removes the agent and logs the action

So even “simple” lifecycle routes often coordinate with runtime systems.

### Family H: key management endpoints

Examples:

- list keys
- create key
- revoke key

These are security-sensitive board actions.

They show that agents are also API principals, not just UI objects.

### Family I: heartbeat and execution endpoints

Examples:

- wakeup
- heartbeat invoke
- heartbeat runs list
- run detail
- cancel run
- run events
- run log
- workspace operation logs

These endpoints turn the agent route file into a runtime observability surface.

This is a huge deal.

It means the agent API is not only about creation and editing.

It is also how operators see and control execution.

## The Most Important Pattern In This File

The most important pattern is:

1. load target object if needed
2. check actor/company access
3. validate payload
4. normalize edge data
5. call service
6. log activity
7. return shaped response

That is the standard Paperclip route pattern.

Once you notice it, the file becomes much easier.

## What this file does **not** own

It does not own the final truth of:

- whether manager cycles are allowed
- whether spawned agents can be employee roles
- how revision diffs are stored
- how heartbeat runs actually execute

Those belong to services.

This file owns the **HTTP edge** and the **glue** between systems.

## Beginner-Friendly Summary

Think of this file like the giant front office for everything related to agents.

People come to this office to:

- look up agents
- hire them
- edit them
- give them keys
- wake them up
- inspect what they did

The office does not do all the deep work itself.

But it knows:

- who is allowed in
- which form they need
- which department should actually process the request

## Self-Check

- Why is this route file so much bigger than `routes/authz.ts`?
- Which parts of it are “read agent info” and which parts are “control agent execution”?
- Why are there separate create and hire paths?
- What are three examples of logic this file coordinates but does not deeply own?

