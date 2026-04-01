# `server/src/services/role-definitions.ts`

This guide explains [`server/src/services/role-definitions.ts`](/Users/divyansh/Arceus/server/src/services/role-definitions.ts) as the role-template service for a company.

If you want one sentence first:

`role-definitions.ts` owns reusable role templates that describe what a role means for governance and runtime behavior, separate from any one concrete agent record.

## Mental Model

One of the easiest mistakes in this repo is to think:

“agent role” and “role definition” mean the same thing.

They do not.

An agent row means:

- this specific agent exists
- with this identity
- in this company

A role definition means:

- what this role is supposed to mean
- what it may delegate to
- what it may spawn
- what reusable template/governance behavior belongs to it

So role definitions are the reusable policy layer behind concrete agents.

## What This File Owns

This file owns:

- listing role definitions for a company
- fetching by slug or id
- creating custom role definitions
- updating existing role definitions
- seeding built-in role definitions for a company
- resolving which role definition applies to an agent
- backfilling `roleDefinitionId` links onto agent rows

This is not just CRUD. It is the place where role templates become real company-level governance data.

## 1. Why This Service Exists At All

Without this file, all role meaning would have to live directly inside each agent row.

That would be bad because:

- every agent would duplicate the same policy meaning
- changing role behavior across a company would be painful
- governance would be tied too tightly to single-agent records

This service exists to separate:

- reusable role meaning

from:

- one concrete agent instance

That is a good system design choice.

## 2. `list`, `getBySlug`, `getById`

These are the read surface of the service.

They let the rest of the system say:

- show all role definitions for this company
- find the role template called `cto`
- fetch a role definition by id

### Why slug matters

The slug is the stable role identity inside a company.

That is what lets an agent role like `cto` map back to the correct reusable definition.

## 3. `create(...)`

This creates a new role definition for a company and marks it as not built-in.

That distinction matters.

The system supports:

- seeded built-in roles
- company-defined custom roles

So the service has to preserve the difference.

## 4. `update(...)`

This function is small but reveals a strong invariant:

built-in roles cannot have their slug or built-in status changed.

Why?

Because built-in roles are part of the system’s core vocabulary.

If the slug of a built-in role could drift arbitrarily, many governance assumptions would become brittle.

So this service protects the stable identity of built-in roles while still allowing safe updates to other fields.

## 5. `seedForCompany(...)`

This is one of the most important methods in the file.

When a company is set up, it may need the default role definitions that Paperclip expects.

This method:

- loads existing role slugs for the company
- compares them against `ROLE_DEFINITION_SEEDS`
- inserts only the missing ones

That means seeding is additive and idempotent.

That is exactly what you want from setup logic.

## 6. `getForAgent(...)`

This method is one of the best examples of how the service connects templates to real agents.

It works in two steps:

1. if the agent has `roleDefinitionId`, use that explicit link
2. otherwise fall back to matching role-definition slug with the agent’s `role`

This is a very practical design.

It supports both:

- explicit modern linkage
- fallback compatibility for older or partially linked data

That makes the system easier to evolve without breaking everything at once.

## 7. `backfillAgentRoleLinks(...)`

This method upgrades company data by filling in missing `roleDefinitionId` values based on role slug matches.

Why does this matter?

Because a system that grows over time often needs a bridge from:

- old shape

to:

- richer new shape

This method is that bridge.

It says:

“if an agent is unlinked but we can infer the correct role definition from its role slug, attach the link now.”

## Technical Thinking

The deepest idea in this file is not any one query.

It is the separation of:

- reusable governance template
- concrete runtime employee/agent

That separation is what allows delegation rules, spawn rules, and role prompts to be managed cleanly.

## What This File Does Not Own

This file does not decide:

- whether delegation is allowed in a specific handoff
- whether an agent can spawn right now
- what the org hierarchy currently is

Those belong to:

- [`delegation-guard-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/delegation-guard-ts.md)
- [`spawn-governance-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/spawn-governance-ts.md)
- [`hierarchy-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/hierarchy-ts.md)

Role definitions provide policy material that those systems consume.

## Self-Check

You understand this file if you can answer:

1. Why does the system need both `agent.role` and `roleDefinitionId`?
2. Why is `getForAgent(...)` designed with both explicit-link and slug fallback behavior?
3. Why is built-in role identity protected during updates?
