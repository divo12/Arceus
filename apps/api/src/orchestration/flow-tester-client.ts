/**
 * Thin HTTP client for services/flow-tester.
 *
 * Used by the tester MCP tool (workspace_run_flow_test) during the sprint.
 * Dormant unless FLOW_TESTER_URL is set.
 */

const DEFAULT_TIMEOUT_MS = 240_000;

function flowTesterUrl(): string {
  return (process.env.FLOW_TESTER_URL ?? "").replace(/\/+$/, "");
}

function flowTesterToken(): string {
  return process.env.FLOW_TESTER_TOKEN ?? "";
}

/** True when the flow-tester service is configured (env present). */
export function flowTesterConfigured(): boolean {
  return flowTesterUrl().length > 0;
}

export interface FlowTestReport {
  ok?: boolean;
  is_successful?: boolean | null;
  verdict?: string;
  action_trace?: unknown[];
  final_url?: string;
  title?: string;
  screenshot_b64?: string;
}

export function verdictFailed(report: FlowTestReport): boolean {
  const v = (report.verdict ?? "").trim();
  if (report.is_successful === false) return true;
  if (/VERDICT:\s*FAIL/i.test(v)) return true;
  if (/DESIGN:\s*basic/i.test(v)) return true;
  if (/ISSUES:/i.test(v) && !/ISSUES:\s*(none|n\/a)/i.test(v)) return true;
  return false;
}

export interface CallFlowTesterArgs {
  url: string;
  goal?: string;
  maxSteps?: number;
  timeoutMs?: number;
}

/**
 * Drive the live product in a real browser via the flow-tester service.
 * Throws on transport / HTTP errors; returns the parsed report on 2xx.
 */
export async function callFlowTester(args: CallFlowTesterArgs): Promise<FlowTestReport> {
  const base = flowTesterUrl();
  if (!base) {
    throw new Error("FLOW_TESTER_URL is not configured");
  }

  const token = flowTesterToken();
  const res = await fetch(`${base}/flow-test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      url: args.url,
      goal: args.goal,
      max_steps: args.maxSteps ?? 8,
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`flow-tester HTTP ${res.status}`);
  }

  return (await res.json()) as FlowTestReport;
}
