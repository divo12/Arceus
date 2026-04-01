# `doc/Architecture.md`

Why it matters:

- This is the broad system map.
- It explains how UI, API, services, adapters, DB, and Hippocampus fit together.

Read focus:

- Request and execution flow.
- Main boundaries between subsystems.
- Which parts are TypeScript control plane versus external runtime.

Connections:

- Phase 1 uses this as the “bird’s-eye view” while reading startup code.
- Phase 4 and Phase 6 both become easier once you remember the boundaries here.

Questions:

- What are the main runtime subsystems?
- Which path handles normal HTTP requests versus agent execution?
- Where does Hippocampus sit relative to the server?

