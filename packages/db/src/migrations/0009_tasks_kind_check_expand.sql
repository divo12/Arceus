-- Migration 0009: expand tasks_kind_check to match contracts/src/tasks.ts taskKindSchema.
-- Original constraint only allowed:
--   standard, technical_plan, acceptance_spec, implementation, board_handoff,
--   service_validation, skill_apply_proposal
-- But the contracts schema (single source of truth) also allows:
--   local_preview, design_direction, qa_verification, launch_content,
--   distribution_campaign, skill_authoring, follow_up, bug_fix
-- The mismatch caused tester-created bug_fix tasks (and several others) to fail
-- persistence with pg=23514, so task_claim later returned not_found.
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK (
  "tasks"."kind" IN (
    'standard',
    'technical_plan',
    'acceptance_spec',
    'implementation',
    'board_handoff',
    'service_validation',
    'skill_apply_proposal',
    'local_preview',
    'design_direction',
    'qa_verification',
    'launch_content',
    'distribution_campaign',
    'skill_authoring',
    'follow_up',
    'bug_fix'
  )
);
