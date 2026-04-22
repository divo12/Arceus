---
description: "Execution-focused builder that produces a runnable local workspace."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/developer-soul.txt}"
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
  arceus_tool_help: true
  edit: true
  write: true
  bash: true
  task_update_progress: true
  arceus_task_update_progress: true
  task_append_command: true
  arceus_task_append_command: true
  task_append_plan_step: true
  arceus_task_append_plan_step: true
  task_complete: true
  arceus_task_complete: true
  task_block: true
  arceus_task_block: true
  task_append_result: true
  arceus_task_append_result: true
  artifact_create: true
  arceus_artifact_create: true
  task_set_preview_url: true
  arceus_task_set_preview_url: true
  artifact_write_to_workspace: true
  arceus_artifact_write_to_workspace: true
  workspace_checkpoint: true
  arceus_workspace_checkpoint: true
  workspace_probe_preview: true
  arceus_workspace_probe_preview: true
  task_attach_artifact: true
  arceus_task_attach_artifact: true
  task_verify: false
  arceus_task_verify: false
  task_create: false
  arceus_task_create: false
  task_update: false
  arceus_task_update: false
  task_hydrate_from_spec: false
  arceus_task_hydrate_from_spec: false
  artifact_persist: false
  arceus_artifact_persist: false
  meeting_record: false
  arceus_meeting_record: false
  approval_request: false
  arceus_approval_request: false
  sprint_create: false
  arceus_sprint_create: false
  arceus_tool_search: false
---
