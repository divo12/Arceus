# Web Tools

Built-in web tools: `web_search` and `web_fetch`.

## web_search

Searches the web using **Google Custom Search API**. Returns titles, URLs, and snippets.

**Required:** `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID` (config or env).

**Config** (`.arceus/config.json`):
```json
{
  "tools": {
    "web": {
      "googleApiKey": "google-key",
      "googleSearchEngineId": "cx-id",
      "maxResults": 5
    }
  }
}
```

**Google Custom Search:**
- Supports comma-separated API keys for rotation
- Retries on 429 (rate limit) with backoff: 1s, 1s, 2s
- See [Google Custom Search API](https://developers.google.com/custom-search/v1/overview)

## web_fetch

Fetches a URL and extracts main content using BeautifulSoup.

**Features:**
- Realistic browser headers to reduce bot detection
- Multiple extraction strategies: semantic HTML5 (`article`, `main`), content class/id patterns, CSS selectors, role attributes
- Removes nav, ads, cookies, sidebars
- Retries on timeout (403, 429)
- Returns JSON: `{ url, finalUrl, status, extractor, truncated, length, text }`

**Parameters:**
- `url` (required)
- `extractMode`: `"markdown"` or `"text"` (default: markdown)
- `maxChars`: max output length (default: 50000)
