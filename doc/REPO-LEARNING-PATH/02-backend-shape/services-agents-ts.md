# `server/src/services/agents.ts`

Why it matters:

- This is the domain logic layer for agent records and related invariants.

Read focus:

- normalization of agent rows
- company-scoped reads and writes
- naming/url-key rules
- create/update/pause/resume/terminate/delete behavior
- org helpers such as chain-of-command and org tree support

Connections:

- `routes/agents.ts` depends on this file heavily.
- The DB schema in `packages/db/src/schema/agents.ts` becomes concrete here.

Questions:

- Which invariants are enforced before DB writes?
- Which helper functions are really “domain policy” in disguise?
- Where does this service stop and heartbeat/runtime behavior begin?

