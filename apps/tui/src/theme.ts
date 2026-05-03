/** Role → display color mapping. */
const ROLE_COLORS: Record<string, string> = {
  ceo: "yellow",
  cto: "cyan",
  pm: "magenta",
  developer: "green",
  tester: "red",
  ui_designer: "blue",
  marketing: "white",
  skills_lead: "gray",
};

const ROLE_SHORT: Record<string, string> = {
  ceo: "CEO",
  cto: "CTO",
  pm: " PM",
  developer: "DEV",
  tester: "TST",
  ui_designer: "DSN",
  marketing: "MKT",
  skills_lead: "SKL",
};

export function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? "white";
}

export function roleShort(role: string): string {
  return ROLE_SHORT[role] ?? role.slice(0, 3).toUpperCase();
}

// Outcome → color
export function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "WORK_DONE":
      return "green";
    case "HEARTBEAT_OK":
      return "cyan";
    case "ERROR":
    case "TIMED_OUT":
      return "red";
    case "BUDGET_EXCEEDED":
      return "yellow";
    case "SKIPPED":
      return "gray";
    default:
      return "white";
  }
}

// Task status → color
export function taskStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
    case "in-progress":
      return "yellow";
    case "failed":
    case "blocked":
      return "red";
    case "todo":
    case "pending":
      return "white";
    default:
      return "gray";
  }
}

// Meeting status → color
export function meetingStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "yellow";
    case "scheduled":
      return "cyan";
    case "cancelled":
      return "red";
    default:
      return "gray";
  }
}

// Trust score → color
export function trustColor(score: number): string {
  if (score >= 0.8) return "green";
  if (score >= 0.5) return "yellow";
  return "red";
}
