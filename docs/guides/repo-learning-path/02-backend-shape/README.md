# Phase 2: Backend Shape

This phase is about learning how the backend is *organized*, not just what files exist.

If you are new to backend engineering, this is the simplest mental model to keep in your head:

- **middleware** = code that runs early for many requests
- **route file** = code that handles a URL like `/api/agents/:id`
- **service file** = code that contains the real domain rules and database work

In Paperclip, that pattern is used very consistently.

So when you feel lost, ask:

1. Is this file figuring out **who is calling**?
2. Is this file deciding **which URL does what**?
3. Is this file deciding **what business rule is allowed**?

Usually:

- question 1 means **middleware**
- question 2 means **route**
- question 3 means **service**

## Read Order

1. `[middleware-auth-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/middleware-auth-ts.md)`
2. `[routes-authz-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/routes-authz-ts.md)`
3. `[middleware-board-mutation-guard-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/middleware-board-mutation-guard-ts.md)`
4. `[services-index-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/services-index-ts.md)`
5. `[services-agents-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/services-agents-ts.md)`
6. `[routes-agents-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/routes-agents-ts.md)`

I changed the reading order on purpose.

For a beginner, it is much easier to understand the large `agents` route file *after* you understand:

- how identity is attached to a request
- how company access is checked
- what a service is doing for routes behind the scenes

## One Request Story

Here is the normal story of a request in this backend:

1. A request comes in.
2. `middleware/auth.ts` decides who the caller is and writes that to `req.actor`.
3. `routes/authz.ts` helpers are used by routes to ask:
  - is this a board user?
  - is this caller allowed inside this company?
4. `board-mutation-guard.ts` adds an extra safety check for powerful board write actions.
5. A route file like `routes/agents.ts`:
  - matches the URL
  - validates the payload
  - checks access
  - calls the service
6. A service file like `services/agents.ts`:
  - enforces rules
  - reads or writes the database
  - returns a clean result
7. The route sends the HTTP response back.

That is the backend skeleton.

## Why This Phase Matters

A lot of people get stuck because they open a big route file and expect it to teach them the whole system.

That rarely works.

The real trick is:

- first learn the **request skeleton**
- then learn the **domain rules**
- then the big route files become readable

## What You Should Understand After This Phase

You should be able to explain all of this in plain English:

- how a request learns who the actor is
- how company boundaries are enforced
- why routes are thinner than services
- why `routes/agents.ts` is huge but still not “the whole logic”
- why `services/agents.ts` is where many always-true rules live

## Beginner Translation

If you want the child-level version:

- middleware = security guard at the building entrance
- route file = receptionist who sees which desk you need
- service file = actual worker who does the job

That metaphor is not perfect, but it is very useful at first.

## Checkpoint

Before moving on, make sure you can answer these:

- If I send `GET /api/agents/123`, where does the backend first learn who I am?
- Where does the backend check whether I belong to the right company?
- Which file should decide “this agent name already conflicts with another one”?
- Which file should decide “this URL exists and returns JSON”?

