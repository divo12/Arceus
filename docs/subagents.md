# Subagents

Subagents are spawned by the main PM agent to complete focused tasks in the background. They use tools and PM skills to produce **feedback**, **learnings**, and **new angles** that improve the main agent's response.

## Why Spawn Subagents?

- **Feedback**: The main agent uses 3–4 PM skills to solve a problem; spawned agents apply tools and skills to give feedback that improves the main agent's response.
- **Learnings**: Subagents can add insights to known skills or the knowledge base.
- **New angles**: Every subagent must suggest a new problem perspective for the main agent to validate and solve.
- **Decomposition**: When a problem breaks into many sub-problems, the main agent can spawn subagents to handle heavy sub-tasks.

## Architecture

| Component | Role |
|-----------|------|
| **AgentLoop** (`execution/agent_loop.py`) | Main PM agent loop; orchestrates cognition, provider, tools, feedback |
| **Agent** (`agents/agent.py`) | Spawned subagent class; runs focused task, produces structured output |
| **SubagentManager** (`execution/subagent_manager.py`) | Manages background spawns; queues completed results |
| **SpawnTool** (`agents/tools/spawn.py`) | Tool the main agent calls to spawn; returns immediately |

## Subagent Tools

Subagents have **SupportQueryTool** (`query_support_agent`), which the main agent does **not** have. This tool:

- Accepts `query`, `problem_or_skill`, and `research_context`
- Uses an LLM to suggest: new angles, problem structure, skill gaps/improvements, learnings
- Appends learnings to skill `references/Learnings.md` (does not modify SKILL.md)

## Subagent Behavior

- **Runs in background**: `asyncio.create_task`; main agent does not block.
- **Mandatory skill**: Every subagent always receives `skill-creator` in its skill focus list. When creating or updating Agent Skills, subagents must apply the skill-creator skill.
- **Similar to main loop**: Uses provider, tools, skills—but **no spawn tool**, **no cron**, **no dictation** of the main agent.
- **Structured output**: Each subagent must produce:
  - **Feedback**: How to improve the main agent's approach or response
  - **Learnings**: Actionable insights for skills/knowledge base
  - **New Angle**: A problem perspective the main agent should validate and consider solving
  - **Summary**: Brief summary of what was done and found

## Main Agent Behavior

- **Always takes feedback**: Polls `get_completed_results()` at the start of each iteration.
- **Validates before solving**: Alters its response based on whether it finds subagent feedback correct.
- **Integrates new angles**: New angles are merged into `prev_feedback` and presented for validation.

## Flow

1. Main agent calls `spawn(task, label?, skill_names?)` via SpawnTool.
2. SubagentManager starts a background task; returns status string immediately.
3. Subagent (Agent) runs with reduced registry (no spawn, no cron), uses PM skills as specified.
4. On completion, SubagentManager appends result to `_completed_results`.
5. At the start of the next iteration, AgentLoop calls `get_completed_results()` and merges into `prev_feedback`.
6. Feedback message (including new angles and learnings) is appended as a user message for the next cognition/provider cycle.
7. New angles and learnings are stored in **problem memory** (`data/state/problem_memory.json`) for the current problem.
