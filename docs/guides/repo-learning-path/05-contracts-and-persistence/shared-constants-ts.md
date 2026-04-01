# `packages/shared/src/constants.ts`

This guide explains [`packages/shared/src/constants.ts`](/Users/divyansh/Arceus/packages/shared/src/constants.ts) as the file that defines the legal value universes of the system.

If you want one sentence first:

`constants.ts` is where Paperclip defines the allowed words its product domains are allowed to use.

## 1. Why This File Is So Important

A lot of the repo uses plain text columns and string-based route payloads.

That might look loose at first.

But this file is the tightening layer.

It defines:

- which statuses are legal
- which roles are legal
- which adapter types are legal
- which invocation sources are legal
- which hierarchy states are legal
- which plugin states are legal

So even though storage and JSON payloads often use strings, they are not supposed to be “any string.”

They are supposed to come from the controlled vocabularies defined here.

## 2. The Main Pattern Used In This File

The file repeats the same pattern many times:

```ts
export const AGENT_STATUSES = [...] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
```

This pattern does two useful things at once:

1. creates a runtime array of allowed values
2. derives a TypeScript union type from that exact array

That means UI and server can both rely on:

- runtime enumerations
- compile-time literal unions

from the same source of truth.

This is one of the most important contract patterns in the whole repo.

## 3. How To Read The File

Do not read it top-to-bottom as one giant list.

Read it as grouped vocabularies.

## 3.1 Deployment and infrastructure vocabularies

Near the top:

- `DEPLOYMENT_MODES`
- `DEPLOYMENT_EXPOSURES`
- `AUTH_BASE_URL_MODES`
- `SECRET_PROVIDERS`
- `STORAGE_PROVIDERS`

These are startup/configuration vocabularies.

They define the legal environment and infra modes the backend understands.

## 3.2 Agent vocabularies

This cluster is one of the most important:

- `AGENT_STATUSES`
- `AGENT_ADAPTER_TYPES`
- `AGENT_ROLES`
- `AGENT_ROLE_LABELS`
- `AGENT_KINDS`
- `EMPLOYEE_ROLES`
- `DELEGATION_STYLES`
- `AGENT_ICON_NAMES`

This group tells you that the agent domain is not just “name + status.”

It has:

- organizational role semantics
- execution adapter semantics
- governance/delegation semantics
- UI-facing icon semantics

Also notice helper logic like:

```ts
export function isEmployeeRole(role: string): role is EmployeeRole
```

That means constants files in this repo are not always passive data dumps.

They sometimes contain small semantic helpers derived from those vocabularies.

## 3.3 Hierarchy and governance vocabularies

- `HIERARCHY_STATUSES`
- `HIERARCHY_EDGE_TYPES`
- `APPROVAL_TYPES`
- `APPROVAL_STATUSES`

This tells you the org/governance layer is explicit in the product model.

There is a real lifecycle around proposals, approvals, and hierarchy transitions.

## 3.4 Work-management vocabularies

- `ISSUE_STATUSES`
- `ISSUE_PRIORITIES`
- `ISSUE_ORIGIN_KINDS`
- `GOAL_LEVELS`
- `GOAL_STATUSES`
- `PROJECT_STATUSES`
- routine-related constants

These constants are the shared language for planning and execution units.

They influence:

- schema fields
- filters in UI
- route validation
- service branching logic

## 3.5 Runtime and heartbeat vocabularies

Further down in the file you get heartbeat-related sets like:

- invocation sources
- run statuses
- wakeup request statuses
- trigger details
- live event types

These matter because Paperclip is not only storing business data.

It is also storing runtime execution state and observability events.

## 3.6 Budget, cost, and finance vocabularies

This cluster includes:

- billing types
- finance event kinds
- finance directions/units
- budget scope types
- threshold types
- incident statuses

This tells you cost control is not an afterthought in the product model.

It has an explicit vocabulary just like agents and issues do.

## 3.7 Plugin vocabularies

The plugin-related constants later in the file are another strong architecture signal.

They show plugins are part of the shared system model, not a purely private server concern.

## 4. Why These Constants Matter Across Layers

This file is used by:

- shared type definitions
- shared validators
- UI label/filter logic
- server branching logic
- startup config resolution

That means changes here have wide ripple effects.

For example, adding a new agent adapter type may require:

- updating this file
- validating new payloads
- adjusting UI label maps
- updating backend adapter resolution
- possibly updating schema consumers and migrations

So this file is often one of the first contract files touched when product vocabulary expands.

## 5. Important Subtlety: This File Does Not Enforce Everything By Itself

It defines the legal vocabularies, but enforcement happens elsewhere:

- validators enforce incoming runtime payloads
- services enforce business invariants
- UI uses these sets for rendering and filtering
- schema stores the values durably

So this file is foundational, but not sufficient alone.

It is the vocabulary source, not the full policy engine.

## 6. What To Remember

- the `as const` + derived union pattern is the core design move
- this file defines legal value universes across many product domains
- text-based storage and payloads still depend on the strict vocabularies here
- changes here often imply cross-layer follow-up work

## Self-Check

- Why is `as const` plus a derived union type so powerful for shared contracts?
- Which constant groups are about infrastructure versus product versus runtime execution?
- Why would adding one new status or adapter type often require changes outside this file?
