#!/usr/bin/env python3
"""
Try using-web-scraping skill: DuckDuckGo search + scrape.
Per skills/open_skills/using-web-scraping/SKILL.md

Uses httpx + DuckDuckGo HTML (no Playwright) for portability.
For JS-rendered sites, use Playwright: pip install playwright && playwright install
"""
import asyncio
import json
import re

import httpx

USER_AGENT = "open-skills-bot/1.0 (https://github.com/besoeasy/open-skills)"


async def ddg_search_links(query: str, max_links: int = 5) -> list[str]:
    """Search DuckDuckGo HTML (lite) and return result URLs."""
    from urllib.parse import unquote

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    # DDG wraps links: href="//duckduckgo.com/l/?uddg=ENCODED_URL&rut=..."
    raw = re.findall(r'uddg=([^&"\s]+)', r.text)
    decoded = []
    for u in raw:
        real_url = unquote(u)
        if real_url.startswith("http") and "duckduckgo" not in real_url:
            decoded.append(real_url)
    return decoded[:max_links]


async def scrape_page(url: str) -> dict:
    """Fetch page and extract title, description, main text (per skill)."""
    from readability import Document

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        r = await client.get(url, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
    html = r.text
    doc = Document(html)
    title = doc.title()
    desc = None
    if desc_meta := re.search(r'<meta\s+name="description"\s+content="([^"]*)"', html, re.I):
        desc = desc_meta.group(1)
    text = doc.summary()
    # Strip HTML tags for plain text
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()[:2000]
    return {"url": url, "title": title, "description": desc, "text": text}


async def ddg_search_and_scrape(query: str, max_results: int = 3) -> list[dict]:
    """Search DuckDuckGo, visit top results, extract title/description/text (per skill)."""
    links = await ddg_search_links(query, max_links=max_results)
    if not links:
        return [{"error": "No search results", "query": query}]
    results = []
    for url in links:
        try:
            await asyncio.sleep(1)  # Rate limit per skill
            results.append(await scrape_page(url))
        except Exception as e:
            results.append({"url": url, "error": str(e)})
    return results


def main():
    query = "AI product management tools 2025"
    print(f"Searching DuckDuckGo for: {query}")
    results = asyncio.run(ddg_search_and_scrape(query, max_results=2))
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
