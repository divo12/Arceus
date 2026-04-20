import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES, ROLE_CONFIGS, getAllowedArceusTools, type Role } from "../agent/config.ts";
import { writeBeatAgent, renderBeatAgent } from "../agent/write-beat-agent.ts";

const failures: string[] = [];
const record = (ok: boolean, label: string, detail?: string) => {
  const prefix = ok ? "PASS" : "FAIL";
  process.stdout.write(`${prefix}: ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures.push(label);
};

const TOKEN_BUDGET_PER_ROLE = 2500;
const AVG_DESCRIPTION_CHARS = 120;

const EXPECTED_ALLOWED: Record<Role, string[]> = {
  ceo: ["task_create", "task_hydrate_from_spec", "meeting_record", "sprint_propose"],
  cto: ["task_update_progress", "task_append_result", "task_complete"],
  pm: ["task_create", "task_update", "artifact_persist", "meeting_record", "approval_request"],
  developer: [
    "task_update_progress",
    "task_append_command",
    "task_set_preview_url",
    "workspace_checkpoint",
    "workspace_probe_preview",
  ],
  tester: ["task_verify", "task_append_result"],
  ui_designer: ["artifact_write_to_workspace", "task_set_preview_url"],
  marketing: ["artifact_write_to_workspace", "approval_request"],
  skills_lead: ["workspace_checkpoint", "artifact_persist", "meeting_record"],
};

const DENIED_FOR_NON_PRIVILEGED: Record<Role, string[]> = {
  ceo: ["task_update", "task_verify", "workspace_checkpoint"],
  cto: ["sprint_propose", "task_create", "approval_request"],
  pm: ["sprint_propose", "task_verify", "workspace_probe_preview"],
  developer: ["sprint_propose", "task_create", "approval_request", "meeting_record"],
  tester: ["sprint_propose", "task_create", "approval_request"],
  ui_designer: ["sprint_propose", "task_create", "workspace_probe_preview"],
  marketing: ["sprint_propose", "task_create", "task_verify"],
  skills_lead: ["sprint_propose", "task_create", "task_hydrate_from_spec"],
};

const main = async () => {
  const tmp = mkdtempSync(join(tmpdir(), "arceus-agent-"));
  try {
    record(ROLES.length === 8, "eight roles defined", `roles=${ROLES.join(",")}`);

    for (const role of ROLES) {
      const result = await writeBeatAgent(role, tmp);
      const content = readFileSync(result.path, "utf8");

      record(content.startsWith("---\n"), `${role}: frontmatter present`);
      record(content.includes(`mode: ${ROLE_CONFIGS[role].mode}`), `${role}: mode set`);
      record(content.includes("tools:"), `${role}: tools block present`);

      const allowed = getAllowedArceusTools(role);
      for (const tool of EXPECTED_ALLOWED[role]) {
        record(allowed.includes(tool), `${role}: allows ${tool}`);
      }
      for (const tool of DENIED_FOR_NON_PRIVILEGED[role]) {
        record(!allowed.includes(tool), `${role}: denies ${tool}`);
      }

      const descriptionOverhead = allowed.length * AVG_DESCRIPTION_CHARS;
      const totalChars = result.bytes + descriptionOverhead;
      const budgetTokens = Math.ceil(totalChars / 4);
      record(
        budgetTokens < TOKEN_BUDGET_PER_ROLE,
        `${role}: eager catalog < ${TOKEN_BUDGET_PER_ROLE} tokens`,
        `~${budgetTokens} tokens (${allowed.length} arceus tools)`,
      );
    }

    const ceoRender = renderBeatAgent("ceo");
    record(ceoRender.includes("sprint_propose: true"), "ceo render includes sprint_propose");
    const devRender = renderBeatAgent("developer");
    record(devRender.includes("sprint_propose: false"), "developer render explicitly denies sprint_propose");
    record(devRender.includes("workspace_probe_preview: true"), "developer render enables preview probe");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`\n${failures.length === 0 ? "ALL GREEN" : `${failures.length} FAILURE(S)`}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((err) => {
  process.stderr.write(`agent-gen crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
