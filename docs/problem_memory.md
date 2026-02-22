# Problem Memory

Problem memory stores the initial problem statement and tracks improvements/changes as the agent learns from subagents, feedback, and iterations.

## Location

`data/state/problem_memory.json`

## Structure

```json
{
  "problems": {
    "<problem_id>": {
      "initial": "Original problem statement",
      "improvements": [
        {
          "text": "Improvement or new angle",
          "source": "subagent",
          "run_id": "run-uuid",
          "timestamp": "2025-02-19T12:00:00Z"
        }
      ],
      "run_ids": ["run-uuid"],
      "created_at": "...",
      "updated_at": "..."
    }
  }
}
```

## Usage

- **record_initial(problem, run_id)**: Called at the start of each AgentLoop run.
- **append_improvement(problem, improvement, source, run_id)**: Called when subagent results (new_angle, learnings) are merged.
- **get_problem_history(problem)**: Returns full history for a problem.

## Integration

- AgentLoop records the initial problem when a run starts.
- When `_merge_subagent_results` processes completed subagents, it appends `new_angle` and `learnings` to problem memory.
