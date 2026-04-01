# `server/src/adapters/arceus/execute.ts`

Why it matters:

- This is the runtime handoff for Arceus-backed execution.

What to focus on:

- env construction
- AGENTS.md writing
- skill injection
- OpenCode session creation
- sending the prompt to OpenCode
- reading tool invocations and final output

Important mental model:

- Arceus is not directly spawning shell commands itself here
- it prepares context and sends work to OpenCode
- OpenCode then handles actual tool/command execution

Connections:

- called by `heartbeat.ts`
- writes run context into an instruction file
- uses `OPENCODE_URL` and session/message HTTP calls

Self-check:

- What information is injected before the model starts?
- Why is AGENTS.md written for each run?
- Where does command execution capability actually live in this path?

