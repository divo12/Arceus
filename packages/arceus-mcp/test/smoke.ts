import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "src", "transport-stdio.ts");

const failures: string[] = [];
const record = (ok: boolean, label: string, detail?: string) => {
  const prefix = ok ? "PASS" : "FAIL";
  process.stdout.write(`${prefix}: ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures.push(label);
};

const main = async (): Promise<void> => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", serverEntry],
    env: {
      ...process.env,
      BEAT_ID: "b_test",
      COMPANY_ID: "c_test",
      ROLE: "developer",
      ARCEUS_API: "http://localhost:3001",
      ARCEUS_TOKEN: "dev"
    }
  });

  const client = new Client({ name: "smoke-test", version: "0.0.1" });
  await client.connect(transport);
  record(true, "server boot + client handshake");

  const { tools } = await client.listTools();
  record(tools.length === 19, "tools/list returns 19 tools", `got ${tools.length}`);

  const expectedIds = [
    "task_complete", "task_block", "task_verify", "task_append_result",
    "task_set_preview_url", "task_create", "task_update", "task_hydrate_from_spec",
    "task_attach_artifact",
    "artifact_create", "artifact_write_to_workspace", "artifact_persist",
    "workspace_checkpoint", "workspace_probe_preview",
    "meeting_record", "approval_request", "sprint_propose",
    "tool_help", "arceus_tool_search"
  ];
  const foundIds = new Set(tools.map((t) => t.name));
  const missing = expectedIds.filter((id) => !foundIds.has(id));
  record(missing.length === 0, "all expected tool ids present", missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined);

  const descriptionViolators = tools.filter((t) => (t.description ?? "").length > 160);
  record(descriptionViolators.length === 0, "all descriptions ≤ 160 chars",
    descriptionViolators.length > 0 ? descriptionViolators.map((t) => `${t.name}:${t.description?.length}`).join(", ") : undefined);

  const taskComplete = tools.find((t) => t.name === "task_complete");
  const hasTaskIdSchema = !!taskComplete?.inputSchema?.properties?.taskId;
  record(hasTaskIdSchema, "task_complete has taskId input schema");

  // Phase 3: tools make real HTTP calls — with no server running this returns a network error.
  // The key assertion is that the response is NOT a stub envelope.
  const result = await client.callTool({ name: "task_complete", arguments: { taskId: "t_smoke" } }).catch((e) => e as Error);
  const isError = result instanceof Error;
  const textContent = !isError && Array.isArray(result.content)
    ? result.content.find((c) => (c as { type?: string }).type === "text")
    : undefined;
  const parsed = textContent ? JSON.parse((textContent as { text: string }).text) : null;

  record(
    isError || parsed?.error?.cause !== "stub",
    "task_complete is no longer a stub (real HTTP call or network error)",
    isError ? (result as Error).message.slice(0, 80) : `cause: ${parsed?.error?.cause}`
  );
  if (parsed) {
    record(typeof parsed.summary === "string" && parsed.summary.length > 0, "envelope.summary non-empty");
  }

  let schemaValidationRejected = false;
  try {
    await client.callTool({ name: "task_complete", arguments: {} });
  } catch (err) {
    schemaValidationRejected = true;
    const message = err instanceof Error ? err.message : String(err);
    record(true, "schema validation rejects missing taskId", message.slice(0, 100));
  }
  if (!schemaValidationRejected) {
    record(false, "schema validation rejects missing taskId", "no error thrown");
  }

  await client.close();

  process.stdout.write(`\n${failures.length === 0 ? "ALL GREEN" : `${failures.length} FAILURE(S)`}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((err) => {
  process.stderr.write(`smoke test crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
