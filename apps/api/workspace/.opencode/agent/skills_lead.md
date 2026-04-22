---
description: "Operational specialist that authors and maintains reusable skills for the company."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/skills-lead-soul.txt}"
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
  workspace_checkpoint: true
  arceus_workspace_checkpoint: true
  artifact_persist: true
  arceus_artifact_persist: true
  meeting_record: true
  arceus_meeting_record: true
  approval_request: true
  arceus_approval_request: true
  task_attach_artifact: true
  arceus_task_attach_artifact: true
  task_set_preview_url: false
  arceus_task_set_preview_url: false
  task_verify: false
  arceus_task_verify: false
  artifact_write_to_workspace: false
  arceus_artifact_write_to_workspace: false
  workspace_probe_preview: false
  arceus_workspace_probe_preview: false
  task_create: false
  arceus_task_create: false
  task_update: false
  arceus_task_update: false
  task_hydrate_from_spec: false
  arceus_task_hydrate_from_spec: false
  sprint_create: false
  arceus_sprint_create: false
  arceus_tool_search: false
---
