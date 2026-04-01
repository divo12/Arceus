# `server/src/middleware/auth.ts`

Why it matters:

- This is where request actor identity gets resolved into something the rest of the server can trust.

Read focus:

- board/user/agent actor resolution
- request enrichment
- failure paths for missing or invalid auth

Connections:

- Many routes assume `req.actor` already exists because this middleware ran first.
- Authenticated mode startup in `index.ts` wires the auth backend used here.

Questions:

- What kinds of actors can call the API?
- What data is attached to the request after auth succeeds?
- Which later access checks depend on this middleware?

