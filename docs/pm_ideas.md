# PM Ideas Cron Service

Surfs the web for product ideas and creates a todo list in `PM_IDEAS.md`.

## Architecture

- **Main agent:** Open skills (web_search, web_fetch, spawn, etc.) for searching and validation.
- **Spawn subagent:** Use `spawn` to delegate focused validation (JTBD, PoL) or research. Subagent returns result directly; feedback is fed into the next iteration.
- **Support agent:** Workspace PM skills context. The main agent calls `query_support_agent` when it needs "where to learn more" or "what's missing in workspace skills."
- **Output:** `PM_IDEAS.md` with gaps, tools to implement, learning ideas, and actionable todos.

## What it does

- **Project context:** Given a Problem, the agent uses PM knowledge and skills to solve it and tell what to build next.
- **Ideas sweep:** Main agent searches for product ideas, PM trends, what-to-build-next. Support agent answers queries about workspace skills and gaps.
- **Output:** Creates `PM_IDEAS.md` with: gaps in workspace_skills, tools to add, learning sources, and actionable items (markdown checkboxes).

## Run once

```bash
uv run python scripts/run_gateway.py ideas
```

## Schedule via cron

```bash
# Daily at 9am
uv run python scripts/run_gateway.py add --ideas --cron "0 9 * * *"

# Every 24 hours
uv run python scripts/run_gateway.py add --ideas --every 86400
```

## Run gateway

```bash
uv run python scripts/run_gateway.py run
```

The ideas job runs when due; output is written to `PM_IDEAS.md`.

## Optional: Create PR on update

Set `PM_IDEAS_CREATE_PR=1` in `.env` to commit, push, and create a PR when `PM_IDEAS.md` is updated. Requires `gh` CLI and git.

## Web search

- **Web Search MCP** (recommended): When configured in `.arceus/config.json`, provides `mcp_web_search_full-web-search`, `mcp_web_search_get-web-search-summaries`, `mcp_web_search_get-single-web-page-content`. See [docs/web_search_mcp.md](web_search_mcp.md).
- **web_search**: Uses Brave Search API when `BRAVE_API_KEY` is set; falls back to SearXNG when Brave fails (422, etc.).
- **searx_search**: Free SearXNG (web-search-api skill). Fetches instances from searx.space, probes for working ones, caches 30 min, rotates on failure.
- If both fail (e.g. rate limits on public SearXNG): set `BRAVE_API_KEY` for reliable search, or run your own SearXNG instance.
