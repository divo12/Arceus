# Phase 3 Exercise

This exercise is how you turn the Phase 3 docs from “I read it” into “I actually get it.”

Do not try to trace every feature.

Trace one feature cleanly.

## Best First Exercise

Trace the “agent list” flow from screen to backend and back.

Use these files in order:

1. [`ui/src/App.tsx`](/Users/divyansh/Arceus/ui/src/App.tsx)
2. [`ui/src/pages/Agents.tsx`](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx)
3. [`ui/src/api/agents.ts`](/Users/divyansh/Arceus/ui/src/api/agents.ts)
4. [`server/src/routes/agents.ts`](/Users/divyansh/Arceus/server/src/routes/agents.ts)
5. [`server/src/services/agents.ts`](/Users/divyansh/Arceus/server/src/services/agents.ts)
6. [`packages/db/src/schema/index.ts`](/Users/divyansh/Arceus/packages/db/src/schema/index.ts)

## What To Write Down

Write one short answer for each:

1. Which route in `App.tsx` sends the user to the agents page?
2. Which query in `Agents.tsx` loads the agent rows?
3. Which API wrapper function does that query call?
4. Which backend endpoint handles it?
5. Which service method actually runs?
6. Which table is the durable source underneath it?
7. What extra information gets merged in from heartbeat runs before rendering?

## Second Exercise

Trace one “active change” operation, not just a read.

Good choices:

- pause agent
- resume agent
- wake agent
- reset runtime session

For that action, answer:

1. Which UI control triggers it?
2. Which frontend API wrapper method sends it?
3. Which route handles it?
4. Which service or heartbeat method is called?
5. What persisted state might change?

## Why This Exercise Matters

If you can do one full trace without guessing, the repo stops feeling magical.

You start seeing a repeated architecture pattern instead:

- page
- API wrapper
- route
- service
- schema

That pattern appears all over the system.

## Self-Check

You are ready for Phase 4 if you can explain one agent action in plain English from:

“user clicked something”

all the way to:

“these tables or runtime records changed, and this response came back.”
