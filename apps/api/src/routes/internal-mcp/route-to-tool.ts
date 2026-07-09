/**
 * Spec 32 Phase 3 — derive a stable, human-readable tool name from a Fastify
 * route template (`req.routeOptions.url`) plus its method.
 *
 * Goal: every emit site uses the same tool name a developer would type when
 * searching Langfuse, so 'execute_tool task_claim' shows up exactly once
 * regardless of which physical handler fired the event.
 *
 * For unmapped routes we fall back to a generic, deterministic encoding
 * `${method}_${last_segment}` so even unknown tools still narrate.
 */

const TOOL_MAP: Record<string, string> = {
  // tasks
  "POST /api/internal/v1/tasks": "task_create",
  "PATCH /api/internal/v1/tasks/:taskId": "task_update",
  "GET /api/internal/v1/tasks/:taskId": "task_get",
  "POST /api/internal/v1/tasks/:taskId/claim": "task_claim",
  "POST /api/internal/v1/tasks/:taskId/completion": "task_complete",
  "POST /api/internal/v1/tasks/:taskId/block": "task_block",
  "POST /api/internal/v1/tasks/:taskId/verification": "task_verify",
  "POST /api/internal/v1/tasks/:taskId/results": "task_append_result",
  "POST /api/internal/v1/tasks/:taskId/commands": "task_append_command",
  "POST /api/internal/v1/tasks/:taskId/heartbeat": "task_set_heartbeat",
  "POST /api/internal/v1/tasks/:taskId/progress": "task_update_progress",
  "POST /api/internal/v1/tasks/:taskId/preview-url": "task_set_preview_url",
  "POST /api/internal/v1/tasks/:taskId/artifacts": "task_attach_artifact",
  "POST /api/internal/v1/tasks/:taskId/hydrate": "task_hydrate_from_spec",
  "POST /api/internal/v1/tasks/:taskId/bug-report": "task_report_bug",

  // artifacts
  "POST /api/internal/v1/artifacts": "artifact_create",
  "GET /api/internal/v1/artifacts/:artifactId": "artifact_get",
  "GET /api/internal/v1/artifacts": "artifact_list_sprint",
  "POST /api/internal/v1/artifacts/:artifactId/persist": "artifact_persist",
  "POST /api/internal/v1/artifacts/:artifactId/workspace": "artifact_write_to_workspace",

  // sprints
  "POST /api/internal/v1/sprints": "sprint_create",
  "GET /api/internal/v1/sprints/active": "sprint_get_active",
  "POST /api/internal/v1/sprints/:sprintId/finalize": "sprint_finalize",
  "POST /api/internal/v1/sprints/:sprintId/qa-gate": "sprint_run_qa_gate",
  "POST /api/internal/v1/sprints/:sprintId/final-gate": "sprint_run_final_gate",
  "GET /api/internal/v1/sprints/:sprintId/completion": "sprint_check_completion",

  // approvals
  "POST /api/internal/v1/approvals": "approval_request",
  "GET /api/internal/v1/approvals/:approvalId": "approval_get",
  "GET /api/internal/v1/approvals": "approval_list",
  "POST /api/internal/v1/approvals/:approvalId/decision": "approval_decide",

  // meetings
  "POST /api/internal/v1/meetings": "meeting_record",
  "GET /api/internal/v1/meetings/:meetingId": "meeting_get",
  "POST /api/internal/v1/meetings/decision": "meeting_request_decision",
  "POST /api/internal/v1/meetings/:meetingId/contributions": "meeting_contribute",
  "POST /api/internal/v1/meetings/request": "meeting_request",

  // company / execution
  "GET /api/internal/v1/company/summary": "company_get_summary",
  "POST /api/internal/v1/company/status": "company_set_status",
  "GET /api/internal/v1/agents/sessions": "agents_list_sessions",
  "GET /api/internal/v1/board/messages": "board_get_messages",
  "GET /api/internal/v1/execution/status": "execution_get_status",
  "POST /api/internal/v1/execution/cycle": "execution_complete_cycle",
  "POST /api/internal/v1/execution/pause": "execution_pause",
  "POST /api/internal/v1/execution/reconcile": "execution_reconcile",
  "POST /api/internal/v1/execution/stop": "execution_stop",

  // memory
  "POST /api/internal/v1/memory/search": "memory_search",
  "POST /api/internal/v1/memory/learnings": "memory_add_learning",
  "POST /api/internal/v1/memory/handoffs": "memory_handoff",

  // beats
  "GET /api/internal/v1/beats/last-progress": "beat_read_last_progress",

  // chat
  "POST /api/internal/v1/chat/cards": "chat_emit_card",

  // strategy
  "POST /api/internal/v1/strategy/apply": "strategy_apply",

  // workspace
  "POST /api/internal/v1/workspace/checkpoints": "workspace_checkpoint",
  "POST /api/internal/v1/workspaces/preview-start": "workspace_start_preview",
  "POST /api/internal/v1/workspace/preview-probe": "workspace_probe_preview",
  "GET /api/internal/v1/workspace/preview-url": "workspace_get_preview_url",
  "GET /api/internal/v1/workspace/build-health": "workspace_check_build_health",
  "GET /api/internal/v1/workspace/exports": "workspace_check_exports",
  "GET /api/internal/v1/workspace/baseline": "workspace_verify_baseline",
  "POST /api/internal/v1/workspaces/todo-write": "todo_write",
};

const lastSegment = (url: string): string => {
  const parts = url.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "unknown";
  return last.replace(/^:/, "").replace(/[^A-Za-z0-9_]/g, "_");
};

/**
 * Resolve `${method} ${routeUrl}` to a tool name.
 * Unmapped paths fall back to `${method.toLowerCase()}_${last_segment}`.
 */
export function routeToTool(method: string, routeUrl: string | undefined | null): string {
  if (!routeUrl) return "unknown";
  const key = `${method.toUpperCase()} ${routeUrl}`;
  const mapped = TOOL_MAP[key];
  if (mapped) return mapped;
  return `${method.toLowerCase()}_${lastSegment(routeUrl)}`;
}
