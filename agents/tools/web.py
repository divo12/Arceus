"""Web tools: web_search and web_fetch."""

import asyncio
import html
import json
import logging
import os
import random
import re
from typing import Any

import httpx
from bs4 import BeautifulSoup
from urllib.parse import urlparse

from agents.tools.base import Tool

# Shared constants
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36"
MAX_REDIRECTS = 5  # Limit redirects to prevent DoS attacks

# Google Custom Search retry
GOOGLE_SEARCH_MAX_ATTEMPTS = 4
GOOGLE_SEARCH_RETRY_DELAYS_SEC = (1.0, 1.0, 2.0)

# Realistic headers for fetch (avoid bot detection)
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
]

logger = logging.getLogger(__name__)


def _get_realistic_headers() -> dict:
    """Generate realistic browser headers to avoid bot detection."""
    return {
        "User-Agent": random.choice(_USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
        "DNT": "1",
    }


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


# --- Google Custom Search (async) ---


async def _google_search_async(
    query: str,
    api_keys: list[str],
    search_engine_id: str,
    count: int = 10,
) -> list[dict[str, Any]]:
    """
    Search Google Custom Search API (async).
    Uses random key per request. Retries on 429 with backoff.
    """
    if not api_keys or not search_engine_id:
        return []

    base_url = "https://www.googleapis.com/customsearch/v1"
    params_base = {"q": query, "cx": search_engine_id, "num": min(count, 10)}

    for attempt in range(GOOGLE_SEARCH_MAX_ATTEMPTS):
        api_key = random.choice(api_keys)
        params = {**params_base, "key": api_key}

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(base_url, params=params)
        except Exception as e:
            logger.warning("Google Search request failed: %s", e)
            if attempt < GOOGLE_SEARCH_MAX_ATTEMPTS - 1:
                await asyncio.sleep(GOOGLE_SEARCH_RETRY_DELAYS_SEC[attempt])
            continue

        if r.status_code == 200:
            data = r.json()
            items = data.get("items", [])
            return [
                {"title": i.get("title", ""), "link": i.get("link", ""), "snippet": i.get("snippet", "")}
                for i in items
                if i.get("link")
            ]

        if r.status_code == 429:
            logger.warning(
                "Google Search 429 (rate limit) attempt %d/%d - backing off",
                attempt + 1,
                GOOGLE_SEARCH_MAX_ATTEMPTS,
            )
            if attempt < GOOGLE_SEARCH_MAX_ATTEMPTS - 1:
                await asyncio.sleep(GOOGLE_SEARCH_RETRY_DELAYS_SEC[attempt])
            continue

        logger.warning("Google Search failed: %s %s", r.status_code, r.text[:200])
        return []

    return []


# --- BeautifulSoup content extraction (from user's scrape_url) ---


def _contains_keyword(value: Any, keywords: list[str]) -> bool:
    """Check if class/id contains any keyword."""
    if not value:
        return False
    if isinstance(value, list):
        value_str = " ".join(str(v) for v in value).lower()
    else:
        value_str = str(value).lower()
    return any(kw in value_str for kw in keywords)


def _extract_main_content(soup: BeautifulSoup) -> str | None:
    """
    Extract main content from HTML using multiple strategies.
    Prioritizes article/main, then content class/id patterns, then heuristic.
    """
    content_keywords = [
        "article", "content", "post", "entry", "main-content",
        "body-content", "page-content", "section-content",
    ]
    candidates: list[tuple[int, str, str]] = []

    # Strategy 1: Semantic HTML5
    for tag in ["article", "main"]:
        elem = soup.find(tag)
        if elem:
            text = elem.get_text(separator=" ", strip=True)
            if len(text) > 100:
                candidates.append((len(text), text, "semantic"))

    # Strategy 2: Class/id patterns
    for tag in ["div", "section"]:
        for elem in soup.find_all(tag):
            if elem.get("class") and _contains_keyword(elem.get("class"), content_keywords):
                text = elem.get_text(separator=" ", strip=True)
                if len(text) > 100:
                    candidates.append((len(text), text, "class"))
            if elem.get("id") and _contains_keyword(elem.get("id"), content_keywords):
                text = elem.get_text(separator=" ", strip=True)
                if len(text) > 100:
                    candidates.append((len(text), text, "id"))

    # Strategy 3: CSS selectors
    for selector in ['div[class*="content"]', 'div[class*="article"]', 'section[class*="content"]']:
        try:
            for elem in soup.select(selector):
                text = elem.get_text(separator=" ", strip=True)
                if len(text) > 100:
                    candidates.append((len(text), text, "css"))
        except Exception:
            pass

    # Strategy 4: Role attributes
    for role in ["main", "article"]:
        elem = soup.find(attrs={"role": role})
        if elem:
            text = elem.get_text(separator=" ", strip=True)
            if len(text) > 100:
                candidates.append((len(text), text, "role"))

    if candidates:
        candidates.sort(reverse=True, key=lambda x: x[0])
        return candidates[0][1]

    # Strategy 5: Remove noise and try body
    for tag in ["nav", "footer", "header", "aside", "iframe", "script", "style", "noscript", "svg"]:
        for elem in soup.find_all(tag):
            elem.decompose()

    unwanted = [
        '[class*="nav"]', '[class*="menu"]', '[class*="sidebar"]',
        '[class*="ad"]', '[class*="cookie"]', '[class*="banner"]',
    ]
    for sel in unwanted:
        try:
            for elem in soup.select(sel):
                elem.decompose()
        except Exception:
            pass

    body = soup.find("body")
    if body:
        text_blocks = []
        for div in body.find_all(["div", "section", "article"]):
            try:
                text = div.get_text(separator=" ", strip=True)
                nav_kw = ["cookie", "privacy policy", "terms of service"]
                if len(text) > 200 and not any(k in text.lower()[:100] for k in nav_kw):
                    text_blocks.append((len(text), text))
            except Exception:
                pass
        if text_blocks:
            text_blocks.sort(reverse=True, key=lambda x: x[0])
            return text_blocks[0][1]
        return body.get_text(separator=" ", strip=True)

    return soup.get_text(separator=" ", strip=True)


async def _scrape_url(
    url: str, timeout_sec: float = 45.0, retries: int = 2
) -> tuple[str, str]:
    """
    Scrape URL and extract main content using BeautifulSoup.
    Returns (text, final_url). Uses realistic headers and multiple extraction strategies.
    """
    last_error = ""
    for attempt in range(retries + 1):
        try:
            if attempt > 0:
                await asyncio.sleep(1 + attempt * 0.5)

            headers = _get_realistic_headers()
            async with httpx.AsyncClient(
                follow_redirects=True,
                max_redirects=MAX_REDIRECTS,
                timeout=timeout_sec,
            ) as client:
                r = await client.get(url, headers=headers)
                r.raise_for_status()

            final_url = str(r.url)
            ctype = r.headers.get("content-type", "").lower()
            if "text/html" not in ctype and "application/xhtml" not in ctype:
                if "application/json" in ctype:
                    return (json.dumps(r.json(), indent=2, ensure_ascii=False), final_url)
                return (r.text, final_url)

            soup = BeautifulSoup(r.text, "html.parser")
            text = _extract_main_content(soup)
            if not text:
                text = soup.get_text(separator=" ", strip=True)

            text = " ".join(text.split())
            if len(text) >= 50:
                return (text, final_url)

        except httpx.TimeoutException as e:
            last_error = f"Timeout: {e}"
            if attempt < retries:
                timeout_sec *= 1.5
        except httpx.HTTPStatusError as e:
            last_error = f"HTTP {e.response.status_code}"
            if e.response.status_code in (403, 429) and attempt < retries:
                await asyncio.sleep(2 + attempt)
            elif attempt >= retries:
                return ("", url)
        except Exception as e:
            last_error = str(e)
            if attempt < retries:
                continue

    logger.warning("Scrape failed for %s: %s", url, last_error)
    return ("", url)


# --- Tools ---


class WebSearchTool(Tool):
    """Search the web using Google Custom Search API."""

    name = "web_search"
    description = "Search the web. Returns titles, URLs, and snippets."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "count": {"type": "integer", "description": "Results (1-10)", "minimum": 1, "maximum": 10},
        },
        "required": ["query"],
    }

    def __init__(
        self,
        google_api_key: str | None = None,
        google_search_engine_id: str | None = None,
        max_results: int = 5,
    ):
        raw_google = google_api_key or os.environ.get("GOOGLE_API_KEY", "")
        self._google_keys = [k.strip() for k in raw_google.split(",") if k.strip()]
        self.google_search_engine_id = (
            google_search_engine_id or os.environ.get("GOOGLE_SEARCH_ENGINE_ID", "")
        )
        self.max_results = max_results

    async def execute(self, query: str, count: int | None = None, **kwargs: Any) -> str:
        n = min(max(count or self.max_results, 1), 10)

        if not self._google_keys or not self.google_search_engine_id:
            return "Error: GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID required."

        results = await _google_search_async(
            query, self._google_keys, self.google_search_engine_id, n
        )
        if not results:
            return f"No results for: {query}"

        lines = [f"Results for: {query}\n"]
        for i, item in enumerate(results[:n], 1):
            lines.append(f"{i}. {item.get('title', '')}\n   {item.get('link', '')}")
            if snip := item.get("snippet"):
                lines.append(f"   {snip}")
        return "\n".join(lines)


class WebFetchTool(Tool):
    """Fetch and extract content from a URL using BeautifulSoup."""

    name = "web_fetch"
    description = "Fetch URL and extract readable content (HTML → text)."
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "URL to fetch"},
            "extractMode": {"type": "string", "enum": ["markdown", "text"], "default": "markdown"},
            "maxChars": {"type": "integer", "minimum": 100},
        },
        "required": ["url"],
    }

    def __init__(self, max_chars: int = 50000):
        self.max_chars = max_chars

    async def execute(
        self, url: str, extractMode: str = "markdown", maxChars: int | None = None, **kwargs: Any
    ) -> str:
        max_chars = maxChars or self.max_chars

        is_valid, error_msg = _validate_url(url)
        if not is_valid:
            return json.dumps({"error": f"URL validation failed: {error_msg}", "url": url}, ensure_ascii=False)

        try:
            text, final_url = await _scrape_url(url, timeout_sec=30.0, retries=2)
            if not text:
                return json.dumps({"error": "No content extracted", "url": url}, ensure_ascii=False)

            if extractMode == "markdown":
                # Simple text-to-markdown: preserve paragraphs
                text = _normalize(text)
                lines = text.split("\n\n")
                text = "\n\n".join(lines)

            truncated = len(text) > max_chars
            if truncated:
                text = text[:max_chars]

            return json.dumps(
                {
                    "url": url,
                    "finalUrl": final_url,
                    "status": 200,
                    "extractor": "beautifulsoup",
                    "truncated": truncated,
                    "length": len(text),
                    "text": text,
                },
                ensure_ascii=False,
            )
        except Exception as e:
            return json.dumps({"error": str(e), "url": url}, ensure_ascii=False)
