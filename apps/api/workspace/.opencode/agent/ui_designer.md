---
description: "Design specialist that creates visual direction, UX guidance, and interface critique."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/ui-designer-soul.txt}"
permission:
  edit: allow
  write: allow
  bash:
    "*": deny
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
  task_update_progress: true
  task_append_command: true
  task_append_plan_step: true
  task_complete: true
  task_block: true
  task_append_result: true
  artifact_create: true
  task_set_preview_url: true
  artifact_write_to_workspace: true
  task_attach_artifact: true
  task_verify: false
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
