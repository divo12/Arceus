"""
Manages Browser/Page per session_name and provides sync wrappers around
async browser_use library calls.

Uses a single long-lived event loop in a dedicated thread so all browser
operations run in the same loop. Multiple asyncio.run() calls would leave
the browser bound to a closed loop and cause hangs (see browser-use#3791).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any

DEFAULT_SESSION = "smart_scraping_default"

logger = logging.getLogger(__name__)

# Single event loop in a dedicated thread; all browser ops run here
_loop: asyncio.AbstractEventLoop | None = None
_loop_thread: threading.Thread | None = None
_loop_ready = threading.Event()
_loop_lock = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    """Start or return the shared event loop (runs in a background thread)."""
    global _loop, _loop_thread
    with _loop_lock:
        if _loop is not None and _loop.is_running():
            return _loop

        def _run_loop() -> None:
            global _loop
            _loop = asyncio.new_event_loop()
            asyncio.set_event_loop(_loop)
            _loop_ready.set()
            _loop.run_forever()

        _loop_ready.clear()
        _loop_thread = threading.Thread(target=_run_loop, daemon=True)
        _loop_thread.start()
    _loop_ready.wait(timeout=10.0)
    if _loop is None:
        raise RuntimeError("Browser event loop failed to start")
    return _loop


def _run_async(coro: Any) -> Any:
    """Run async coroutine in the shared browser event loop (sync bridge)."""
    loop = _get_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    # A full agent flow-test needs more than 120s. Configurable; default 600s.
    return future.result(timeout=float(os.getenv("BROWSER_OP_TIMEOUT_S", "600")))


def _progress(msg: str) -> None:
    """Emit progress message so we always see where we are (no logging config needed)."""
    print(f"  [smart_scraper] {msg}", flush=True)
    logger.info("%s", msg)


# Clickable/interactive selectors (matches typical browser-use state output)
CLICKABLE_SELECTOR = (
    "a[href], button, input:not([type='hidden']), select, textarea, "
    "[onclick], [role='button'], [role='link'], [role='tab'], "
    "[role='option'], [tabindex]:not([tabindex='-1'])"
)

# Text-bearing tags for extraction discovery (non-clickable content blocks)
CONTENT_SELECTOR = "div, span, p, h1, h2, h3, h4, h5, h6, time"
MAX_CONTENT_ELEMENTS = 30
MAX_CONTENT_TEXT_LEN = 150


@dataclass
class ElementInfo:
    """Cached element metadata for selector-first recipe."""

    index: int
    tag: str
    text: str
    attributes: dict[str, str]
    selector_candidates: list[str]


@dataclass
class StateSnapshot:
    """State after bu_state: URL, title, clickable elements, and content elements for extraction."""

    url: str = ""
    title: str = ""
    elements: list[ElementInfo] = field(default_factory=list)
    content_elements: list[ElementInfo] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "elements": [
                {
                    "index": e.index,
                    "tag": e.tag,
                    "text": e.text,
                    "attributes": e.attributes,
                    "selector_candidates": e.selector_candidates,
                }
                for e in self.elements
            ],
            "content_elements": [
                {
                    "index": e.index,
                    "tag": e.tag,
                    "text": e.text,
                    "attributes": e.attributes,
                    "selector_candidates": e.selector_candidates,
                }
                for e in self.content_elements
            ],
        }


@dataclass
class SessionData:
    """Per-session browser and state."""

    browser: Any
    page: Any | None = None
    target_id: str | None = (
        None  # Resolve fresh Page for get_state so CDP session is valid
    )
    last_state: StateSnapshot | None = None


_sessions: dict[str, SessionData] = {}


def _get_session(session_name: str) -> SessionData | None:
    return _sessions.get(session_name)


def _maybe_json(value: Any) -> Any:
    """Browser-Use evaluate may return JSON as a string for objects/lists/bools."""
    if not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return value
    if s in ("true", "false", "null"):
        try:
            return json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return value
    if s[0] in "{[":
        try:
            return json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return value
    return value


def _get_or_create_session(
    session_name: str,
    *,
    headed: bool = False,
    browser_mode: str = "chromium",
    profile: str | None = None,
) -> SessionData:
    """Get or create a session. Creates browser if needed."""
    if session_name in _sessions:
        _progress("bu_open: session already exists, reusing")
        return _sessions[session_name]

    async def _create() -> SessionData:
        from browser_use import Browser

        _progress("bu_open: creating session, browser.start()...")

        # Allow overriding the browser user agent via environment for easier testing.
        # If set, this will be used for all requests in this process.
        user_agent = os.getenv("SMART_SCRAPING_USER_AGENT") or os.getenv(
            "BROWSER_USER_AGENT"
        )

        browser_kwargs: dict[str, Any] = {"headless": not headed, "keep_alive": True}
        if user_agent:
            _progress("bu_open: using custom user_agent from environment")
            browser_kwargs["user_agent"] = user_agent

        browser = Browser(**browser_kwargs)
        await browser.start()
        _progress("bu_open: browser.start() done")
        data = SessionData(browser=browser)
        _sessions[session_name] = data
        return data

    return _run_async(_create())


async def _do_open(session_name: str, url: str, headed: bool) -> dict[str, Any]:
    data = _sessions[
        session_name
    ]  # Must exist; caller ensures via _get_or_create_session
    _progress(f"bu_open: new_page(url={url}) start")
    page = await data.browser.new_page(url)
    _progress(f"bu_open: new_page(url={url}) done")
    data.page = page
    # Wait for navigation to complete (new_page returns before load finishes)
    _progress("bu_open: waiting for navigation...")
    for _ in range(30):  # up to 15s
        await asyncio.sleep(0.5)
        try:
            url_res = await page.evaluate("() => window.location.href")
            if url_res and url_res not in ("about:blank", "about:blank/"):
                break
        except Exception:
            pass
    try:
        _progress("bu_open: evaluate location.href...")
        url_res = await page.evaluate("() => window.location.href")
        _progress("bu_open: evaluate location.href done")
    except Exception:
        url_res = url
    try:
        _progress("bu_open: evaluate document.title...")
        title_res = await page.evaluate("() => document.title")
        _progress("bu_open: evaluate document.title done")
    except Exception:
        title_res = ""
    _progress(f"bu_open: open_url complete url={url_res!r} title={title_res!r}")
    data.target_id = getattr(page, "_target_id", None)
    return {"url": url_res, "title": title_res}


def open_url(
    session_name: str,
    url: str,
    *,
    headed: bool = False,
    browser_mode: str = "chromium",
    profile: str | None = None,
) -> dict[str, Any]:
    """Open URL. Returns observations dict."""
    _progress(f"bu_open: open_url start session_name={session_name!r} url={url!r}")
    try:
        _get_or_create_session(
            session_name, headed=headed, browser_mode=browser_mode, profile=profile
        )
        _progress("bu_open: session ready, opening page...")
        result = _run_async(_do_open(session_name, url, headed))
        _progress("bu_open: open_url complete (returning)")
        return result
    except Exception as e:
        logger.exception("[bu_open] open_url failed: %s", e)
        _progress(f"bu_open: open_url failed: {e}")
        return {"error": str(e)}


def get_state(session_name: str) -> StateSnapshot:
    """Get current page state with clickable elements and selector candidates."""

    async def _do() -> StateSnapshot:
        data = _sessions.get(session_name)
        if not data:
            return StateSnapshot()
        # Use a fresh Page for this call so CDP session is valid in this coroutine
        if data.target_id:
            from browser_use.actor.page import Page as PageCls

            page = PageCls(data.browser, data.target_id)
        elif data.page:
            page = data.page
        else:
            return StateSnapshot()
        try:
            url = await page.evaluate("() => window.location.href") or ""
            title = await page.evaluate("() => document.title") or ""
        except Exception:
            url = title = ""
        try:
            raw = await page.evaluate(
                f"() => {{ "
                f"const sel = {repr(CLICKABLE_SELECTOR)}; "
                f"const els = document.querySelectorAll(sel); "
                f"return Array.from(els).map((el, i) => {{ "
                f"const m = {{}}; for (const a of el.attributes) m[a.name] = a.value; "
                f"return {{ index: i, tag: el.tagName.toLowerCase(), text: (el.textContent||'').slice(0,200), attrs: m }}; "
                f"}}); }}"
            )
        except Exception:
            raw = "[]"
        # browser_use Page.evaluate returns a JSON string for arrays/objects
        if isinstance(raw, str) and raw.strip():
            try:
                raw = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                raw = []
        if not isinstance(raw, list):
            raw = []
        elements: list[ElementInfo] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            tag = item.get("tag", "?")
            text = item.get("text", "")
            attrs = item.get("attrs") or {}
            if not isinstance(attrs, dict):
                attrs = dict(attrs) if attrs else {}
            candidates = _derive_selectors(tag, attrs, text)
            elements.append(
                ElementInfo(
                    index=item.get("index", len(elements)),
                    tag=tag,
                    text=text,
                    attributes=attrs,
                    selector_candidates=candidates,
                )
            )

        # Content elements: text-bearing nodes for extraction (div, span, p, headings, time)
        content_raw: Any = []
        try:
            content_raw = await page.evaluate(
                f"() => {{ "
                f"const sel = {repr(CONTENT_SELECTOR)}; "
                f"const els = document.querySelectorAll(sel); "
                f"const out = []; "
                f"for (let i = 0; i < els.length && out.length < {MAX_CONTENT_ELEMENTS}; i++) {{ "
                f"  const el = els[i]; "
                f"  const t = (el.textContent||'').trim(); "
                f"  if (t.length < 3) continue; "
                f"  const m = {{}}; for (const a of el.attributes) m[a.name] = a.value; "
                f"  out.push({{ index: out.length, tag: el.tagName.toLowerCase(), text: t.slice(0, {MAX_CONTENT_TEXT_LEN}), attrs: m }}); "
                f"}} "
                f"return out; }}"
            )
        except Exception:
            content_raw = []
        if isinstance(content_raw, str) and content_raw.strip():
            try:
                content_raw = json.loads(content_raw)
            except (json.JSONDecodeError, TypeError):
                content_raw = []
        if not isinstance(content_raw, list):
            content_raw = []
        content_elements: list[ElementInfo] = []
        for item in content_raw:
            if not isinstance(item, dict):
                continue
            tag = item.get("tag", "?")
            text = item.get("text", "")
            attrs = item.get("attrs") or {}
            if not isinstance(attrs, dict):
                attrs = dict(attrs) if attrs else {}
            candidates = _derive_selectors(tag, attrs, text)
            content_elements.append(
                ElementInfo(
                    index=item.get("index", len(content_elements)),
                    tag=tag,
                    text=text,
                    attributes=attrs,
                    selector_candidates=candidates,
                )
            )

        snap = StateSnapshot(
            url=url, title=title, elements=elements, content_elements=content_elements
        )
        data.last_state = snap
        data.page = page  # Keep for click/input etc. that use data.page
        return snap

    try:
        return _run_async(_do())
    except Exception:
        return StateSnapshot()


def _derive_selectors(tag: str, attrs: dict[str, str], text: str) -> list[str]:
    """Derive selector candidates: data-testid > id > aria-label > name > href > nth."""
    candidates: list[str] = []
    if attrs.get("data-testid"):
        candidates.append(f'[data-testid="{attrs["data-testid"]}"]')
    if attrs.get("id") and not any(c in attrs.get("id", "") for c in " "):
        candidates.append(f"#{attrs['id']}")
    if attrs.get("aria-label"):
        candidates.append(f'[aria-label="{attrs["aria-label"]}"]')
    if attrs.get("name") and tag in ("input", "select", "textarea", "button"):
        candidates.append(f'{tag}[name="{attrs["name"]}"]')
    if attrs.get("href") and tag == "a":
        candidates.append(f'a[href="{attrs["href"]}"]')
    candidates.append(f"{tag}:nth-of-type(1)")  # weak fallback
    return candidates[:5]


def click(
    session_name: str, *, selector: str | None = None, index: int | None = None
) -> dict[str, Any]:
    """Click by selector or index."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page. Call bu_open first."}
        page = data.page
        if selector:
            els = await page.get_elements_by_css_selector(selector)
            if not els:
                return {"error": f"No element for selector: {selector}"}
            await els[0].click()
        elif index is not None:
            if not data.last_state:
                return {
                    "error": "Run bu_state first before using index. Indices come from bu_state elements."
                }
            if index < 0 or index >= len(data.last_state.elements):
                return {
                    "error": f"Index {index} out of range (0..{len(data.last_state.elements) - 1})"
                }
            els = await page.get_elements_by_css_selector(CLICKABLE_SELECTOR)
            if index < len(els):
                await els[index].click()
            else:
                return {
                    "error": f"Index {index} out of range (page may have changed since bu_state)"
                }
        else:
            return {"error": "Provide selector or index"}
        url = await page.evaluate("() => window.location.href")
        return {"url": url}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def input_text(
    session_name: str,
    text: str,
    *,
    selector: str | None = None,
    index: int | None = None,
) -> dict[str, Any]:
    """Click element then fill text."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page."}
        page = data.page
        if selector:
            els = await page.get_elements_by_css_selector(selector)
            if not els:
                return {"error": f"No element for: {selector}"}
            await els[0].click()
            await els[0].fill(text)
        elif index is not None:
            if not data.last_state:
                return {
                    "error": "Run bu_state first before using index. Indices come from bu_state elements."
                }
            if index < 0 or index >= len(data.last_state.elements):
                return {
                    "error": f"Index {index} out of range (0..{len(data.last_state.elements) - 1})"
                }
            els = await page.get_elements_by_css_selector(CLICKABLE_SELECTOR)
            if index < len(els):
                await els[index].click()
                await els[index].fill(text)
            else:
                return {
                    "error": f"Index {index} out of range (page may have changed since bu_state)"
                }
        else:
            return {"error": "Provide selector or index"}
        return {}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def type_text(session_name: str, text: str) -> dict[str, Any]:
    """Type into focused element."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page."}
        # browser_use Page does not expose Playwright's keyboard API directly.
        # Type by mutating active element value and dispatching input/change events.
        ok = await data.page.evaluate(
            "() => true"
            if not text
            else (
                "(txt) => {"
                "  const el = document.activeElement;"
                "  if (!el) return false;"
                "  if (el.isContentEditable) {"
                "    document.execCommand('insertText', false, txt);"
                "    return true;"
                "  }"
                "  if ('value' in el) {"
                "    const val = el.value ?? '';"
                "    const start = Number.isInteger(el.selectionStart) ? el.selectionStart : val.length;"
                "    const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : val.length;"
                "    el.value = val.slice(0, start) + txt + val.slice(end);"
                "    const cursor = start + txt.length;"
                "    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(cursor, cursor);"
                "    el.dispatchEvent(new Event('input', { bubbles: true }));"
                "    el.dispatchEvent(new Event('change', { bubbles: true }));"
                "    return true;"
                "  }"
                "  return false;"
                "}"
            ),
            text,
        )
        if not _maybe_json(ok):
            return {"error": "No active editable element to type into."}
        return {}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def press_keys(session_name: str, keys: str) -> dict[str, Any]:
    """Send keyboard keys."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page."}
        await data.page.press(keys)
        # Give navigation-triggering keys (e.g., Enter) a chance to settle.
        await asyncio.sleep(0.3)
        url = await data.page.evaluate("() => window.location.href")
        return {"url": url}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def scroll(session_name: str, direction: str, amount: int) -> dict[str, Any]:
    """Scroll page."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page."}
        dy = amount if direction == "down" else -amount
        await data.page.evaluate(f"() => window.scrollBy(0, {dy})")
        return {}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def wait_selector(
    session_name: str, selector: str, timeout_ms: int, state: str
) -> dict[str, Any]:
    """Wait for selector."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page."}
        # Simple poll; browser_use may have wait_for_selector
        import time

        t0 = time.monotonic()
        while (time.monotonic() - t0) * 1000 < timeout_ms:
            els = await data.page.get_elements_by_css_selector(selector)
            if els:
                return {}
            await asyncio.sleep(0.1)
        return {"error": f"Timeout waiting for {selector}"}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def wait_text(session_name: str, text: str, timeout_ms: int) -> dict[str, Any]:
    """Wait for text to appear."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page."}
        import time

        t0 = time.monotonic()
        while (time.monotonic() - t0) * 1000 < timeout_ms:
            found = await data.page.evaluate(
                f"() => (document.body?.innerText || '').toLowerCase().includes({repr(text.lower())})"
            )
            if found:
                return {}
            await asyncio.sleep(0.1)
        return {"error": f"Timeout waiting for text: {text}"}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}


def get_text(
    session_name: str, *, selector: str | None = None, index: int | None = None
) -> dict[str, Any]:
    """Get text of element."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page.", "text": ""}
        page = data.page
        if selector:
            text = await page.evaluate(
                f"() => {{ const e = document.querySelector({repr(selector)}); return e ? (e.textContent || '') : ''; }}"
            )
            return {"text": text or ""}
        if index is not None:
            if not data.last_state:
                return {
                    "error": "Run bu_state first before using index. Indices come from bu_state elements.",
                    "text": "",
                }
            if index < 0 or index >= len(data.last_state.elements):
                return {
                    "error": f"Index {index} out of range (0..{len(data.last_state.elements) - 1})",
                    "text": "",
                }
            text = await page.evaluate(
                f"() => {{ const els = document.querySelectorAll({repr(CLICKABLE_SELECTOR)}); "
                f"const el = els[{index}]; return el ? (el.textContent || '') : ''; }}"
            )
            return {"text": text or ""}
        return {"error": "Provide selector or index", "text": ""}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e), "text": ""}


def get_html(session_name: str, selector: str | None = None) -> dict[str, Any]:
    """Get HTML of page or element."""
    max_chars = 12000

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"html": "", "error": "No page."}
        if selector:
            html = await data.page.evaluate(
                f"() => {{ const e=document.querySelector({repr(selector)}); return e?e.outerHTML:''; }}"
            )
        else:
            html = await data.page.evaluate("() => document.documentElement.outerHTML")
        text = html or ""
        if len(text) > max_chars:
            return {
                "html": text[:max_chars],
                "truncated": True,
                "original_length": len(text),
                "max_chars": max_chars,
            }
        return {
            "html": text,
            "truncated": False,
            "original_length": len(text),
            "max_chars": max_chars,
        }

    try:
        return _run_async(_do())
    except Exception as e:
        return {"html": "", "error": str(e)}


def eval_js(session_name: str, js: str) -> dict[str, Any]:
    """Evaluate JavaScript. Use arrow form: () => expr, or a statement like return new Promise(...)."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page.", "result": None}
        js_stripped = js.strip()
        if js_stripped.startswith("(") and "=>" in js_stripped:
            wrapped = js
        elif js_stripped.startswith("return "):
            wrapped = f"() => {{ {js_stripped} }}"
        else:
            wrapped = f"() => {{ return ({js}); }}"
        result = await data.page.evaluate(wrapped)
        return {"result": _maybe_json(result)}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e), "result": None}


def detect_bot_block(session_name: str) -> dict[str, Any]:
    """Detect common anti-bot / captcha blocking pages."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"blocked": False, "reason": "No page."}

        js = """
        () => {
          const url = (window.location && window.location.href) || '';
          const title = (document.title || '').toLowerCase();
          const text = ((document.body && document.body.innerText) || '').toLowerCase();
          const hit = (needle) => text.includes(needle);

          const signals = [];
          if (url.includes('/sorry') || url.includes('/captcha')) signals.push('url');
          if (title.includes('sorry') || title.includes('captcha')) signals.push('title');
          if (hit('unusual traffic')) signals.push('unusual_traffic');
          if (hit('not a robot')) signals.push('not_a_robot');
          if (hit('verify you are human')) signals.push('verify_human');
          if (hit('our systems have detected')) signals.push('systems_detected');
          if (hit('detected unusual traffic')) signals.push('detected_unusual_traffic');

          const blocked = signals.length > 0;
          return {
            blocked,
            signals,
            url,
            title: document.title || '',
            reason: blocked ? `Detected block/captcha signals: ${signals.join(', ')}` : ''
          };
        }
        """
        result = await data.page.evaluate(js)
        parsed = _maybe_json(result)
        if isinstance(parsed, dict):
            return parsed
        return {"blocked": False, "reason": ""}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"blocked": False, "reason": str(e)}


def extract_pricing_plans(session_name: str) -> dict[str, Any]:
    """Best-effort extraction of pricing plans and bullets from current page."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"plans": [], "source": "no_page"}

        js = r"""
        () => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const hasPriceHint = (s) => /\$|€|£|\/\s*(month|mo|year|yr|user)|per\s+(month|year|user)|free|trial/i.test(s || '');
          const badHeading = (s) => /^(features?|resources?|docs?|about|contact|security|support|faq|help|enterprise( plan)?|pricing)$/i.test((s || '').trim());

          const seen = new Set();
          const plans = [];
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'));

          for (const h of headings) {
            const name = norm(h.textContent);
            if (!name || name.length > 60 || badHeading(name)) continue;

            let container = h.closest('section, article, li, div') || h.parentElement;
            if (!container) continue;

            const containerText = norm(container.innerText || '');
            const bullets = Array.from(container.querySelectorAll('li'))
              .map((li) => norm(li.textContent))
              .filter((t) => t && t.length >= 6 && t.length <= 180);

            const uniqueBullets = [];
            const bulletSeen = new Set();
            for (const b of bullets) {
              const key = b.toLowerCase();
              if (!bulletSeen.has(key)) {
                bulletSeen.add(key);
                uniqueBullets.push(b);
              }
              if (uniqueBullets.length >= 6) break;
            }

            const strongCandidate = uniqueBullets.length >= 2 || hasPriceHint(containerText);
            if (!strongCandidate) continue;

            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            plans.push({
              name,
              key_bullets: uniqueBullets,
              price_hint: hasPriceHint(containerText) ? true : false,
            });
          }

          return { plans: plans.slice(0, 20), source: 'dom_heuristic' };
        }
        """
        result = await data.page.evaluate(js)
        parsed = _maybe_json(result)
        if isinstance(parsed, dict):
            plans = parsed.get("plans")
            if isinstance(plans, list):
                return {"plans": plans, "source": parsed.get("source", "dom_heuristic")}
        return {"plans": [], "source": "unknown"}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"plans": [], "source": "error", "error": str(e)}


def screenshot(
    session_name: str, path: str | None = None, full: bool = False
) -> dict[str, Any]:
    """Take screenshot."""

    async def _do() -> dict[str, Any]:
        data = _sessions.get(session_name)
        if not data or not data.page:
            return {"error": "No page.", "path": None}
        # browser_use Page.screenshot does not accept a "path" kwarg in some versions.
        # Call it with supported arguments only and handle writing to disk ourselves.
        shot = await data.page.screenshot(full_page=full)
        # If caller requested a file path, best-effort persist bytes or use returned path.
        if path:
            try:
                if isinstance(shot, (bytes, bytearray)):
                    with open(path, "wb") as f:
                        f.write(shot)
                    return {"path": path}
                if isinstance(shot, str):
                    # Some implementations may return a file path directly.
                    return {"path": shot}
            except Exception as e:
                return {"error": str(e), "path": None}
        return {"path": path, "raw": shot}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e), "path": None}


def _create_llm_from_env() -> Any:
    """Create LLM for BrowserUse Agent from environment variables.
    Returns None to let browser-use use its default (DEFAULT_LLM env or ChatBrowserUse).
    """
    try:
        from browser_use.llm.models import get_llm_by_name

        model_name = os.getenv("BROWSER_USE_LLM_MODEL", "").strip()
        if model_name:
            return get_llm_by_name(model_name)
        if os.getenv("ANTHROPIC_API_KEY"):
            return get_llm_by_name("anthropic_claude_sonnet_4_20250514")
        if os.getenv("AZURE_OPENAI_API_KEY") or os.getenv("AZURE_OPENAI_KEY"):
            return get_llm_by_name("azure_gpt_4_1_mini")
        if os.getenv("GOOGLE_API_KEY"):
            return get_llm_by_name("google_gemini_2_5_pro")
        if os.getenv("OPENAI_API_KEY"):
            return get_llm_by_name("openai_gpt_4o_mini")
        return None
    except (ImportError, AttributeError, Exception) as e:
        logger.debug("Using browser-use default LLM: %s", e)
        return None


def run_agent_task(
    session_name: str,
    task: str,
    *,
    max_steps: int = 15,
    create_session_if_missing: bool = False,
    url_for_open: str | None = None,
    headed: bool = False,
    llm: Any = None,
) -> dict[str, Any]:
    """Run browser-use Agent on a small task. Uses existing session or creates one for bu_open.
    Returns {ok, message, data} with data including history_summary, final_result, url, etc.
    """

    async def _do() -> dict[str, Any]:
        from browser_use import Agent, Browser

        browser = None
        created_session = False
        if session_name in _sessions:
            browser = _sessions[session_name].browser
        elif create_session_if_missing and url_for_open:
            _progress("run_agent_task: creating new session for bu_open")
            user_agent = os.getenv("SMART_SCRAPING_USER_AGENT") or os.getenv(
                "BROWSER_USER_AGENT"
            )
            browser_kwargs: dict[str, Any] = {
                "headless": not headed,
                "keep_alive": True,
            }
            if user_agent:
                browser_kwargs["user_agent"] = user_agent
            browser = Browser(**browser_kwargs)
            await browser.start()
            data = SessionData(browser=browser)
            _sessions[session_name] = data
            created_session = True
        else:
            return {
                "ok": False,
                "message": "No session. Call bu_open first.",
                "data": {},
            }

        effective_llm = llm or _create_llm_from_env()
        agent_kwargs: dict[str, Any] = {
            "task": task,
            "browser": browser,
            "directly_open_url": False,
        }
        if effective_llm is not None:
            agent_kwargs["llm"] = effective_llm

        agent = Agent(**agent_kwargs)
        _progress(f"run_agent_task: running agent (max_steps={max_steps})")
        try:
            history = await agent.run(max_steps=max_steps)
        except Exception as e:
            logger.exception("run_agent_task: agent.run failed: %s", e)
            return {
                "ok": False,
                "message": str(e),
                "data": {"error": str(e)},
            }

        final_result = None
        if hasattr(history, "final_result") and callable(history.final_result):
            final_result = history.final_result()
        is_successful = None
        if hasattr(history, "is_successful") and callable(history.is_successful):
            is_successful = history.is_successful()
        ar = getattr(history, "action_results", None)
        action_results = ar() if callable(ar) else (ar if isinstance(ar, list) else [])

        # After agent runs, update session page for bu_open case
        if created_session and session_name in _sessions:
            try:
                page = (
                    browser.get_current_page()
                    if hasattr(browser, "get_current_page")
                    else None
                )
                if page is not None:
                    _sessions[session_name].page = page
                    _sessions[session_name].target_id = getattr(
                        page, "_target_id", None
                    )
            except Exception as e:
                logger.warning("run_agent_task: could not get current page: %s", e)

        # Build result
        extracted = []
        action_trace: list[dict[str, Any]] = []
        for i, r in enumerate(action_results):
            if hasattr(r, "extracted_content") and r.extracted_content:
                extracted.append(str(r.extracted_content))
            trace_item: dict[str, Any] = {"step": i + 1}
            if hasattr(r, "action") and getattr(r, "action") is not None:
                trace_item["action"] = str(getattr(r, "action"))
            if hasattr(r, "error") and getattr(r, "error"):
                trace_item["error"] = str(getattr(r, "error"))
            if hasattr(r, "is_done") and getattr(r, "is_done") is not None:
                trace_item["is_done"] = bool(getattr(r, "is_done"))
            if hasattr(r, "extracted_content") and getattr(r, "extracted_content"):
                trace_item["extracted_preview"] = str(getattr(r, "extracted_content"))[
                    :300
                ]
            if len(trace_item) > 1:
                action_trace.append(trace_item)
        data: dict[str, Any] = {
            "history_summary": f"{len(getattr(history, 'history', []) or [])} steps",
            "final_result": final_result,
            "extracted": extracted[:5],
            "action_trace": action_trace[:25],
            "is_successful": is_successful,
        }
        if (
            created_session
            and session_name in _sessions
            and _sessions[session_name].page
        ):
            try:
                url = await _sessions[session_name].page.evaluate(
                    "() => window.location.href"
                )
                data["url"] = url
                data["title"] = await _sessions[session_name].page.evaluate(
                    "() => document.title"
                )
            except Exception:
                pass
        elif session_name in _sessions and _sessions[session_name].page:
            try:
                url = await _sessions[session_name].page.evaluate(
                    "() => window.location.href"
                )
                data["url"] = url
            except Exception:
                pass

        return {
            "ok": is_successful is not False
            and "error" not in str(final_result or "").lower(),
            "message": str(final_result) if final_result else "",
            "data": data,
        }

    try:
        return _run_async(_do())
    except Exception as e:
        logger.exception("run_agent_task failed: %s", e)
        return {"ok": False, "message": str(e), "data": {"error": str(e)}}


def close_session(session_name: str, all_sessions: bool = False) -> dict[str, Any]:
    """Close browser session(s)."""

    async def _do() -> dict[str, Any]:
        if all_sessions:
            for name, data in list(_sessions.items()):
                try:
                    await data.browser.stop()
                except Exception:
                    pass
                del _sessions[name]
        elif session_name in _sessions:
            try:
                await _sessions[session_name].browser.stop()
            except Exception:
                pass
            del _sessions[session_name]
        return {}

    try:
        return _run_async(_do())
    except Exception as e:
        return {"error": str(e)}
