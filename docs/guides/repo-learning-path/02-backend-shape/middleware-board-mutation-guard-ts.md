# `server/src/middleware/board-mutation-guard.ts`

## Mental Model

This file is an **extra safety check** for powerful board write actions.

It does not replace login.

It adds another question:

`Even if this request is from a board actor, did it come from a trusted browser origin?`

## Why this exists

Board users are powerful.

They can create agents, change settings, pause work, and do many other high-impact actions.

So the backend wants an extra layer of protection for board **mutations**.

This is called defense in depth:

- one layer = authentication
- another layer = authorization
- another layer = trusted browser origin for board writes

## What This File Owns

This file owns:

- identifying safe HTTP methods
- parsing `Origin` and `Referer`
- building the list of trusted origins
- allowing local development behavior
- rejecting suspicious board mutations

It does **not** care about business logic like agents or issues.

It only cares about request safety.

## Step-By-Step Flow

### Step 1: define safe methods

At the top, the file defines:

- `GET`
- `HEAD`
- `OPTIONS`

as safe methods.

That means read-only requests are not blocked by this guard.

Why?

Because this middleware is about **mutations**.

### Step 2: define default dev origins

It includes:

- `http://localhost:3100`
- `http://127.0.0.1:3100`

These are development browser origins that should be trusted by default.

### Step 3: parse origin values safely

`parseOrigin(...)` takes a header value like:

- `Origin`
- or `Referer`

and tries to reduce it to:

- protocol + host

If parsing fails, it returns `null`.

That means malformed headers do not accidentally count as trusted.

### Step 4: build the trusted origins set

`trustedOriginsForRequest(req)` creates the set of allowed origins.

It starts with the default dev origins, then adds:

- `http://<host>`
- `https://<host>`

using the request’s `Host` header.

So the trusted set is:

- some known local dev origins
- plus the current host the request is addressed to

### Step 5: compare request origin/referer against trusted origins

`isTrustedBoardMutationRequest(req)` checks:

1. if the `Origin` header is trusted
2. if not, whether the `Referer` origin is trusted

If neither matches, the request is treated as untrusted.

## `boardMutationGuard()`: the decision tree

This is the real middleware.

It checks requests in this order.

### Rule 1: safe methods always pass

If the method is `GET`, `HEAD`, or `OPTIONS`, the middleware immediately allows it.

### Rule 2: non-board actors are ignored

If the actor is not a board actor, the middleware does nothing.

Why?

Because this guard is specifically for **board mutations**.

It is not trying to protect every request in the system.

### Rule 3: local implicit board bypasses the origin check

If the board actor source is `local_implicit`, the request is allowed.

This is important for development.

The comment in the code explains why:

some local clients, especially multipart uploads, may omit origin/referer headers.

If the server blocked those, local development would become frustrating or broken.

### Rule 4: authenticated board writes must come from a trusted browser origin

If the actor is a normal authenticated board caller and the request is mutating, then:

- the request must pass `isTrustedBoardMutationRequest(req)`

If it fails, the middleware returns:

- `403 Board mutation requires trusted browser origin`

That is the final protection.

## What this means in plain English

The file is saying:

“Powerful board write requests should not come from just anywhere.”

That is a browser-safety rule layered on top of user identity.

## Why this is middleware and not route code

Because many route files support board mutations.

If every route repeated this check, you would get:

- duplicated code
- inconsistent behavior
- future mistakes

Middleware is perfect for rules like:

“all board mutations should pass this same safety test.”

## Beginner-Friendly Summary

Think of this as a second security guard.

The first guard checks:

- “are you a board user?”

This guard checks:

- “did you walk in through a trusted front door?”

That extra check matters because board users are very powerful.

## Self-Check

- Why are `GET` requests treated differently from `POST` or `PATCH`?
- Why does local implicit board mode skip the origin check?
- What problem would happen if each route had to implement this logic itself?
- Why is this file about *request safety* rather than *business rules*?
