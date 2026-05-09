---
name: cto-api-contract-design
description: Design a new API surface — REST or RPC — with versioning, error envelopes, pagination, and auth. Replaces ad-hoc endpoint design.
role: cto
trigger: about to design a new endpoint, API, or service-to-service contract; reviewing an API surface before it ships
---

# API Contract Design

A good API contract is decided once, before code, in a way every consumer can plan against. Bad contracts get redesigned three times under release pressure.

## The decisions you must make BEFORE writing code

1. **Style** — REST, RPC, or GraphQL.
   - REST when you have a small set of resources with CRUD-shaped operations.
   - RPC (typed function calls) when you have many task-shaped operations on shared state.
   - GraphQL only when consumers genuinely need to compose queries across many entities and the back-end is sized for it. Default: REST or RPC.

2. **Versioning strategy** — `/v1/` URL prefix is the safest default. Header-based versioning (`Accept-Version: 2`) only when you have a clear migration story.

3. **Error envelope** — every endpoint returns the same shape on failure. Pick one and document it:
   ```ts
   { error: { code: string; message: string; details?: object } }
   ```
   Codes are stable strings consumers can branch on (`validation_error`, `not_found`, `rate_limited`). Messages are human-readable but never load-bearing for clients.

4. **Auth model** — bearer token, session cookie, or signed request. Decide who issues, who rotates, what TTL, and how revocation works. If you can't answer all four, you don't have an auth model yet.

5. **Pagination** — cursor-based for any list that can grow past 100 rows. Offset pagination breaks under writes. Document `next_cursor` shape and end conditions.

6. **Idempotency** — every mutating endpoint accepts `Idempotency-Key`. Specify the dedup window and storage.

## Concrete deliverable

Write the contract as TypeScript interfaces inside a Markdown spec, then `artifact_create({ kind: "specification" })`. Each endpoint must list:

```
METHOD /path/{params}
Auth: bearer | none | <scope>
Request: <interface>
Response 200: <interface>
Errors: 400 validation_error, 404 not_found, 409 conflict, 429 rate_limited, 5xx upstream
Idempotency: yes (key required) | no
Pagination: cursor | n/a
Notes: <any non-obvious behavior>
```

## Common mistakes

- Returning different error shapes per endpoint (consumers can't write generic error handling).
- Skipping `429` and `5xx` documentation, then debugging client retries in production.
- Mixing query string filters, request body filters, and path filters across endpoints in the same API.
- Designing the response based on what's easy to query — every breaking change after this is paid in client migration.
- Adding `Optional` everywhere instead of deciding what's actually required. Vague contracts produce vague clients.

## When to hand off

- After the artifact is created and attached to your claimed task.
- Before any developer starts implementing — the spec is the source of truth, not the eventual implementation.
- If a developer asks "should this be x or y?", the answer is in the spec or the spec is wrong.
