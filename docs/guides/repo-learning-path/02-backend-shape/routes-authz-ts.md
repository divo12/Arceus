# `server/src/routes/authz.ts`

## First: what is authorization?

Authorization means:

`Now that I know who you are, what are you allowed to do?`

So this file comes **after** authentication logic like `middleware/auth.ts`.

That earlier middleware says:

- this request is a board user
- or this request is an agent
- or this request is anonymous

This file then helps routes ask:

- is this actor allowed to be here?

## Mental Model

This is a tiny helper file, but it is one of the most important safety files in the backend.

It gives route files a simple vocabulary for common security checks.

Instead of every route writing its own custom logic, routes can call:

- `assertBoard(req)`
- `assertCompanyAccess(req, companyId)`
- `getActorInfo(req)`

That keeps route code cleaner and safer.

## What This File Owns

This file owns three kinds of route-level helper:

1. **board-only check**
2. **company boundary check**
3. **normalized actor info for logs and activity records**

It does **not** own full domain rules like:

- can this CEO spawn another agent?
- can this role delegate to that role?

Those belong to services.

## `assertBoard(req)`

This is the simplest function.

It checks:

- is `req.actor.type` equal to `"board"`?

If not, it throws a forbidden error.

### Why this helper exists

Many routes are board-only.

Instead of each route rewriting:

```ts
if (req.actor.type !== "board") ...
```

the route can call one helper and mean:

“only board users may continue.”

That is easier to read and less error-prone.

## `assertCompanyAccess(req, companyId)`

This is the most important function in the file.

Paperclip is strongly company-scoped, so many routes need to ask:

`Is this actor allowed inside this company?`

The helper checks that in three different ways depending on actor type.

### Case 1: actor is `none`

If the request is still anonymous, it throws unauthorized.

That means:

“you cannot touch company data if we do not know who you are.”

### Case 2: actor is an agent

If the actor is an agent, it checks:

- does `req.actor.companyId` equal the company id being requested?

If not, it throws forbidden.

That means agents are locked to their own company.

This is a very important invariant.

### Case 3: actor is a board user

Board access is more nuanced.

There are three board situations:

1. **local implicit board**
   This is the local development board user.
   It is trusted broadly.

2. **instance admin**
   This is a powerful authenticated board user with broad access.

3. **normal board user**
   This user only gets the companies listed in `req.actor.companyIds`.

So the helper says:

- if you are local implicit board, okay
- if you are instance admin, okay
- otherwise your `companyIds` must contain the company id

### Why this is so important

This is one of the main places where the backend enforces:

“just because you are authenticated does not mean you can see every company.”

That is core control-plane safety.

## `getActorInfo(req)`

This helper is not about permission. It is about **normalization**.

Routes often want to record activity like:

- who triggered this change?
- was it a user or an agent?
- which run did it belong to?

This helper returns a consistent shape for that.

### If the actor is an agent

It returns:

- `actorType = "agent"`
- `actorId = agentId`
- `agentId`
- `runId`

### If the actor is a board user

It returns:

- `actorType = "user"`
- `actorId = userId`
- `agentId = null`
- `runId`

### Why this matters

Activity logging is everywhere in this repo.

This helper keeps that logging consistent.

Without it, each route might shape actor metadata slightly differently.

## Why this file lives under `routes/`

Because these helpers are most useful right at the HTTP boundary.

They are not deep domain rules.

They are route questions like:

- is this the right actor type?
- can this caller cross this company boundary?
- how should this actor be recorded in route-triggered logs?

That makes this a route helper file, not a service file.

## Beginner-Friendly Summary

If `middleware/auth.ts` says:

“this person is Alice”,

then `routes/authz.ts` says:

“okay, but is Alice allowed in this room?”

And `getActorInfo(...)` says:

“when we write the event log, let’s describe Alice in a standard format.”

## Self-Check

- Why is company access checked here so often instead of only in the UI?
- Why are board users and agent users checked differently?
- What is the difference between `assertBoard(...)` and `assertCompanyAccess(...)`?
- Why is `getActorInfo(...)` useful even though it is only a few lines long?
