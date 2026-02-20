# nanobot Skills

This directory contains built-in skills that extend nanobot's capabilities.

## Skill Format

Each skill is a directory containing a `SKILL.md` file with:
- YAML frontmatter (name, description, metadata)
- Markdown instructions for the agent

## Attribution

- Core skills adapted from [OpenClaw](https://github.com/openclaw/openclaw)'s skill system.
- 33 skills from [besoeasy/open-skills](https://github.com/besoeasy/open-skills) (pdf-manipulation, web-search-api, etc.).

## Available Skills

### Core (Arceus/OpenClaw)

| Skill | Description |
|-------|-------------|
| `github` | Interact with GitHub using the `gh` CLI |
| `weather` | Get weather info using wttr.in and Open-Meteo |
| `summarize` | Summarize URLs, files, and YouTube videos |
| `tmux` | Remote-control tmux sessions |
| `clawhub` | Search and install skills from ClawHub registry |
| `skill-creator` | Create new skills |
| `heartbeat` | HEARTBEAT.md for periodic autonomous tasks |
| `cron` | Schedule reminders and recurring tasks |
| `memory` | Episodic memory and run traces |
| `web-search` | web_search/web_fetch for domain context |

### From open-skills (besoeasy/open-skills)

| Skill | Description |
|-------|-------------|
| `pdf-manipulation` | Merge, split, extract, redact, convert PDFs |
| `web-search-api` | Free SearXNG web search APIs |
| `send-email-programmatically` | Send email via SMTP/APIs |
| `free-weather-data` | Free weather APIs |
| `free-geocoding-and-maps` | Geocoding and maps |
| `free-translation-api` | Free translation APIs |
| `database-query-and-export` | Query and export databases |
| `json-and-csv-data-transformation` | JSON/CSV transforms |
| `using-web-scraping` | Web scraping patterns |
| `using-telegram-bot` | Telegram bot integration |
| `using-youtube-download` | YouTube download workflows |
| `using-nostr` | Nostr protocol |
| `get-crypto-price` | Crypto price fetching |
| `check-crypto-address-balance` | Crypto address balance |
| `generate-asset-price-chart` | Asset price charts |
| `trading-indicators-from-price-data` | Trading indicators |
| `anonymous-file-upload` | Anonymous file upload |
| `static-assets-hosting` | Static asset hosting |
| `browser-automation-agent` | Browser automation |
| `phone-specs-scraper` | Phone specs scraping |
| `generate-qr-code-natively` | QR code generation |
| `bulk-github-star` | Bulk GitHub starring |
| `file-tracker` | File tracking |
| `news-aggregation` | News aggregation |
| `city-distance` | City distance calculations |
| `city-tourism-website-builder` | Tourism website builder |
| `web-interface-guidelines-review` | Web UI guidelines review |
| `nostr-logging-system` | Nostr logging |
| `chat-logger` | Chat logging |
| `humanizer` | Text humanization |
| `ip-lookup` | IP lookup |
| `random-contributor` | Random contributor selection |
| `user-ask-for-report` | User report generation |