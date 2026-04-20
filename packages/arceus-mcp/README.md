# @arceus/mcp

Arceus MCP server exposing the 24 system operations as agent-invocable tools. Transport-agnostic `server.ts` with a stdio entrypoint today and a stubbed HTTP entrypoint for v2.

## Status

**Phase 3 complete** per [plans/24-ops-harness-plan.md](../../plans/24-ops-harness-plan.md). All 19 tools proxy through `ArceusHttpClient` to `/api/internal/v1/*` with `ToolResult` envelopes. Stdio transport is wired; Streamable HTTP transport is stubbed for v2.

## SDK version

Pinned to **`@modelcontextprotocol/sdk@1.19.1`**. API shape expected:

- `new McpServer({ name, version })` from `@modelcontextprotocol/sdk/server/mcp.js`
- `server.registerTool(id, { description, inputSchema }, handler)` — inputSchema is a Zod **raw shape** (`{ field: z.T }`), not `z.object(...)`
- `new StdioServerTransport()` from `@modelcontextprotocol/sdk/server/stdio.js`
- `await server.connect(transport)`

**Never bump without a Context7 lookup** — the SDK has churned across minor versions.

## Required env

- `BEAT_ID`, `COMPANY_ID`, `ROLE` — identity
- `ARCEUS_API` — base URL of the Arceus API
- `ARCEUS_TOKEN` — bearer token for `/api/internal/v1/*`

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint:descriptions` — fails if any tool description exceeds 160 chars

## Tool catalog

19 tools registered across 7 domains (task, artifact, workspace, meeting, approval, sprint, meta). Full schemas in `src/tools/*.ts`.

Memory tools deferred pending role-memory/hippocampus consolidation (see plans/24-ops-harness-plan.md Phase 7).
