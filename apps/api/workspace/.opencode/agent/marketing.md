---
description: "Launch specialist that prepares positioning, campaigns, and distribution-ready copy."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/marketing-soul.txt}"
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
  arceus_tool_help: true
  edit: true
  write: true
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
  artifact_write_to_workspace: true
  arceus_artifact_write_to_workspace: true
  approval_request: true
  arceus_approval_request: true
  task_attach_artifact: true
  arceus_task_attach_artifact: true
  task_set_preview_url: false
  arceus_task_set_preview_url: false
  task_verify: false
  arceus_task_verify: false
  workspace_checkpoint: false
  arceus_workspace_checkpoint: false
  workspace_probe_preview: false
  arceus_workspace_probe_preview: false
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
  sprint_create: false
  arceus_sprint_create: false
  arceus_tool_search: false
---
