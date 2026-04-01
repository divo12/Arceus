# `server/src/adapters/arceus/index.ts`

Why it matters:

- This file tells the server what the Arceus adapter can do.

What to focus on:

- `type: "arceus"`
- `execute`
- model list
- skill support flags
- configuration doc block

What this file teaches:

- adapter modules advertise capabilities and metadata, not just execution code
- the server can list and inspect adapters without knowing their internals

Self-check:

- What does the server learn about Arceus from this file alone?
- Which function is the real execution handoff?
- What parts here are metadata versus behavior?

