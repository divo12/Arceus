# `server/src/routes/roles.ts`

This guide explains [`server/src/routes/roles.ts`](/Users/divyansh/Arceus/server/src/routes/roles.ts) as the HTTP surface for role governance.

If you want one sentence first:

`routes/roles.ts` exposes company-scoped role-definition reads plus board-controlled mutation endpoints so the UI can manage and inspect role templates safely.

## Mental Model

The service file defines what role definitions are.

This route file defines how the outside world is allowed to interact with them.

So this file is about:

- endpoints
- validation
- company access
- board-only mutation control

It is a classic route boundary layer.

## What This File Owns

This file owns:

- listing role definitions
- fetching one role definition by slug
- creating a role definition
- updating a role definition
- exposing an authority-matrix summary for one role

It does not own the deeper role-definition logic itself.

That remains in the service layer.

## 1. Read Endpoints

The first two routes:

- `GET /companies/:companyId/roles`
- `GET /companies/:companyId/roles/:slug`

are company-scoped reads.

They require company access, but they do not require board mutation authority because reading role definitions is less sensitive than changing them.

This is an important pattern:

- visibility and mutation often have different permission levels

## 2. Create Endpoint

`POST /companies/:companyId/roles`

This route uses:

- request validation schema
- `assertBoard`
- `assertCompanyAccess`

That means role creation is explicitly board-controlled.

This makes sense because role definitions shape company governance itself.

Allowing arbitrary agent-level creation of roles would be a major governance change, not a normal operational action.

## 3. Patch Endpoint

`PATCH /roles/:roleId`

This route:

- requires board authentication
- loads the existing role by id
- checks company access from the loaded role
- then delegates update logic to the service

This is a nice route pattern because it first resolves the resource, then derives scoping from the real row instead of trusting the caller to provide it.

## 4. `authority-matrix` Endpoint

`GET /roles/:roleId/authority-matrix`

This route is especially useful because it exposes structured governance data:

- `canDelegateTo`
- `delegationStyle`
- `spawnRules`

This is a strong design choice.

It means the authority behavior of a role is visible as explicit structured data, not buried only inside prompts or hidden implementation details.

That makes the system easier to inspect and explain.

## Technical Thinking

The most important thing to notice here is that role governance is treated as an explicit product surface.

The route file is small, but the existence of these endpoints tells you:

- roles are first-class company configuration
- role authority is something the UI should be able to inspect
- mutation is intentionally more restricted than reading

## What This File Does Not Own

This file does not:

- compute whether a particular delegation is allowed right now
- compute spawn budget
- backfill role links on agents

It only exposes the role-definition surface over HTTP.

## Self-Check

You understand this file if you can answer:

1. Why are role-definition mutations board-only?
2. Why is the authority matrix useful as a separate endpoint instead of requiring the UI to inspect raw role fields everywhere?
