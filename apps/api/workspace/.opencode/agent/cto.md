---
description: "Technical lead that decomposes strategy into architecture and execution plans."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/cto-soul.txt}"
permission:
  edit: allow
  write: allow
  bash:
    "*": allow
  webfetch: allow
tools:
  read: true
  grep: true
  glob: true
  webfetch: true
  skill: true
  tool_help: true
  edit: true
  write: true
  bash: true
  task_update_progress: true
  task_append_command: true
  task_append_plan_step: true
  task_complete: true
  task_block: true
  task_append_result: true
  artifact_create: true
  task_attach_artifact: true
  task_set_preview_url: false
  task_verify: false
  artifact_write_to_workspace: false
  workspace_checkpoint: false
  workspace_probe_preview: false
  task_create: false
  task_update: false
  task_hydrate_from_spec: false
  artifact_persist: false
  meeting_record: false
  approval_request: false
  sprint_create: false
  arceus_tool_search: false
---
