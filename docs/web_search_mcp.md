# Web Search MCP Integration

Arceus can use the [web-search-mcp](https://github.com/mrkrsl/web-search-mcp) server to give the main agent rich web search and page extraction capabilities.

## Tools Provided

When configured, the agent gets these MCP tools (prefixed with `mcp_web_search_`):

- **full-web-search** – Full search with extracted page content
- **get-web-search-summaries** – Quick search snippets
- **get-single-web-page-content** – Extract content from a single URL

The PM Ideas sweep and heartbeat agent will prefer these when available.

## Setup

### 1. Install web-search-mcp (local build)

The package is not on npm. Clone and build locally:

```bash
mkdir -p ~/mcp-servers && cd ~/mcp-servers
git clone https://github.com/mrkrsl/web-search-mcp.git
cd web-search-mcp
npm install
npx playwright install chromium
npm run build
```

### 2. Configure Arceus

Copy `config.example.json` to `.arceus/config.json` (or merge the `tools.mcpServers` section into your existing config):

```json
{
  "tools": {
    "mcpServers": {
      "web_search": {
        "command": "node",
        "args": ["$HOME/mcp-servers/web-search-mcp/dist/index.js"],
        "env": {
          "MAX_CONTENT_LENGTH": "10000",
          "BROWSER_HEADLESS": "true",
          "MAX_BROWSERS": "3",
          "BROWSER_TYPES": "chromium"
        }
      }
    }
  }
}
```

Or set `WEB_SEARCH_MCP_PATH` in `.env` to override the path:

```
WEB_SEARCH_MCP_PATH=/path/to/web-search-mcp/dist/index.js
```

### 3. Test

```bash
uv run python examples/test_web_search_mcp.py "AI PM tools 2025"
uv run python examples/test_web_search_mcp.py --ideas   # Full PM ideas sweep
```

## Cron / Ideas Sweep

When Web Search MCP is configured, the PM Ideas sweep (`uv run python scripts/run_gateway.py ideas`) and cron jobs use it automatically. Add to cron:

```bash
uv run python scripts/run_gateway.py add --ideas --cron "0 9 * * *"
uv run python scripts/run_gateway.py run --no-heartbeat
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Connection closed | Ensure `dist/index.js` exists and path is correct. Run `npm run build` in web-search-mcp. |
| Playwright errors | Run `npx playwright install chromium` in the web-search-mcp directory. |
| npm cache permissions | Use local build (above) or `sudo chown -R $(whoami) ~/.npm` if using npx. |
