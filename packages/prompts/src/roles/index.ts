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
export { CEO_PROMPT } from "./ceo";
export { CTO_PROMPT } from "./cto";
export { PM_PROMPT } from "./pm";
export { DEVELOPER_PROMPT } from "./developer";
export { TESTER_PROMPT } from "./tester";
export { UI_DESIGNER_PROMPT } from "./ui-designer";
export { MARKETING_PROMPT } from "./marketing";
export { SKILLS_LEAD_PROMPT } from "./skills-lead";
export { CONTEXT_MANAGEMENT_RULES, RESUME_DIRECTIVE } from "./shared-rules";
