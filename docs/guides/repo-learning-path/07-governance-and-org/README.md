# Phase 7: Governance And Org Modeling

This phase is where Paperclip most clearly stops being “just an agent runner” and starts looking like a company operating system.

If earlier phases taught:

- how requests move
- how runs execute

this phase teaches:

- who agents are allowed to be
- who may hand work to whom
- who may create temporary helpers
- how org structure is proposed and activated
- where those rules are enforced in day-to-day issue flow

## The Core Mental Model

There are four different governance layers here, and they are easy to mix up if you read too fast:

### Role definitions

These say what a role means.

Examples:

- what roles it can delegate to
- what spawn rules it has
- what prompting/governance template it represents

### Delegation

This says whether one agent may hand work to another agent.

This is about task handoff.

### Spawning

This says whether one agent may create a temporary helper of some type right now.

This is about bounded runtime expansion.

### Hierarchy

This says what the org structure is supposed to be.

This is about reporting structure and versioned org design.

These systems are related, but they are not the same.

That separation is one of the most important design ideas in this phase.

## Beginner Translation

If you are new to governance modeling, use this translation:

- role definition = job template
- delegation = “can I assign this to that agent?”
- spawn = “can I create a temporary helper?”
- hierarchy = “who reports to whom?”

The repo keeps them separate because real organizations need those rules to differ.

Example:

- a CTO may delegate to engineers
- may spawn temporary specialist helpers
- may report to the CEO

Those are three different facts, not one.

## Read Order

1. [`role-definitions-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/role-definitions-ts.md)
2. [`delegation-guard-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/delegation-guard-ts.md)
3. [`spawn-governance-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/spawn-governance-ts.md)
4. [`hierarchy-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/hierarchy-ts.md)
5. [`roles-routes-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/roles-routes-ts.md)
6. [`hierarchy-routes-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/hierarchy-routes-ts.md)
7. [`issues-routes-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/issues-routes-ts.md)

## Why This Order

Start with services first so you understand the rules.

Then read route files so you can see how those rules become HTTP behavior and operator workflows.

End with issue routes because that is where abstract governance becomes daily operational behavior.

## What You Should Be Looking For

While reading Phase 7, keep asking:

1. Is this file defining a rule, or enforcing a rule?
2. Is this rule about permanent org structure, or temporary runtime behavior?
3. Is this file about who an agent is, or what an agent may do right now?

Those three questions make the whole phase much easier.

## What You Should Understand By The End

If this phase worked, you should be able to explain:

- why `agent.role` is not enough without role definitions
- why delegation is not the same as hierarchy
- why spawn governance exists separately from hiring
- why hierarchy uses proposal/approval/activation instead of raw row mutation
- how issue assignment routes enforce company governance in practice

## Self-Check

Before moving on, try answering these without opening code:

1. Why does Paperclip need both hierarchy and delegation?
2. Why are employee roles treated differently from spawned helper roles?
3. Where do governance rules stop being abstract and start affecting real issue assignment?
