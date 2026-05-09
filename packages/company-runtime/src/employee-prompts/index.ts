/**
 * Per-role system prompts. Each file exports a single `<ROLE>_PROMPT` string
 * that gets wired into ROLE_SOULS in roles.ts. Splitting prompts out of
 * roles.ts keeps each role's system prompt readable, version-controlled
 * independently, and edit-friendly without scrolling through the full
 * souls table.
 *
 * Add a new role here: create `<role>.ts` exporting `<ROLE>_PROMPT`,
 * re-export below, then import + reference from roles.ts.
 */
export { DEVELOPER_PROMPT } from "./developer";
export { UI_DESIGNER_PROMPT } from "./ui-designer";
