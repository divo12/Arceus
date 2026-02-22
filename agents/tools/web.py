"""Web tools: web_search and web_fetch."""

import asyncio
import html
import json
import os
import re
import time
from typing import Any, Optional
from urllib.parse import quote_plus, urlparse

import httpx

from agents.tools.base import Tool

# Shared constants
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
MAX_REDIRECTS = 5  # Limit redirects to prevent DoS attacks

# SearXNG instance cache (per web-search-api skill)
SEARX_CACHE_TTL_S = 30 * 60  # 30 min
_searx_working: list[str] = []
_searx_cache_at: float = 0


def _strip_tags(text: str) -> str:
    """Remove HTML tags and decode entities."""
    text = re.sub(r'<script[\s\S]*?</script>', '', text, flags=re.I)
    text = re.sub(r'<style[\s\S]*?</style>', '', text, flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    return html.unescape(text).strip()


def _normalize(text: str) -> str:
    """Normalize whitespace."""
    text = re.sub(r'[ \t]+', ' ', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def _validate_url(url: str) -> tuple[bool, str]:
    """Validate URL: must be http(s) with valid domain."""
    try:
        p = urlparse(url)
        if p.scheme not in ('http', 'https'):
            return False, f"Only http/https allowed, got '{p.scheme or 'none'}'"
        if not p.netloc:
            return False, "Missing domain"
        return True, ""
    except Exception as e:
        return False, str(e)


PROBE_QUERY = "besoeasy"
MAX_SEARX_RETRIES = 7


def _sanitize_query(q: str) -> str:
    """Sanitize search query for API compatibility."""
    if not q or not isinstance(q, str):
        return "search"
    # Strip control chars, limit length
    q = re.sub(r"[\x00-\x1f\x7f]", "", q.strip())[:512]
    return q or "search"


async def _fetch_searx_instances() -> list[str]:
    """Fetch A/A+ grade instances from searx.space (web-search-api skill)."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                "https://searx.space/data/instances.json",
                headers={"User-Agent": USER_AGENT},
            )
            r.raise_for_status()
        data = r.json()
        out = []
        for url, meta in data.get("instances", {}).items():
            if not url.startswith("https://"):
                continue
            grade = meta.get("http", {}).get("grade", "")
            if grade in ("A", "A+"):
                out.append(url.rstrip("/"))
        return out[:25]
    except Exception:
        # Fallback static list
        return [
            "https://baresearch.org",
            "https://copp.gg",
            "https://etsi.me",
            "https://find.xenorio.xyz",
            "https://kantan.cat",
            "https://o5.gg",
            "https://paulgo.io",
            "https://priv.au",
            "https://s.mble.dk",
            "https://search.2b9t.xyz",
        ]


async def _probe_searx_instance(instance: str) -> bool:
    """Probe instance (web-search-api skill pattern)."""
    params = {"q": PROBE_QUERY, "format": "json", "language": "en"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{instance}/search",
                params=params,
                headers={"Accept": "application/json", "User-Agent": USER_AGENT},
            )
            if r.status_code in (429, 403, 503):
                return False
            r.raise_for_status()
        data = r.json()
        return isinstance(data.get("results"), list)
    except Exception:
        return False


async def _refresh_searx_cache() -> list[str]:
    """Probe instances and cache working ones (parallel, max 5 concurrent)."""
    global _searx_working, _searx_cache_at
    instances = await _fetch_searx_instances()
    sem = asyncio.Semaphore(3)

    async def probe(inst: str) -> Optional[str]:
        async with sem:
            if await _probe_searx_instance(inst):
                return inst
        return None

    tasks = [probe(inst) for inst in instances[:15]]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    working = [r for r in results if isinstance(r, str) and r]
    _searx_working = working
    _searx_cache_at = time.monotonic()
    return working


async def _get_working_searx_instances() -> list[str]:
    """Get working instances (use cache or refresh)."""
    global _searx_working, _searx_cache_at
    now = time.monotonic()
    if _searx_working and (now - _searx_cache_at) < SEARX_CACHE_TTL_S:
        return _searx_working
    working = await _refresh_searx_cache()
    if working:
        return working
    # Fallback: use instances from searx.space without probe (probe may be rate-limited)
    fallback = await _fetch_searx_instances()
    return fallback[:10] if fallback else [
        "https://baresearch.org", "https://copp.gg", "https://etsi.me",
        "https://kantan.cat", "https://paulgo.io", "https://priv.au",
    ]


async def _searx_search(query: str, count: int = 5) -> str:
    """Search using SearXNG with probing, cache, and rotation (web-search-api skill)."""
    q = _sanitize_query(query)
    params = {"q": q, "format": "json", "language": "en", "safesearch": 0}
    instances = await _get_working_searx_instances()
    if not instances:
        return "Error: No working SearXNG instances found. Try again later or set BRAVE_API_KEY."

    for attempt in range(MAX_SEARX_RETRIES):
        instance = instances[attempt % len(instances)]
        if attempt > 0:
            await asyncio.sleep(1.5)
        if attempt in (1, MAX_SEARX_RETRIES // 2):
            instances = await _refresh_searx_cache()
            if not instances:
                break
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(
                    f"{instance}/search",
                    params=params,
                    headers={"Accept": "application/json", "User-Agent": USER_AGENT},
                )
                if r.status_code in (429, 403):
                    continue
                r.raise_for_status()
            data = r.json()
            results = data.get("results", [])[:count]
            if not results:
                continue
            lines = [f"Results for: {q} (via SearXNG)\n"]
            for j, item in enumerate(results, 1):
                lines.append(f"{j}. {item.get('title', '')}\n   {item.get('url', '')}")
                if content := item.get("content"):
                    lines.append(f"   {content}")
            return "\n".join(lines)
        except Exception:
            continue
    return "Error: All SearXNG instances failed after retries. Try again later or set BRAVE_API_KEY."


class WebSearchTool(Tool):
    """Search the web. Uses Brave API when configured; falls back to free SearXNG."""
    
    name = "web_search"
    description = "Search the web. Returns titles, URLs, and snippets."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "count": {"type": "integer", "description": "Results (1-10)", "minimum": 1, "maximum": 10}
        },
        "required": ["query"]
    }
    
    def __init__(self, api_key: Optional[str] = None, max_results: int = 5):
        self.api_key = api_key or os.environ.get("BRAVE_API_KEY", "")
        self.max_results = max_results
    
    async def execute(self, query: str, count: Optional[int] = None, **kwargs: Any) -> str:
        n = min(max(count or self.max_results, 1), 10)
        q = _sanitize_query(query)

        # Try Brave when API key is set
        if self.api_key:
            try:
                async with httpx.AsyncClient() as client:
                    r = await client.get(
                        "https://api.search.brave.com/res/v1/web/search",
                        params={"q": q},
                        headers={
                            "Accept": "application/json",
                            "Accept-Encoding": "gzip",
                            "X-Subscription-Token": self.api_key},
                        timeout=12.0,
                    )
                    r.raise_for_status()
                results = r.json().get("web", {}).get("results", [])[:n]
                if results:
                    lines = [f"Results for: {q}\n"]
                    for i, item in enumerate(results, 1):
                        lines.append(f"{i}. {item.get('title', '')}\n   {item.get('url', '')}")
                        if desc := item.get("description"):
                            lines.append(f"   {desc}")
                    return "\n".join(lines)
            except Exception:
                pass  # Fall through to SearXNG (422, network, etc.)

        # Fallback: SearXNG with probing/rotation (web-search-api skill)
        return await _searx_search(q, n)


class SearXSearchTool(Tool):
    """Search via free SearXNG API (web-search-api skill). Use when web_search fails or for privacy."""
    
    name = "searx_search"
    description = "Search the web via free SearXNG (no API key). Use when web_search fails with 422/rate limit."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "count": {"type": "integer", "description": "Results (1-10)", "minimum": 1, "maximum": 10}
        },
        "required": ["query"]
    }
    
    def __init__(self, max_results: int = 5):
        self.max_results = max_results
    
    async def execute(self, query: str, count: Optional[int] = None, **kwargs: Any) -> str:
        n = min(max(count or self.max_results, 1), 10)
        return await _searx_search(query, n)


class WebFetchTool(Tool):
    """Fetch and extract content from a URL using Readability."""
    
    name = "web_fetch"
    description = "Fetch URL and extract readable content (HTML → markdown/text)."
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "URL to fetch"},
            "extractMode": {"type": "string", "enum": ["markdown", "text"], "default": "markdown"},
            "maxChars": {"type": "integer", "minimum": 100}
        },
        "required": ["url"]
    }
    
    def __init__(self, max_chars: int = 50000):
        self.max_chars = max_chars
    
    async def execute(
        self, url: str, extractMode: str = "markdown", maxChars: Optional[int] = None, **kwargs: Any
    ) -> str:
        from readability import Document

        max_chars = maxChars or self.max_chars

        # Validate URL before fetching
        is_valid, error_msg = _validate_url(url)
        if not is_valid:
            return json.dumps({"error": f"URL validation failed: {error_msg}", "url": url})

        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                max_redirects=MAX_REDIRECTS,
                timeout=30.0
            ) as client:
                r = await client.get(url, headers={"User-Agent": USER_AGENT})
                r.raise_for_status()
            
            ctype = r.headers.get("content-type", "")
            
            # JSON
            if "application/json" in ctype:
                text, extractor = json.dumps(r.json(), indent=2), "json"
            # HTML
            elif "text/html" in ctype or r.text[:256].lower().startswith(("<!doctype", "<html")):
                doc = Document(r.text)
                content = self._to_markdown(doc.summary()) if extractMode == "markdown" else _strip_tags(doc.summary())
                text = f"# {doc.title()}\n\n{content}" if doc.title() else content
                extractor = "readability"
            else:
                text, extractor = r.text, "raw"
            
            truncated = len(text) > max_chars
            if truncated:
                text = text[:max_chars]
            
            return json.dumps({"url": url, "finalUrl": str(r.url), "status": r.status_code,
                              "extractor": extractor, "truncated": truncated, "length": len(text), "text": text})
        except Exception as e:
            return json.dumps({"error": str(e), "url": url})
    
    def _to_markdown(self, html: str) -> str:
        """Convert HTML to markdown."""
        # Convert links, headings, lists before stripping tags
        text = re.sub(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',
                      lambda m: f'[{_strip_tags(m[2])}]({m[1]})', html, flags=re.I)
        text = re.sub(r'<h([1-6])[^>]*>([\s\S]*?)</h\1>',
                      lambda m: f'\n{"#" * int(m[1])} {_strip_tags(m[2])}\n', text, flags=re.I)
        text = re.sub(r'<li[^>]*>([\s\S]*?)</li>', lambda m: f'\n- {_strip_tags(m[1])}', text, flags=re.I)
        text = re.sub(r'</(p|div|section|article)>', '\n\n', text, flags=re.I)
        text = re.sub(r'<(br|hr)\s*/?>', '\n', text, flags=re.I)
        return _normalize(_strip_tags(text))
