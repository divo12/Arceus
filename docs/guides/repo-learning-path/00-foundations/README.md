# Phase 0: Foundations

This phase is not “pre-reading.” It is part of the architecture.

Paperclip is product-shaped software. A lot of code only makes sense once you understand that the repo is not trying to be a generic LLM runner. It is trying to be a control plane for AI-agent companies.

## Mental Model

These docs define the nouns, rules, and product promises that the code keeps implementing.

Without them, many backend choices look overbuilt.

With them, the code reads more like “this route enforces the model” and less like “why is there so much ceremony?”

## Read Order

1. [`goal.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/00-foundations/goal.md)
2. [`product.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/00-foundations/product.md)
3. [`spec-implementation.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/00-foundations/spec-implementation.md)
4. [`database.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/00-foundations/database.md)
5. [`architecture.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/00-foundations/architecture.md)

## What To Learn Here

- why the product exists at all
- what the primary domain objects are
- which behaviors are V1 contract versus future vision
- what the system persists and why
- how the control plane, execution layer, and memory/runtime pieces relate

## Technical Thinking

When you read these docs, keep translating product language into code questions.

Examples:

- “company-scoped” becomes “where do routes enforce company access?”
- “approval gates” becomes “which mutations branch into approvals instead of direct writes?”
- “heartbeat” becomes “which service owns execution scheduling and run state?”
- “AI company” becomes “why do roles, hierarchy, and delegation exist as first-class services?”

## Checkpoint

You are ready for phase 1 when you can say, in plain English:

- what Paperclip is
- what an agent is in this system
- why heartbeat exists
- why governance is part of the product, not extra decoration
