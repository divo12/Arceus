# `doc/DATABASE.md`

## Mental Model

This file explains what the system chooses to persist.

That matters because persistence tells you what the product considers durable state versus transient runtime state.

## What This File Owns

- the major persisted entity families
- how runtime activity becomes stored records
- what must survive process restarts

## How To Read It

Do not read it as a table inventory.

Read it as an answer to:

- what parts of the business model need durable history?
- what runtime information must be recoverable?
- what future behavior depends on stored state instead of memory-only state?

## Technical Thinking

Paperclip is not only storing CRUD records.

It stores control-plane state:

- agent definitions
- issue and goal state
- heartbeat runs and events
- permissions and memberships
- execution workspaces and runtime services
- approvals, budgets, and activity logs

That tells you the backend is designed for replay, auditing, recovery, and governance, not just request/response CRUD.

## Self-Check

- Which runtime systems would break if their DB state disappeared?
- Which tables feel like business records versus operational state?
