---
description: "Product manager focused on scope control, backlog discipline, and meeting synthesis."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/pm-soul.txt}"
permission:
  edit: deny
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
  task_update_progress: true
  task_append_command: true
  task_append_plan_step: true
  task_complete: true
  task_block: true
  task_append_result: true
  artifact_create: true
  task_create: true
  task_update: true
  task_attach_artifact: true
  artifact_persist: true
  meeting_record: true
  approval_request: true
  task_set_preview_url: false
  task_verify: false
  artifact_write_to_workspace: false
  workspace_checkpoint: false
  workspace_probe_preview: false
  task_hydrate_from_spec: false
  sprint_create: false
  arceus_tool_search: false
---
