# `server/src/middleware/auth.ts`

## First: what is middleware?

Middleware is code that runs **before** the route handler.

It is usually used for shared work like:

- reading headers
- checking authentication
- attaching useful info to the request

So this file runs early and tries to answer one very important question:

`Who is making this request?`

## Mental Model

This file turns a raw HTTP request into a structured actor object on `req.actor`.

That actor can become one of these shapes:

- **board** = a human/operator style caller
- **agent** = an agent calling the API
- **none** = not authenticated yet

Everything later depends on that.

If this file gets the actor wrong, the rest of the backend cannot make safe decisions.

## What This File Owns

This file owns:

- deciding the **default actor**
- reading `Authorization` headers
- checking board session auth in authenticated mode
- checking agent API keys
- checking local agent JWTs
- attaching `runId` when the request belongs to a heartbeat run

It does **not** own full authorization like “can this actor access company X?”.

That comes later.

## The Big Idea

This middleware is not asking:

`What is this actor allowed to do?`

It is only asking:

`Who is this actor?`

That is the difference between:

- **authentication** = identity
- **authorization** = permission

This file is mostly about authentication.

## Step-By-Step Flow

### Step 1: set a default actor

At the top, the middleware sets `req.actor` immediately.

If deployment mode is `local_trusted`, it sets:

- type = `board`
- userId = `local-board`
- isInstanceAdmin = `true`
- source = `local_implicit`

That means in local trusted mode the backend starts by assuming:

“this request is from the local board operator.”

If deployment mode is not local trusted, it starts with:

- type = `none`

That means:

“we do not know who this is yet.”

### Why this matters

This is one of the most important differences between local development and authenticated deployment.

In local trusted mode:

- the backend is friendly and assumes a local operator

In authenticated mode:

- the backend starts by trusting nobody

## Step 2: read the run id header

The middleware reads `x-paperclip-run-id`.

This is important for agent/runtime requests.

It lets the backend tie some API calls back to a specific heartbeat run.

That means requests are not only about “who is calling?” but sometimes also “which run is this part of?”

## Step 3: if there is no bearer token, maybe try board session auth

The middleware checks the `Authorization` header.

If it does **not** start with `Bearer `, then it may still be a board user using session/cookie auth.

This only happens in authenticated mode and only if a session resolver was provided.

Then the middleware:

1. asks the auth system for the session
2. checks whether there is a real user id
3. looks up:
   - whether the user is an instance admin
   - which companies the user belongs to
4. writes a `board` actor onto `req.actor`

That actor includes:

- `userId`
- `companyIds`
- `isInstanceAdmin`
- `source = "session"`

### Why the company lookup happens here

Because later route files should not have to keep re-querying:

- “which companies does this board user belong to?”

This middleware does that once and stores the answer on the request.

That makes later code simpler.

## Step 4: if there is a bearer token, maybe it is an agent API key

If the request *does* have a bearer token, the middleware:

1. strips the `Bearer ` prefix
2. hashes the token
3. looks up the hashed value in `agentApiKeys`
4. ignores revoked keys

If a matching key is found:

1. it updates `lastUsedAt`
2. loads the agent row
3. makes sure the agent is still in a usable state
4. writes an `agent` actor to `req.actor`

That actor includes:

- `agentId`
- `companyId`
- `keyId`
- `runId` if present
- `source = "agent_key"`

## Step 5: if it is not an API key, maybe it is a local agent JWT

If the token is not a stored API key, the middleware tries one more thing:

- verify it as a local agent JWT

This is important because running agents may need to call back into the backend during execution.

That runtime path may use a JWT instead of a stored API key.

If the JWT is valid, the middleware:

1. loads the agent from the database
2. checks company match
3. checks that the agent is not terminated or pending approval
4. writes an `agent` actor with:
   - `source = "agent_jwt"`

### Why there are two agent auth paths

Because the system has two different use cases:

1. long-lived API keys for agent identity
2. runtime-issued JWTs for active execution contexts

That is why this file matters more than a normal auth middleware in a simple app.

## What the final `req.actor` gives to the rest of the backend

After this middleware runs, later code can safely ask things like:

- is this a board actor or agent actor?
- what is the company id?
- is this user an instance admin?
- what is the agent id?
- is this request connected to a run?

That is a huge simplification.

Without this middleware, every route would have to repeat a lot of fragile auth parsing.

## `requireBoard(...)`

At the bottom there is a tiny helper:

`requireBoard(req)`

It just checks whether the actor type is `board`.

It is small, but it shows the point of the file:

once `req.actor` is trustworthy, later code can ask very simple questions.

## What this file does **not** do

It does **not** decide:

- whether a board user can access a specific company
- whether an agent can mutate another agent
- whether a board user has a special permission

Those are later authorization questions.

This file only prepares the actor identity.

## Beginner-Friendly Summary

You can think of this file like a front-desk identity checker.

It looks at the request and asks:

- are you the local board?
- are you a logged-in human?
- are you an agent with an API key?
- are you an agent with a runtime JWT?

Then it writes the answer down so everybody else in the building can use it.

## Self-Check

- Why does local trusted mode start as board, but authenticated mode starts as none?
- Why does this file attach `companyIds` for board users?
- Why does the backend support both agent API keys and agent JWTs?
- What would break if routes had to do all this work themselves?
