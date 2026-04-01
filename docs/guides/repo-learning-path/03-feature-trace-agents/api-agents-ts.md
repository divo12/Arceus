# `ui/src/api/agents.ts`

This guide explains `[ui/src/api/agents.ts](/Users/divyansh/Arceus/ui/src/api/agents.ts)` as the frontend agent HTTP boundary.

If you want one sentence first:

`api/agents.ts` is the file that turns frontend intent like “list agents” or “pause this agent” into actual HTTP requests with stable paths and typed responses.

## Mental Model

This file is where React stops pretending the backend is “just data.”

Before this file:

- components think in terms of functions and objects

After this file:

- the world is HTTP paths
- query strings
- request bodies
- response status codes

So this file is a translator between:

- page language
- network language

## Why API Wrapper Files Exist

A beginner question is:

“Why doesn’t the page just call `fetch('/api/...')` directly?”

Because that would spread backend knowledge across many UI files.

This wrapper file centralizes:

- endpoint paths
- company scoping behavior
- typed return shapes
- small edge-case handling

That makes pages simpler and keeps backend contract changes easier to track.

## 1. Imported Types

At the top, the file imports many types from `[packages/shared/src/index.ts](/Users/divyansh/Arceus/packages/shared/src/index.ts)`:

- `Agent`
- `AgentDetail`
- `AgentRuntimeState`
- `AgentTaskSession`
- `HeartbeatRun`
- `AgentConfigRevision`
- and others

This matters because the UI is not inventing its own idea of an agent shape.

It is reusing a shared contract package so UI and backend stay aligned.

That is one of the most important monorepo patterns in Paperclip.

## 2. Local Interface Types

The file defines a few frontend-side interfaces too:

- `AgentKey`
- `AdapterModel`
- `ClaudeLoginResult`
- `OrgNode`
- `AgentHireResponse`
- `AgentDelegationAuthority`
- `AgentDelegationCheck`
- `AgentPermissionUpdate`
- `AvailableSkill`

Why local interfaces here?

Usually because these are API response/request shapes that are specific to this wrapper layer or not exported from shared exactly in that same form.

## 3. `withCompanyScope(...)`

This helper is small but important.

It appends `companyId` as a query parameter when needed.

That means one logical API function can work in both situations:

- when the company is already encoded in the route path
- when the backend endpoint wants explicit company scoping on an agent-specific path

This is part of how Paperclip keeps company boundaries explicit.

## 4. `agentPath(...)`

This helper builds `/agents/:id/...` paths consistently.

That may sound small, but it prevents repeated string-building bugs across many API methods.

It also makes the rest of the file read like a clean capability list instead of a giant collection of custom path strings.

## 5. `agentsApi`: The Real Capability Surface

This exported object is the real point of the file.

It groups the agent-related actions the UI can perform.

The easiest way to understand it is in categories.

### Read operations

- `list(companyId)`
- `org(companyId)`
- `get(id, companyId?)`
- `getConfiguration(...)`
- `listConfigRevisions(...)`
- `getConfigRevision(...)`
- `instructionsBundle(...)`
- `instructionsFile(...)`
- `skills(...)`
- `runtimeState(...)`
- `taskSessions(...)`
- `delegationAuthority(...)`
- `canDelegateTo(...)`
- `adapterModels(...)`

These mostly support screen loading and inspection.

### Mutation operations

- `create(...)`
- `hire(...)`
- `update(...)`
- `updatePermissions(...)`
- `rollbackConfigRevision(...)`
- `updateInstructionsBundle(...)`
- `saveInstructionsFile(...)`
- `deleteInstructionsFile(...)`
- `pause(...)`
- `resume(...)`
- `terminate(...)`
- `remove(...)`
- `syncSkills(...)`
- `createKey(...)`
- `revokeKey(...)`
- `resetSession(...)`
- `invoke(...)`
- `wakeup(...)`
- `loginWithClaude(...)`

These launch state changes or operational actions.

That makes this one file a very good summary of “what the frontend believes the agent system can do.”

## 6. `get(...)`: The Interesting Ambiguity Fallback

The most technically interesting method in this file is `get(...)`.

Normally it just calls the backend detail endpoint.

But if the backend returns `409` and the caller used a company-scoped shortname instead of a UUID, the function does extra work:

1. normalize the URL key
2. fetch the company’s agent list
3. ignore terminated agents
4. find matching live agent
5. retry the detail request with the real UUID

Why is this here?

Because the UI is smoothing over a user-facing ambiguity problem:

- humans like short names
- systems like unique IDs
- collisions can happen

This wrapper absorbs some of that complexity so page code stays cleaner.

This is a great example of a wrapper doing more than dumb transport.

## 7. Instructions, Skills, And Runtime APIs

This file is not only CRUD.

It also exposes operational surfaces:

- instruction bundle file management
- skill synchronization
- runtime state
- task sessions
- heartbeat invocation
- manual wakeups

That tells you something important about Paperclip:

agents are not simple rows you create and forget.

They are long-lived runtime actors with instruction material, execution history, and operational controls.

## 8. The Difference Between `invoke(...)` And `wakeup(...)`

Even before you read the heartbeat service, the API surface hints at an important distinction:

- `invoke(...)` hits `/heartbeat/invoke`
- `wakeup(...)` hits `/wakeup`

That strongly suggests the system distinguishes:

- directly asking for execution
- creating a wakeup request under the heartbeat machinery

This is one of the reasons API wrapper files are good learning tools: they reveal system concepts by the verbs they expose.

## 9. What This File Does Not Do

This file does not:

- validate business invariants
- enforce authorization
- know SQL tables
- decide how an agent is created internally

Those belong to the server.

This file only says:

“Here is how the browser talks to the server.”

## How To Read This File

Read it as a menu of browser capabilities.

For each method, ask:

1. What path does it call?
2. Is it read or write?
3. What input shape does it send?
4. What response shape does it expect?
5. Which page in the UI probably uses it?

That is much more useful than memorizing every method name.

## Self-Check

You understand this file if you can answer:

1. Why is `withCompanyScope(...)` important in a company-scoped product?
2. Why is `get(...)` more complex than a simple `api.get(...)` call?
3. What does this file tell you about the kinds of things humans can do to an agent from the UI?

