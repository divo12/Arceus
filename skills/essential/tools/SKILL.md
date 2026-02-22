---
name: tools
description: Reference for all available agent tools.
always: true
---

# Available Tools

This document describes the tools available to the PM agent.

## File Operations

### read_file
Read the contents of a file.
```
read_file(path: str) -> str
```

### write_file
Write content to a file (creates parent directories if needed).
```
write_file(path: str, content: str) -> str
```

### edit_file
Edit a file by replacing specific text.
```
edit_file(path: str, old_text: str, new_text: str) -> str
```

### list_dir
List contents of a directory.
```
list_dir(path: str) -> str
```

## Shell Execution

### exec
Execute a shell command and return output.
```
exec(command: str, working_dir: str = None) -> str
```

**Safety Notes:**
- Commands have a configurable timeout (default 60s)
- Dangerous commands are blocked (rm -rf, format, dd, shutdown, etc.)
- Output is truncated
- Optional `restrictToWorkspace` config to limit paths

## Web Access

### web_search
Search the web using Google Custom Search API.
```
web_search(query: str, count: int = 5) -> str
```

Returns search results with titles, URLs, and snippets. Requires `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`.

### web_fetch
Fetch and extract main content from a URL.
```
web_fetch(url: str, extractMode: str = "markdown", maxChars: int = 50000) -> str
```

**Notes:**
- Content is extracted using BeautifulSoup
- Supports markdown or plain text extraction
- Output is truncated at 50,000 characters by default

## Background Tasks

### spawn
Spawn a subagent to handle a task in the background.
```
spawn(task: str, label: str = None, skill_names: list[str] = None) -> str
```

Use for complex or time-consuming tasks that can run independently. The subagent completes the task and reports back (feedback, learnings, new_angle) in the next iteration.

## Scheduled Reminders (Cron)

Use the `cron` tool to create scheduled reminders and recurring tasks:

### Set a recurring reminder
```
cron(action="add", message="Good morning! ☀️", every_seconds=86400)
cron(action="add", message="Drink water! 💧", every_seconds=7200)
```

### Set a scheduled task (cron expression)
```
cron(action="add", message="Daily standup", cron_expr="0 9 * * *")
cron(action="add", message="Morning check", cron_expr="0 9 * * 1-5", tz="America/Vancouver")
```

### Set a one-time reminder
```
cron(action="add", message="Meeting starts now!", at="2026-02-21T15:00:00")
```

### Manage reminders
```
cron(action="list")
cron(action="remove", job_id="abc123")
```

## Heartbeat Task Management

The `HEARTBEAT.md` file in the workspace is checked periodically. Use file operations to manage recurring tasks:

### Add a heartbeat task
```python
edit_file(
    path="HEARTBEAT.md",
    old_text="## Example Tasks",
    new_text="- [ ] New periodic task here\n\n## Example Tasks"
)
```

### Remove a heartbeat task
```python
edit_file(
    path="HEARTBEAT.md",
    old_text="- [ ] Task to remove\n",
    new_text=""
)
```

### Rewrite all tasks
```python
write_file(
    path="HEARTBEAT.md",
    content="# Heartbeat Tasks\n\n- [ ] Task 1\n- [ ] Task 2\n"
)
```

---

## Adding Custom Tools

To add custom tools:
1. Create a class that extends `Tool` in `agents/tools/`
2. Implement `name`, `description`, `parameters`, and `execute`
3. Register it in `AgentLoop._build_default_registry()` or `SubagentManager._build_subagent_registry()`
4. Optionally add skill docs via the skill-creator skill
