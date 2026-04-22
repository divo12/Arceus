---
description: "Board-facing CEO that refines ideas, proposes strategy, and requests approvals."
mode: primary
model: azure/gpt-4.1
prompt: "{file:./.opencode/prompts/ceo-soul.txt}"
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
  task_hydrate_from_spec: true
  task_attach_artifact: true
  meeting_record: true
  sprint_create: true
  task_set_preview_url: false
  task_verify: false
  artifact_write_to_workspace: false
  workspace_checkpoint: false
  workspace_probe_preview: false
  task_update: false
  artifact_persist: false
  approval_request: false
  arceus_tool_search: false
---
