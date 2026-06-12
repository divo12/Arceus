import diffTool, { diff as diffFn } from "../tool/workspace_diff_against_criteria.ts";
import collectTool from "../tool/workspace_collect_evidence.ts";
import { parseTscOutput } from "../tool/workspace_run_typecheck.ts";
import { ArceusPlugin } from "../plugin/arceus.ts";

const failures: string[] = [];
const record = (ok: boolean, label: string, detail?: string) => {
  const prefix = ok ? "PASS" : "FAIL";
  process.stdout.write(`${prefix}: ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures.push(label);
};

const mockEnv = () => {
  process.env.ARCEUS_API = "http://localhost:9999";
  process.env.ARCEUS_TOKEN = "t";
  process.env.BEAT_ID = "b1";
  process.env.COMPANY_ID = "c1";
  process.env.ROLE = "developer";
  process.env.TASK_ID = "tsk_smoke";
};

const clearBeatEnv = () => {
  delete process.env.BEAT_ID;
  delete process.env.COMPANY_ID;
  delete process.env.ROLE;
  delete process.env.TASK_ID;
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const installFetchStub = (status: number, body: unknown): FetchCall[] => {
  const calls: FetchCall[] = [];
  // @ts-expect-error override global fetch for smoke test
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
};

const ctx = {
  sessionID: "s1",
  messageID: "m1",
  agent: "tester",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

const main = async () => {
  mockEnv();

  // 1) Env-pinned context — headers come from env (test/local harness path)
  {
    const calls = installFetchStub(200, {
      status: "success",
      summary: "ok",
      data: { task: { id: "tsk_smoke", definitionOfDone: ["renders banner"] } },
    });
    const out = await diffTool.execute({ observed: "Page renders banner ok." }, ctx);
    const parsed = JSON.parse(out);
    record(parsed.status === "success", "diff falls back to fetched DoD", parsed.summary);
    record(calls[0]?.url.endsWith("/api/internal/v1/tasks/tsk_smoke"), "diff GETs task by env TASK_ID");
    record(calls[0]?.headers["x-beat-id"] === "b1", "beat header set from env");
    record(calls[0]?.headers["x-session-id"] === "s1", "session header set from tool context");
  }

  // 2) Long-lived-server context — NO per-beat env (the PROD path).
  //    Regression test for "BEAT_ID is required": tools must resolve
  //    identity from the tool context + taskId arg, not throw.
  {
    clearBeatEnv();
    const calls = installFetchStub(200, {
      status: "success",
      summary: "ok",
      data: { task: { id: "tsk_arg", definitionOfDone: ["renders banner"] } },
    });
    const out = await diffTool.execute({ observed: "Page renders banner ok.", taskId: "tsk_arg" }, ctx);
    const parsed = JSON.parse(out);
    record(parsed.status === "success", "diff works without per-beat env", parsed.summary ?? parsed.error?.details);
    record(calls[0]?.url.endsWith("/api/internal/v1/tasks/tsk_arg"), "diff GETs task by taskId arg");
    record(!("x-beat-id" in (calls[0]?.headers ?? {})), "no empty x-beat-id header");
    record(calls[0]?.headers["x-session-id"] === "s1", "session header present without env");
    record(calls[0]?.headers["x-role"] === "tester", "role falls back to tool context agent");
    mockEnv();
  }

  // 3) Validation failure when neither criteria nor any taskId is available
  {
    clearBeatEnv();
    installFetchStub(200, { status: "success" });
    const out = await diffTool.execute({ observed: "anything" }, ctx);
    const parsed = JSON.parse(out);
    record(
      parsed.status === "error" && parsed.error?.cause === "validation",
      "diff without criteria or taskId is a structured validation error",
      parsed.error?.cause,
    );
    mockEnv();
  }

  // 4) Envelope failure on HTTP 500
  {
    installFetchStub(500, { status: "error" });
    const out = await diffTool.execute({ observed: "x" }, ctx);
    const parsed = JSON.parse(out);
    record(parsed.status === "error" && parsed.error?.cause === "upstream", "diff maps 500 to upstream error", parsed.error?.cause);
  }

  // 5) collect_evidence requires a task id (env or arg)
  {
    clearBeatEnv();
    const out = await collectTool.execute({ bundleDir: "/nonexistent" }, ctx);
    const parsed = JSON.parse(out);
    record(
      parsed.status === "error" && parsed.error?.cause === "validation",
      "missing taskId surfaces structured error",
      parsed.error?.cause,
    );
    mockEnv();
  }

  // 6) Plugin governance — allowlist denies
  {
    process.env.ARCEUS_ALLOWED_TOOLS = "task_update_progress";
    const hooks = await ArceusPlugin({} as never);
    // The allowlist gates arceus_* tools only; builtins (bash, read…)
    // are governed by their own guards, not the allowlist.
    let threw = false;
    try {
      await hooks["tool.execute.before"]!(
        { tool: "arceus_task_create", sessionID: "s", callID: "c" },
        { args: {} },
      );
    } catch {
      threw = true;
    }
    record(threw, "governance blocks arceus tool not on allowlist");

    let ok = true;
    try {
      await hooks["tool.execute.before"]!(
        { tool: "arceus_task_update_progress", sessionID: "s", callID: "c" },
        { args: {} },
      );
    } catch {
      ok = false;
    }
    record(ok, "governance allows arceus tool on allowlist");
    delete process.env.ARCEUS_ALLOWED_TOOLS;
  }

  // 7) Phase H — workspace_run_typecheck parses tsc output deterministically
  {
    const sample = [
      "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/bar.ts(99,1): error TS2304: Cannot find name 'baz'.",
      "noise line",
    ].join("\n");
    const errors = parseTscOutput(sample);
    record(errors.length === 2, "tsc parser extracts 2 errors", String(errors.length));
    record(errors[0].code === "TS2322" && errors[0].file === "src/foo.ts", "tsc parser captures file + code");
  }

  // 8) Phase H — workspace_diff_against_criteria matches and reports gaps
  {
    const result = diffFn(
      ["renders welcome banner", "submits form to /api/save"],
      "Page renders welcome banner correctly. Console output is clean.",
    );
    record(result.matches.length === 1 && result.gaps.length === 1, "diff distinguishes matches vs gaps");
    record(result.unexpected.length === 0, "diff finds no unexpected error tokens");

    const failing = diffFn(["renders welcome banner"], "TypeError: undefined is not a function");
    record(failing.unexpected.length > 0, "diff flags unexpected error tokens", failing.unexpected.join(","));
  }

  // 9) Plugin circuit breaker — 3 strikes trips
  {
    const hooks = await ArceusPlugin({} as never);
    const errorOutput = JSON.stringify({ status: "error", error: { cause: "upstream" } });
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "flaky", sessionID: "s", callID: `c${i}`, args: {} },
        { title: "", output: errorOutput, metadata: {} },
      );
    }
    let tripped = false;
    try {
      await hooks["tool.execute.before"]!(
        { tool: "flaky", sessionID: "s", callID: "c4" },
        { args: {} },
      );
    } catch {
      tripped = true;
    }
    record(tripped, "circuit breaker trips after 3 strikes");
  }

  process.stdout.write(`\n${failures.length === 0 ? "ALL GREEN" : `${failures.length} FAILURE(S)`}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((err: unknown) => {
  process.stderr.write(`smoke crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
