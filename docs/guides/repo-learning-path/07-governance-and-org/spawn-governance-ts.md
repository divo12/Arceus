# `server/src/services/spawn-governance.ts`

This guide explains [`server/src/services/spawn-governance.ts`](/Users/divyansh/Arceus/server/src/services/spawn-governance.ts) as the temporary-helper governance service.

If you want one sentence first:

`spawn-governance.ts` decides whether an agent may create a temporary spawned helper of a given role right now, based on role rules, active-spawn budget, and strict restrictions around spawned agents and employee roles.

## Mental Model

This file is not about hiring.

It is not about delegation.

It is about temporary runtime expansion.

That means the question is:

“may this agent create another short-lived helper agent now?”

This is different from:

- hiring a durable employee role
- assigning work to another existing employee

That distinction is why this service exists.

## What This File Owns

This file owns:

- counting active spawned agents for a parent
- calculating spawn budget
- checking whether a target role is allowed to be spawned
- blocking spawned-agent recursion
- blocking employee-role spawning
- asserting spawn permission cleanly for callers

This is a compact file, but it carries an important operational rule set.

## 1. Why Employee Roles Are Blocked

One of the strongest rules in the file is:

employee roles cannot be spawned.

That means roles that represent durable organization members must be hired through proper company governance, not created as temporary runtime helpers.

This is a very important product boundary.

It keeps the system from collapsing the difference between:

- real company structure

and:

- disposable runtime helpers

If that difference disappeared, governance would get muddy fast.

## 2. `getActiveSpawnCount(...)`

This function counts how many non-terminated spawned agents currently belong to a parent agent.

That count is operationally important because spawn governance is not only “is this role allowed in principle?”

It is also:

“has this agent already used up its temporary helper budget?”

So this file combines:

- policy authorization
- current live capacity state

## 3. `checkSpawnBudget(...)`

This method combines:

- role definition
- active spawn count

to calculate:

- active
- max
- remaining
- allowed types

This is the clearest summary surface of the file.

It tells the rest of the system:

- how much temporary helper capacity is left
- what kinds of helper roles are even legal

This is exactly the kind of thing the UI and adapter context may want to display.

## 4. `canSpawn(...)`

This is the main decision function.

Its flow is roughly:

1. load requesting agent and its role definition
2. reject if requesting agent does not exist
3. reject if requesting agent is itself spawned
4. reject if target role is an employee role
5. if no role definition exists, allow as permissive fallback
6. reject if target role is not in allowed spawn types
7. compute budget
8. reject if no remaining budget
9. otherwise allow

This is a very clean governance pipeline.

It separates:

- identity checks
- role-type checks
- policy checks
- capacity checks

## 5. Why Spawned Agents Cannot Spawn Other Agents

This is another very important invariant.

The system forbids spawned-agent recursion.

Why?

Because otherwise temporary helpers could create more temporary helpers, creating uncontrolled growth and blurry governance.

This file draws a hard line:

- durable company agents may spawn within limits
- spawned helpers may not recursively expand the system

That is a strong operational safety rule.

## 6. Permissive Fallback Again

Like delegation guard, this file allows a permissive fallback when no role definition exists.

That means:

- if governance templates are missing
- the system may still allow basic operation

This is a design choice worth noticing.

It trades strictness for graceful behavior when configuration is incomplete.

## 7. `assertCanSpawn(...)`

This is the assert-style wrapper used by callers that want a simple forbidden error on failure.

It keeps route or service callers cleaner and preserves one central place for spawn reasoning.

## Technical Thinking

The biggest idea in this file is:

spawning is a bounded runtime capability, not a substitute for company staffing.

That is why:

- employee roles are blocked
- spawned recursion is blocked
- active concurrent counts matter

This is exactly the kind of separation that keeps a multi-agent system understandable over time.

## What This File Does Not Own

This file does not:

- create the spawned agent row itself
- assign issues
- model reporting hierarchy

It only answers whether spawning is allowed under current governance and budget conditions.

## Self-Check

You understand this file if you can answer:

1. Why are employee roles forbidden as spawn targets?
2. Why is current active-spawn count part of governance instead of being just an informational metric?
3. Why is spawned recursion blocked so early and explicitly?
