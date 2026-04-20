// STUB — Streamable HTTP transport for v2 (plans/24-ops-harness-plan.md §11).
// Kept intentionally empty in v1 so the server.ts logic stays transport-agnostic
// and promoting to HTTP later is an entrypoint swap, not a rewrite.

export const NOT_IMPLEMENTED = "transport-http is a v2 stub" as const;
