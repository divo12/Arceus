# Core Runtime API Reference

## `execution.agent_loop.AgentLoop`

### Constructor

```python
AgentLoop(
    workspace: Path,
    provider: Optional[ProviderAdapter] = None,
    registry: Optional[ToolRegistry] = None,
    max_iterations: int = 4,
)
```

### Methods

- `run(problem_description: str, context: Optional[dict] = None, max_iterations: Optional[int] = None) -> dict`
  - async core runtime loop
- `run_sync(problem_description: str, context: Optional[dict] = None, max_iterations: Optional[int] = None) -> dict`
  - sync wrapper for scripts/tests

### Return payload fields

- `run_id`: unique run identifier
- `messages`: accumulated system/user/assistant/tool messages
- `traces`: iteration-level trace objects
- `web_evidence`: extracted evidence summaries + sources
- `drafted_skills`: generated draft SKILL.md paths
- `final`: final provider response summary
- `memory_snapshot`: recent + persistent memory snapshot

## `providers.adapter`

### `ToolCall`

- `name: str`
- `arguments: dict[str, Any]`
- `call_id: str`

### `ProviderResponse`

- `content: str`
- `tool_calls: list[ToolCall]`
- `confidence: float`
- `done: bool`
- `rationale: str`

### `ProviderAdapter` protocol

```python
async def complete(
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]],
    iteration: int,
    runtime_context: dict[str, Any],
) -> ProviderResponse
```

## `agents.skills.SkillsLoader`

### New capability methods

- `detect_skill_gaps(plan: dict) -> list[dict[str, str]]`
  - finds phases with no mapped skills
- `create_skill_draft(skill_name: str, problem: str, rationale: str, evidence: Optional[list[Any]] = None) -> Path`
  - writes human-review draft skill spec under `_drafts`

## `cognition.cognitive_loop.CognitiveLoop.run`

### Inputs

- `problem_description`, `context`, `available_skills`
- optional: `available_prompts`, `run_id`, `iteration`, `web_evidence`, `action_result`

### Outputs

- `interpreted_state`, `reasoning`, `plan`, `decision`
- `reflection` (explicit reflect step output)
- `iteration_output` (`act` + `reflect`)
- `memory_snapshot`
