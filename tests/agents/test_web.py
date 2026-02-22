"""Tests for web tools: WebSearchTool and WebFetchTool."""

import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from agents.tools.web import (
    WebFetchTool,
    WebSearchTool,
    _extract_main_content,
    _normalize,
    _strip_tags,
    _validate_url,
)
from bs4 import BeautifulSoup


class TestValidateUrl(unittest.TestCase):
    """Tests for _validate_url."""

    def test_valid_http(self):
        ok, msg = _validate_url("http://example.com/path")
        self.assertTrue(ok)
        self.assertEqual(msg, "")

    def test_valid_https(self):
        ok, msg = _validate_url("https://example.com")
        self.assertTrue(ok)
        self.assertEqual(msg, "")

    def test_invalid_ftp(self):
        ok, msg = _validate_url("ftp://example.com")
        self.assertFalse(ok)
        self.assertIn("http/https", msg)

    def test_missing_domain(self):
        ok, msg = _validate_url("http://")
        self.assertFalse(ok)
        self.assertIn("domain", msg)


class TestStripTags(unittest.TestCase):
    """Tests for _strip_tags."""

    def test_removes_script(self):
        html = "<p>Hello</p><script>alert(1)</script><p>World</p>"
        self.assertEqual(_strip_tags(html), "HelloWorld")

    def test_removes_html_tags(self):
        html = "<div><b>Bold</b> and <i>italic</i></div>"
        self.assertEqual(_strip_tags(html), "Bold and italic")

    def test_unescapes_entities(self):
        html = "&amp; &lt; &gt;"
        self.assertEqual(_strip_tags(html), "& < >")


class TestNormalize(unittest.TestCase):
    """Tests for _normalize."""

    def test_collapses_spaces(self):
        self.assertEqual(_normalize("a   b   c"), "a b c")

    def test_collapses_newlines(self):
        self.assertEqual(_normalize("a\n\n\n\nb"), "a\n\nb")


class TestExtractMainContent(unittest.TestCase):
    """Tests for _extract_main_content."""

    def test_extracts_article(self):
        html = """
        <html><body>
        <nav>Menu</nav>
        <article><p>Main content here with enough text to pass the 100 char threshold.</p></article>
        <footer>Footer</footer>
        </body></html>
        """
        soup = BeautifulSoup(html, "html.parser")
        result = _extract_main_content(soup)
        self.assertIsNotNone(result)
        self.assertIn("Main content here", result)

    def test_extracts_main_tag(self):
        html = """
        <html><body>
        <main><p>Main section content with sufficient length for the extraction.</p></main>
        </body></html>
        """
        soup = BeautifulSoup(html, "html.parser")
        result = _extract_main_content(soup)
        self.assertIsNotNone(result)
        self.assertIn("Main section content", result)


class TestWebSearchTool(unittest.TestCase):
    """Tests for WebSearchTool."""

    def test_execute_no_credentials_returns_error(self):
        """Without GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID, returns error."""
        with patch.dict(os.environ, {"GOOGLE_API_KEY": "", "GOOGLE_SEARCH_ENGINE_ID": ""}, clear=False):
            tool = WebSearchTool(google_api_key="", google_search_engine_id="")
            result = asyncio.run(tool.execute(query="test"))
        self.assertIn("GOOGLE_API_KEY", result)
        self.assertIn("GOOGLE_SEARCH_ENGINE_ID", result)

    def test_execute_with_mocked_google_api(self):
        """With mocked Google API response, returns formatted results."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "items": [
                {"title": "Result 1", "link": "https://example.com/1", "snippet": "Snippet 1"},
                {"title": "Result 2", "link": "https://example.com/2", "snippet": "Snippet 2"},
            ]
        }

        async def mock_get(*args, **kwargs):
            return mock_response

        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("agents.tools.web.httpx.AsyncClient", return_value=mock_client):
            tool = WebSearchTool(
                google_api_key="fake-key",
                google_search_engine_id="fake-cx",
            )
            result = asyncio.run(tool.execute(query="test query", count=5))

        self.assertIn("Results for: test query", result)
        self.assertIn("Result 1", result)
        self.assertIn("https://example.com/1", result)
        self.assertIn("Snippet 1", result)
        self.assertIn("Result 2", result)

    def test_execute_empty_results(self):
        """When Google returns no items, returns no-results message."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"items": []}

        async def mock_get(*args, **kwargs):
            return mock_response

        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("agents.tools.web.httpx.AsyncClient", return_value=mock_client):
            tool = WebSearchTool(
                google_api_key="fake-key",
                google_search_engine_id="fake-cx",
            )
            result = asyncio.run(tool.execute(query="nonexistent"))

        self.assertIn("No results for: nonexistent", result)


class TestWebFetchTool(unittest.TestCase):
    """Tests for WebFetchTool."""

    def test_execute_invalid_url_returns_error(self):
        """Invalid URL (e.g. ftp) returns validation error."""
        tool = WebFetchTool()
        result = asyncio.run(tool.execute(url="ftp://invalid.com"))
        data = json.loads(result)
        self.assertIn("error", data)
        self.assertIn("URL validation failed", data["error"])

    def test_execute_with_mocked_http(self):
        """With mocked HTTP response, returns extracted content."""
        long_content = "Main article content. " * 20  # > 50 chars for extraction
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.url = "https://example.com"
        mock_response.headers = {"content-type": "text/html"}
        mock_response.text = f"""
        <html><body>
        <nav>Menu</nav>
        <article><p>{long_content}</p></article>
        </body></html>
        """
        mock_response.raise_for_status = MagicMock()

        async def mock_get(*args, **kwargs):
            return mock_response

        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("agents.tools.web.httpx.AsyncClient", return_value=mock_client):
            tool = WebFetchTool()
            result = asyncio.run(tool.execute(url="https://example.com"))

        data = json.loads(result)
        self.assertIn("status", data)
        self.assertEqual(data["status"], 200)
        self.assertEqual(data["extractor"], "beautifulsoup")
        self.assertIn("Main article content", data["text"])

    def test_execute_json_content(self):
        """JSON content type returns JSON in text."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.url = "https://api.example.com/data"
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"key": "value"}

        async def mock_get(*args, **kwargs):
            return mock_response

        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=mock_get)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("agents.tools.web.httpx.AsyncClient", return_value=mock_client):
            tool = WebFetchTool()
            result = asyncio.run(tool.execute(url="https://api.example.com/data"))

        data = json.loads(result)
        self.assertIn('"key": "value"', data["text"])

    @unittest.skipUnless(
        os.environ.get("RUN_NETWORK_TESTS"),
        "Set RUN_NETWORK_TESTS=1 to run live URL fetch test",
    )
    def test_execute_fetch_recepto_ai(self):
        """Integration test: fetch https://recepto.ai and verify content extraction."""
        tool = WebFetchTool()
        result = asyncio.run(tool.execute(url="https://recepto.ai", maxChars=5000))
        data = json.loads(result)
        self.assertNotIn("error", data, msg=f"Fetch failed: {result}")
        self.assertEqual(data["status"], 200)
        self.assertIn("text", data)
        self.assertGreater(len(data["text"]), 500, "Expected substantial extracted content")
