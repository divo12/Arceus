# `ui/src/api/instanceSettings.ts`

Why it matters:

- Agent detail sometimes needs instance-level settings to interpret runtime behavior.

What to focus on:

- instance settings read/update calls
- why page behavior may depend on global config, not just company config

Connections:

- `AgentDetail.tsx` reads from here when surfacing environment/runtime settings
- not agent-specific, but still relevant to agent operations

Self-check:

- What is instance-scoped versus company-scoped?
- Why would an agent detail page care about instance settings?
- Which runtime questions can only be answered at the instance level?

