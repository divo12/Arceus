# `server/src/services/heartbeat.ts`

Why it matters:

- This is one of the most important files in the repo.
- It is the execution orchestrator.

What to focus on:

- public API of the heartbeat service
- wakeup/enqueue logic
- run execution lifecycle
- adapter handoff
- log persistence, usage capture, recovery, and cleanup

Good reading passes:

1. find the service factory and public methods
2. trace `enqueueWakeup(...)`
3. trace `executeRun(...)`
4. trace recovery helpers like orphan reaping and queued-run resume

What this file owns:

- deciding whether work should run
- setting up context
- choosing adapter execution
- tracking run status
- storing excerpts, usage, events, and session state

Self-check:

- What is the difference between queued, running, and finished here?
- Where is memory injected before execution?
- Where is adapter execution recorded and normalized?

