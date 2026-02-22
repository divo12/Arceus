# Spawn + Feedback (Nanobot-Style)

The PM agent can spawn subagents for focused validation or research, and incorporates their results as feedback into the next iteration.

## Spawn Tool

Use the `spawn` tool when you need to:

- Validate a hypothesis with a specific PM framework (e.g. JTBD, PoL)
- Run focused web research that might take several steps
- Delegate a phase (e.g. validate) to a narrow-scope subagent

**Parameters:**

- `task` (required): The task for the subagent to complete
- `label` (optional): Short label for display
- `skill_names` (optional): List of PM skills to focus on, e.g. `["jobs-to-be-done", "pol-probe"]`

The subagent runs **synchronously** and returns its result directly. No MessageBus or channels.

## Feedback Construct

After tool execution (including spawn), the agent computes **feedback**:

- Web evidence count
- Subagent results (task + result)
- Tool result summaries

This feedback is:

1. Passed to `CognitiveLoop.run()` for reflection
2. Injected as a user message for the next iteration: `[Feedback from last iteration] ...`
3. Included in `runtime_context` for the provider

## Flow

```
Problem → Cognition → LLM + Tools (spawn, web_search, ...) → Feedback → next iteration or final answer
```

## Test

```bash
uv run python examples/test_spawn_feedback.py --check   # Verify spawn registered
uv run python examples/test_spawn_feedback.py           # Run spawn-encouraging problem
```
