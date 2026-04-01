# `server/src/services/agents.ts`

## Mental Model

This file is the **real agent business-logic file**.

If `routes/agents.ts` is the public counter where requests arrive, `services/agents.ts` is the office behind the counter where the actual rules are enforced.

This is the file that answers questions like:

- can this agent report to that manager?
- can a spawned agent have an employee role?
- is this name allowed?
- how do config revisions work?
- what does deleting an agent really mean?

So this file is much more than CRUD.

## What This File Owns

This service owns several kinds of logic.

### 1. Reading and normalizing agents

It reads agent rows and returns cleaned-up agent objects.

That includes:

- adding a stable `urlKey`
- normalizing permissions
- hydrating spend totals

### 2. Creation and update rules

It decides:

- when spawned agents are valid
- when manager relationships are valid
- when names collide
- how role definition links are resolved

### 3. Lifecycle rules

It handles:

- pause
- resume
- terminate
- delete
- activate pending approval

### 4. Config revision support

It stores snapshots of configuration changes so the system can:

- inspect revision history
- roll back to earlier configs

### 5. Org helpers

It also provides:

- org tree building
- chain-of-command traversal
- agent lookup by flexible reference

That is why this file is central to the agent domain.

## The Helper Layer: Why It Matters

Before you even reach the main service methods, the file defines lots of helper functions.

That is a clue:

the author is trying to centralize the rules that many agent operations share.

### `withUrlKey(...)`

This adds a stable URL-friendly key derived from the agent’s name.

That matters because users may refer to agents by:

- id
- or short human-friendly URL key

### `normalizeAgentRow(...)`

This is important.

It takes a raw DB row and improves it for the rest of the app by:

- adding `urlKey`
- normalizing permissions

That means raw database shape is not automatically the same as app-facing shape.

### Spend hydration helpers

The file calculates monthly spend from `costEvents`.

That means `spentMonthlyCents` is not just dumb table data here.

The service treats spend as something that may need to be derived or refreshed.

This is a good example of why services exist:

the app wants a richer answer than “just give me the row.”

## Core Read Methods

### `getById(id)`

This method:

1. loads the raw row
2. hydrates spend
3. normalizes the row
4. returns the final agent object

That means any caller using `getById(...)` gets the cleaner version, not a half-processed row.

### `list(companyId)`

This method lists company-scoped agents and normally excludes terminated ones.

That is important.

It means the service already has an opinion about what the normal “agent list” should mean.

Again, that is service logic, not just database logic.

## Creation Rules

The `create(...)` method is one of the best service examples in the repo.

It does a lot more than insert a row.

### Spawned vs employee agents

The file draws a strong distinction between:

- `employee`
- `spawned`

If an agent is spawned:

- it **must** have `spawnedByAgentId`
- it **cannot** use an employee role

If an agent is an employee:

- it **cannot** pretend to have `spawnedByAgentId`

That is a domain rule.

The database alone does not fully guarantee it.

### Manager validation

If the new agent is an employee and has `reportsTo`, the service checks that:

- the manager exists
- the manager belongs to the same company

So reporting lines are validated centrally here.

### Name deduplication

The file gathers existing agent names and runs `deduplicateAgentName(...)`.

That means the service is kind to callers:

- instead of immediately exploding on a simple same-name case,
- it can generate a safe unique version

But for shortname collisions during some updates, it can also reject with conflict.

### Role definition linking

The service also tries to resolve the effective role definition.

That means an agent is not only a name + adapter config.

It may also be linked into the governance system at creation time.

## Update Rules

The `updateAgent(...)` helper is one of the most important pieces of the file.

It enforces several always-true rules.

### Rule 1: terminated agents cannot come back casually

If an agent is terminated, the service blocks certain resurrection-like status changes.

### Rule 2: pending approval agents cannot be directly activated

That preserves the approval workflow.

### Rule 3: manager changes must stay valid

If `reportsTo` changes, the service:

- validates the manager
- prevents cycles

### Rule 4: names must not create shortname collisions

The service compares old and new shortnames and only runs collision checks when needed.

### Rule 5: permissions are normalized before writing

The file does not trust ad hoc permission shapes blindly.

It normalizes them based on role.

That keeps later code safer.

## Config Revision Logic

This is a big reason the service is not just CRUD.

When important config fields change, the service can:

1. build a sanitized “before” snapshot
2. build an “after” snapshot
3. diff the changed keys
4. store a config revision row

That gives the system a memory of important agent configuration changes.

### Why this belongs here

Because revision recording is tied to the meaning of an agent config change.

The route may trigger the change, but the service understands:

- which fields count as config
- how to sanitize them
- how to diff them
- when a revision should be recorded

That is domain logic.

## Lifecycle Methods

The file has several lifecycle methods that look simple but matter a lot.

### `pause(id, reason)`

Sets status to paused and records:

- pause reason
- paused time

### `resume(id)`

Moves back to idle, but blocks invalid resumes like:

- terminated agent
- pending approval agent

### `terminate(id)`

This is stronger than pause.

It:

- marks the agent terminated
- revokes API keys

That means termination has security consequences, not just a status label.

### `remove(id)`

This is the full delete path.

It runs a transaction and removes:

- reporting links from other agents
- run events
- task sessions
- heartbeat runs
- wakeup requests
- API keys
- runtime state
- then finally the agent row

That tells you deletion here is a deep cleanup operation, not just one table delete.

## Org Helpers

### `orgForCompany(companyId)`

This loads company agents and builds a nested reporting tree.

So the service does not store the org chart as prebuilt JSON.

It computes it from agent rows.

### `getChainOfCommand(agentId)`

This walks upward through managers to produce the reporting chain.

That is useful for detail screens and governance logic.

## Lookup by Reference

`resolveByReference(...)` is very user-friendly.

It allows lookup by:

- UUID-like id
- or normalized URL key

It also detects ambiguity.

That means the service is helping routes support flexible user-facing references safely.

## What this file does **not** do

It does not decide:

- what HTTP path maps to agent creation
- how request bodies are validated
- what response status code to send

That is route work.

This file decides what it means for an agent operation to be valid.

## Beginner-Friendly Summary

Think of this file as the “agent rules book.”

It says things like:

- spawned agents must behave differently from employee agents
- manager chains must not loop
- configs can be versioned
- termination revokes keys
- deleting an agent means cleaning up its related runtime records too

That is why this file is the heart of the agent domain.

## Self-Check

- Why is `create(...)` more than a database insert?
- Why is cycle prevention a service rule?
- Why does termination revoke keys?
- Why does config revision tracking belong in the service instead of a route?

