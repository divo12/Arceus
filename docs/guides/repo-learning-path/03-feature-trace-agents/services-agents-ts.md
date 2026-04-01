# `server/src/services/agents.ts`

This guide explains [`server/src/services/agents.ts`](/Users/divyansh/Arceus/server/src/services/agents.ts) as the agent domain service.

If you want one sentence first:

`services/agents.ts` is where agent-related business rules live: naming rules, manager checks, configuration revision tracking, API key handling, org-tree construction, and read/write orchestration against the database.

## Mental Model

If the route file is the receptionist, the service file is the operations manager.

The route says:

- who is calling
- whether the request shape is allowed

The service says:

- what should really happen
- which tables must be touched
- which invariants must hold

This is one of the most important backend distinctions in the repo.

## What This File Owns

This file owns:

- agent creation/update behavior
- manager and role consistency checks
- URL-key and shortname collision handling
- configuration revision snapshots and rollback behavior
- API key creation/revocation
- org tree building
- chain-of-command lookup
- agent lookup by id or shortname-like reference

This is real domain logic, not just database wiring.

## 1. Token And Hash Helpers

At the top, the file defines:

- `hashToken(...)`
- `createToken()`

These support agent API keys.

The important design idea is:

- keys are created as plain tokens once
- persisted form is hashed

That means the system treats credentials with more care than ordinary fields.

## 2. Configuration Revision Helpers

This is one of the most educational parts of the file.

The file defines:

- `CONFIG_REVISION_FIELDS`
- `buildConfigSnapshot(...)`
- `diffConfigSnapshot(...)`
- `configPatchFromSnapshot(...)`

These helpers reveal a strong product idea:

an agent’s configuration is important enough to version and roll back.

So the service is not only updating rows. It is managing configuration history.

### What a snapshot means here

A snapshot is a selected set of config-related fields such as:

- name
- role
- title
- reportsTo
- adapter type/config
- runtime config
- budget
- metadata

The service sanitizes and compares these so config revisions can be recorded meaningfully.

This is much richer than plain CRUD.

## 3. Collision And Naming Helpers

The file also defines:

- `hasAgentShortnameCollision(...)`
- `deduplicateAgentName(...)`

These exist because Paperclip lets humans navigate agents by human-friendly identifiers derived from names.

That creates a real problem:

- humans want nice names
- URLs want stable references
- names can collide

So the service owns the rules for dealing with those collisions.

This is domain logic because it encodes a product decision, not merely a database fact.

## 4. `agentService(db)`: Factory For The Agent Domain API

The main export is `agentService(db)`.

This pattern is common in the backend:

- pass in the DB handle
- get back a bundle of domain operations

Inside, the file defines private helpers and then returns public methods.

That returned object is the real service API.

## 5. Read Helpers And Normalization

Several helpers prepare rows into app-ready shapes:

- spend hydration for the current month
- URL key derivation
- permission normalization
- `getById(...)`

Why is this useful?

Because database rows are not always the same thing as the shape the app wants to use.

The service layer often upgrades raw stored data into:

- business-ready
- UI-ready
- permission-normalized

forms.

## 6. Create Flow

The `create(...)` method is where multiple rules come together:

- validate manager relationship if present
- normalize/deduplicate naming concerns
- persist the agent row
- record configuration revision if needed

This is exactly why service files exist.

If you shoved this into the route file, the HTTP layer and domain layer would get tangled together.

## 7. Lifecycle Operations

Public methods like:

- `pause(...)`
- `resume(...)`
- `terminate(...)`
- `remove(...)`
- `activatePendingApproval(...)`

show that status changes are modeled as named operations, not just free-form field edits.

That is an important backend design choice.

It means the service can centralize lifecycle invariants and side effects.

## 8. Permission Updates

`updatePermissions(...)` is another good example of service ownership.

Permissions are not just raw JSON the UI should write directly.

The service is where those permissions are normalized into a consistent internal shape.

That keeps rules around agent authority from leaking all over the stack.

## 9. Config Revision Methods

The service exposes:

- `listConfigRevisions(...)`
- `getConfigRevision(...)`
- `rollbackConfigRevision(...)`

This is one of the clearest signs that Paperclip treats agents as important operational assets.

If configuration can affect runtime behavior, then version history and rollback are operational necessities.

The service owns that lifecycle because it is closest to:

- the current row
- the stored snapshots
- the rules for turning snapshots back into patches

## 10. API Key Methods

The service also exposes:

- `createApiKey(...)`
- `revokeKey(...)`

These methods show a healthy division of concerns:

- route file handles caller permissions
- service handles key generation and hashing

That is exactly the kind of split you want in a backend.

## 11. Org Structure Methods

Two especially important methods are:

- `orgForCompany(...)`
- `getChainOfCommand(...)`

These show that the agent model is not flat.

Agents belong to an organizational structure:

- who reports to whom
- which nodes appear in the org tree
- how command chains are derived

This is not just display fluff. It affects governance and delegation behavior in the product.

## 12. `resolveByReference(...)`

This method is another good learning example.

It handles the messy reality that a reference may be:

- UUID
- normalized URL key
- ambiguous human-facing shortname

The service returns structured results about:

- found agent
- no match
- ambiguity

This is the kind of backend niceness that helps the UI stay simpler and more predictable.

## 13. Hidden Theme: This File Upgrades Raw Storage Into Domain Semantics

The biggest idea in this service file is not any single method.

It is the pattern:

- read raw rows
- apply business rules
- produce meaningful agent behavior

That is why this file is one of the best places to learn the backend shape of the repo.

## What This File Does Not Own

This file does not own:

- HTTP validation schemas
- actor resolution
- direct route access policy
- heartbeat run execution

Those belong to:

- route files
- middleware
- heartbeat/adapters

Keeping that separation clear makes the backend much easier to reason about.

## Self-Check

You understand this file if you can answer:

1. Why do config revision helpers belong naturally in the service layer?
2. Why is `resolveByReference(...)` a service concern instead of a route concern?
3. Why are named lifecycle methods like `pause(...)` and `terminate(...)` healthier than generic field patching?
