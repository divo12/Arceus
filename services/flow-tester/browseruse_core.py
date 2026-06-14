"""Central agentic BrowserUse tool implementations.

Each ``bu_*_impl`` function delegates to a browser-use Agent (LLM-driven)
via ``run_agent_task``. This is the single canonical source for the agentic
tool logic used by both the OpenAI Agents SDK wrappers (sdk_tools.py) and
the Temporal activity wrappers (activities.py).

Session infrastructure is imported directly from browseruse_session.py.
The action log (recipe) is managed here independently so this module has
no dependency on browseruse_tools.py (which carries a 'swarm' dependency
not available in the eu-swarm repo).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from browseruse_session import (
    DEFAULT_SESSION,
    close_session,
    get_state,
    run_agent_task,
)

# ── Action log (recipe) state ──────────────────────────────────────────────
# Keyed by session_name; each value is the ordered list of recipe steps.

_action_logs: dict[str, list[dict[str, Any]]] = defaultdict(list)


def _infer_selector_strategy(selector: str) -> str:
    """Infer how a selector was likely derived."""
    if not selector:
        return "unknown"
    if selector.startswith("[data-testid="):
        return "data-testid"
    if selector.startswith("#"):
        return "id"
    if "[aria-label=" in selector:
        return "aria-label"
    if "[name=" in selector:
        return "name"
    if selector.startswith("a[href="):
        return "href"
    if ":nth-of-type" in selector or ":nth-child" in selector:
        return "nth-child"
    return "css"


def _append_step(
    session_name: str,
    action: str,
    params: dict[str, Any],
    observations: dict[str, Any] | None = None,
    *,
    mode: str = "agentic",
    ok: bool | None = None,
    message: str | None = None,
) -> None:
    """Append a normalized step to the in-memory action log for a session."""
    p = dict(params)
    if "selector" in p:
        p["selector_strategy"] = _infer_selector_strategy(p["selector"])
    replay_safe = not (
        "goal" in p
        and p.get("goal")
        and not p.get("selector")
        and p.get("index") is None
    )
    obs = dict(observations or {})
    obs.setdefault(
        "_meta",
        {
            "session_name": session_name,
            "mode": mode,
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "replay_safe": replay_safe,
            "ok": ok,
            "message": message or "",
        },
    )
    _action_logs[session_name].append(
        {"action": action, "params": p, "expects": [], "observations": obs}
    )


def get_action_log(session_name: str = DEFAULT_SESSION) -> list[dict[str, Any]]:
    """Return the accumulated recipe steps for a session."""
    return list(_action_logs[session_name])


def get_canonical_recipe_steps() -> tuple[list[dict[str, Any]], str]:
    """Return the best action-log recipe for hydrating smart-scraping output.

    Chooses the session with the longest step list; on a tie, prefers
    ``DEFAULT_SESSION``. Returns ``([], "")`` when no steps exist.
    """
    if not _action_logs:
        return [], ""
    candidates: list[tuple[int, int, str, list[dict[str, Any]]]] = []
    for name, steps in list(_action_logs.items()):
        if not steps:
            continue
        tie_break = 0 if name == DEFAULT_SESSION else 1
        candidates.append((-len(steps), tie_break, name, list(steps)))
    if not candidates:
        return [], ""
    candidates.sort()
    _, _, session_name, best = candidates[0]
    return best, session_name


def clear_action_log(session_name: str | None = None) -> None:
    """Clear action log for a session, or all sessions if None."""
    if session_name is None:
        _action_logs.clear()
    elif session_name in _action_logs:
        _action_logs[session_name].clear()


# ── Output conversion helpers ──────────────────────────────────────────────


def _agent_session_out(res: dict[str, Any]) -> dict:
    """Convert run_agent_task response to tool output format."""
    ok = res.get("ok", False)
    message = res.get("message", "")
    data = res.get("data", {})
    return {"ok": ok, "message": message, "data": data}


def _observation_from_agent_result(
    res: dict[str, Any],
) -> tuple[dict[str, Any], bool, str]:
    """Normalize agentic tool result into recipe observation payload."""
    out = _agent_session_out(res)
    obs = dict(out.get("data", {}))
    if not out.get("ok", False):
        obs["error"] = out.get("message", "")
    return obs, bool(out.get("ok", False)), str(out.get("message", ""))


# ── Pydantic input/output models ───────────────────────────────────────────


class BuOpenInput(BaseModel):
    url: str = Field(..., description="URL to open.")
    session_name: str = Field(default=DEFAULT_SESSION)
    headed: bool = Field(default=False, description="Show browser window.")
    browser_mode: str = Field(
        default="chromium", description="chromium, real, or remote."
    )
    profile: str | None = Field(default=None)


class BuOpenOutput(BaseModel):
    ok: bool = Field(...)
    message: str = Field(default="")
    data: dict = Field(default_factory=dict)


class BuStateInput(BaseModel):
    session_name: str = Field(default=DEFAULT_SESSION)


class BuStateOutput(BaseModel):
    ok: bool = Field(...)
    message: str = Field(default="")
    data: dict = Field(default_factory=dict)


class BuClickInput(BaseModel):
    selector: str | None = Field(default=None, description="CSS selector (preferred).")
    index: int | None = Field(
        default=None, description="Element index from bu_state (fallback)."
    )
    goal: str | None = Field(
        default=None, description="Natural language goal, e.g. 'the Sign in button'."
    )
    session_name: str = Field(default=DEFAULT_SESSION)


class BuClickOutput(BaseModel):
    ok: bool = Field(...)
    message: str = Field(default="")
    data: dict = Field(default_factory=dict)


class BuInputInput(BaseModel):
    selector: str | None = Field(default=None, description="CSS selector (preferred).")
    index: int | None = Field(default=None, description="Element index (fallback).")
    text: str = Field(...)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuTypeInput(BaseModel):
    text: str = Field(...)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuKeysInput(BaseModel):
    keys: str = Field(..., description='e.g. "Enter", "Control+a"')
    session_name: str = Field(default=DEFAULT_SESSION)


class BuScrollInput(BaseModel):
    direction: str = Field(default="down", description="down or up.")
    amount: int = Field(default=500)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuWaitSelectorInput(BaseModel):
    selector: str = Field(...)
    timeout_ms: int = Field(default=5000)
    state: str = Field(default="visible", description="visible, hidden, attached")
    session_name: str = Field(default=DEFAULT_SESSION)


class BuWaitTextInput(BaseModel):
    text: str = Field(...)
    timeout_ms: int = Field(default=5000)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuGetTextInput(BaseModel):
    selector: str | None = Field(default=None, description="CSS selector (preferred).")
    index: int | None = Field(default=None, description="Element index (fallback).")
    goal: str | None = Field(
        default=None, description="Natural language, e.g. 'the main price'."
    )
    session_name: str = Field(default=DEFAULT_SESSION)


class BuGetHtmlInput(BaseModel):
    selector: str | None = Field(default=None)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuEvalInput(BaseModel):
    js: str = Field(...)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuScreenshotInput(BaseModel):
    path: str | None = Field(default=None)
    full: bool = Field(default=False)
    session_name: str = Field(default=DEFAULT_SESSION)


class BuCloseInput(BaseModel):
    session_name: str = Field(default=DEFAULT_SESSION)
    all_sessions: bool = Field(default=False)


class BuDetectBlockInput(BaseModel):
    session_name: str = Field(default=DEFAULT_SESSION)


class BuExtractPricingPlansInput(BaseModel):
    session_name: str = Field(default=DEFAULT_SESSION)


class BuGetActionLogInput(BaseModel):
    session_name: str = Field(default=DEFAULT_SESSION)


class BuGetActionLogOutput(BaseModel):
    ok: bool = Field(...)
    recipe: list[dict] = Field(default_factory=list)
    message: str = Field(default="")


# ── Agentic bu_*_impl functions ────────────────────────────────────────────


def bu_open_impl(
    url: str,
    session_name: str = DEFAULT_SESSION,
    headed: bool = False,
    browser_mode: str = "chromium",
    profile: str | None = None,
) -> dict:
    """Open a URL in the browser. Always call bu_state after to see clickable elements."""
    task = f"Navigate to {url} and wait for the page to fully load. Do not navigate elsewhere or interact with the page."
    res = run_agent_task(
        session_name,
        task,
        create_session_if_missing=True,
        url_for_open=url,
        headed=headed,
        max_steps=10,
    )
    params = {
        "url": url,
        "headed": headed,
        "browser_mode": browser_mode,
        "profile": profile,
    }
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(session_name, "open", params, obs, mode="agentic", ok=ok, message=msg)
    out = _agent_session_out(res)
    if res.get("ok") and res.get("data"):
        out["data"].setdefault("url", res["data"].get("url", url))
        out["data"].setdefault("title", res["data"].get("title", ""))
    return out


def bu_state_impl(session_name: str = DEFAULT_SESSION) -> dict:
    """Get current URL, title, clickable elements (for actions), and content_elements (for extraction)."""
    task = (
        "Analyze the current page. Return: (1) current URL, (2) page title, "
        "(3) list of clickable elements (links, buttons, inputs) with text and suggested CSS selectors, "
        "(4) list of content elements (div, span, p, h1-h6) for text extraction with selectors. "
        "Be concise and structured."
    )
    res = run_agent_task(session_name, task, max_steps=8)
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(session_name, "state", {}, obs, mode="agentic", ok=ok, message=msg)
    if res.get("ok"):
        final = res.get("data", {}).get("final_result") or res.get("message", "")
        extracted = res.get("data", {}).get("extracted", [])
        data: dict[str, Any] = {
            "raw_analysis": final or (extracted[0] if extracted else "")
        }
        try:
            snap = get_state(session_name)
            data.update(snap.to_dict())
        except Exception:
            pass
        return {"ok": True, "message": "", "data": data}
    return _agent_session_out(res)


def bu_click_impl(
    selector: str | None = None,
    index: int | None = None,
    goal: str | None = None,
    session_name: str = DEFAULT_SESSION,
) -> dict:
    """Click element by goal (natural language), CSS selector, or index from bu_state."""
    if goal:
        task = f"Click: {goal}."
    elif selector:
        task = f"Click the element matching CSS selector: {selector}."
    elif index is not None:
        task = f"Click the {index}th clickable element on the page (0-based index)."
    else:
        return {"ok": False, "message": "Provide selector, index, or goal", "data": {}}
    res = run_agent_task(session_name, task, max_steps=5)
    params: dict[str, Any] = {}
    if goal:
        params["goal"] = goal
    if selector:
        params["selector"] = selector
    if index is not None:
        params["index"] = index
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(session_name, "click", params, obs, mode="agentic", ok=ok, message=msg)
    return _agent_session_out(res)


def bu_input_impl(
    text: str,
    selector: str | None = None,
    index: int | None = None,
    session_name: str = DEFAULT_SESSION,
) -> dict:
    """Click element by selector or index, then type text. Use for form fields."""
    if selector:
        task = f"Focus the element matching CSS selector {selector} and type: {text!r}"
    elif index is not None:
        task = f"Focus the {index}th clickable element and type: {text!r}"
    else:
        return {"ok": False, "message": "Provide selector or index", "data": {}}
    res = run_agent_task(session_name, task, max_steps=5)
    params: dict[str, Any] = {"text": text}
    if selector:
        params["selector"] = selector
    if index is not None:
        params["index"] = index
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(session_name, "input", params, obs, mode="agentic", ok=ok, message=msg)
    return _agent_session_out(res)


def bu_type_impl(text: str, session_name: str = DEFAULT_SESSION) -> dict:
    """Type text into the focused element."""
    task = f"Type the following into the currently focused element: {text!r}"
    res = run_agent_task(session_name, task, max_steps=3)
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "type", {"text": text}, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_keys_impl(keys: str, session_name: str = DEFAULT_SESSION) -> dict:
    """Press keyboard keys (e.g., 'Enter', 'Control+a')."""
    task = f"Press the keyboard keys: {keys}"
    res = run_agent_task(session_name, task, max_steps=3)
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "keys", {"keys": keys}, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_scroll_impl(
    direction: str = "down", amount: int = 500, session_name: str = DEFAULT_SESSION
) -> dict:
    """Scroll the page up or down."""
    task = f"Scroll the page {direction} by {amount} pixels."
    res = run_agent_task(session_name, task, max_steps=3)
    params = {"direction": direction, "amount": amount}
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "scroll", params, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_wait_selector_impl(
    selector: str,
    timeout_ms: int = 5000,
    state: str = "visible",
    session_name: str = DEFAULT_SESSION,
) -> dict:
    """Wait for a CSS selector to be in a certain state (visible, hidden, attached)."""
    task = f"Wait until an element matching CSS selector {selector} is {state} on the page. Timeout: {timeout_ms}ms."
    res = run_agent_task(session_name, task, max_steps=5)
    params = {"selector": selector, "timeout_ms": timeout_ms, "state": state}
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "wait_selector", params, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_wait_text_impl(
    text: str, timeout_ms: int = 5000, session_name: str = DEFAULT_SESSION
) -> dict:
    """Wait for text to appear on the page."""
    task = f"Wait until the text '{text}' appears on the page. Timeout: {timeout_ms}ms."
    res = run_agent_task(session_name, task, max_steps=5)
    params = {"text": text, "timeout_ms": timeout_ms}
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "wait_text", params, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_get_text_impl(
    selector: str | None = None,
    index: int | None = None,
    goal: str | None = None,
    session_name: str = DEFAULT_SESSION,
) -> dict:
    """Get text content of element by goal, CSS selector, or index."""
    if goal:
        task = f"Extract and return the text content of the element that matches: {goal}. Return only the extracted text."
    elif selector:
        task = f"Extract and return the text content of the element matching CSS selector: {selector}. Return only the extracted text."
    elif index is not None:
        task = f"Extract and return the text content of the {index}th clickable element. Return only the extracted text."
    else:
        return {"ok": False, "message": "Provide selector, index, or goal", "data": {}}
    res = run_agent_task(session_name, task, max_steps=5)
    params: dict[str, Any] = {}
    if goal:
        params["goal"] = goal
    if selector:
        params["selector"] = selector
    if index is not None:
        params["index"] = index
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "get_text", params, obs, mode="agentic", ok=ok, message=msg
    )
    out = _agent_session_out(res)
    text_val = (
        res.get("data", {}).get("final_result") or res.get("message", "")
    ).strip()
    extracted = res.get("data", {}).get("extracted", [])
    if extracted:
        text_val = (
            extracted[0] if isinstance(extracted[0], str) else str(extracted[0])
        ).strip()
    out.setdefault("data", {})["text"] = text_val
    out["data"]["empty"] = not bool(text_val)
    out["data"]["text_len"] = len(text_val)
    if out.get("ok") and not text_val:
        out["message"] = "Empty text for selector"
    return out


def bu_get_html_impl(
    selector: str | None = None, session_name: str = DEFAULT_SESSION
) -> dict:
    """Get HTML of page or element (optionally filtered by selector)."""
    if selector:
        task = f"Get the outerHTML of the element matching CSS selector: {selector}. Return the HTML string."
    else:
        task = "Get the outerHTML of the full page (document.documentElement). Return the HTML string. It may be truncated."
    res = run_agent_task(session_name, task, max_steps=5)
    params = {"selector": selector} if selector else {}
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "get_html", params, obs, mode="agentic", ok=ok, message=msg
    )
    out = _agent_session_out(res)
    html = (res.get("data", {}).get("final_result") or "").strip()
    extracted = res.get("data", {}).get("extracted", [])
    if extracted:
        html = (
            extracted[0] if isinstance(extracted[0], str) else str(extracted[0])
        ).strip()
    out.setdefault("data", {})["html"] = html[:12000] if html else ""
    out["data"]["truncated"] = len(html) > 12000
    out["data"]["original_length"] = len(html)
    out["data"]["max_chars"] = 12000
    return out


def bu_eval_impl(js: str, session_name: str = DEFAULT_SESSION) -> dict:
    """Execute JavaScript in the page and return result."""
    task = f"Execute this JavaScript in the page and return the result: {js}. Return only the result value."
    res = run_agent_task(session_name, task, max_steps=5)
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "eval", {"js": js}, obs, mode="agentic", ok=ok, message=msg
    )
    out = _agent_session_out(res)
    result = res.get("data", {}).get("final_result")
    extracted = res.get("data", {}).get("extracted", [])
    if extracted:
        result = extracted[0]
    out.setdefault("data", {})["result"] = result
    return out


def bu_detect_block_impl(session_name: str = DEFAULT_SESSION) -> dict:
    """Detect whether current page is a bot/CAPTCHA/sorry block page."""
    task = (
        "Check if the current page is a bot block, CAPTCHA, or 'sorry' page. "
        "Return blocked=true or false and a brief reason. Do not attempt to solve it."
    )
    res = run_agent_task(session_name, task, max_steps=3)
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "detect_block", {}, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_extract_pricing_plans_impl(session_name: str = DEFAULT_SESSION) -> dict:
    """Extract plan names and key feature bullets from current pricing/product page."""
    task = (
        "Extract pricing plan names and key feature bullets from the current page. "
        "Return structured data: plans with name, key_bullets, price_hint."
    )
    res = run_agent_task(session_name, task, max_steps=8)
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name,
        "extract_pricing_plans",
        {},
        obs,
        mode="agentic",
        ok=ok,
        message=msg,
    )
    out = _agent_session_out(res)
    out.setdefault("data", {})["plans"] = res.get("data", {}).get("extracted", [])
    out["data"]["source"] = "agent"
    return out


def bu_screenshot_impl(
    path: str | None = None, full: bool = False, session_name: str = DEFAULT_SESSION
) -> dict:
    """Take screenshot. Optional path to save file."""
    parts = ["Take a screenshot"]
    if full:
        parts.append("of the full page")
    if path:
        parts.append(f"and save to {path}")
    task = ". ".join(parts) + "."
    res = run_agent_task(session_name, task, max_steps=5)
    params = {"path": path, "full": full}
    obs, ok, msg = _observation_from_agent_result(res)
    _append_step(
        session_name, "screenshot", params, obs, mode="agentic", ok=ok, message=msg
    )
    return _agent_session_out(res)


def bu_close_impl(
    session_name: str = DEFAULT_SESSION, all_sessions: bool = False
) -> dict:
    """Close browser session(s)."""
    res = close_session(session_name, all_sessions=all_sessions)
    err = res.get("error")
    out = {
        "ok": err is None,
        "message": str(err) if err else "",
        "data": {k: v for k, v in res.items() if k != "error"},
    }
    _append_step(
        session_name,
        "close",
        {"all_sessions": all_sessions},
        out.get("data", {}),
        mode="agentic",
        ok=bool(out.get("ok", False)),
        message=str(out.get("message", "")),
    )
    return out


def bu_get_action_log_impl(session_name: str = DEFAULT_SESSION) -> dict:
    """Get the accumulated recipe (list of steps) for replay."""
    steps = get_action_log(session_name)
    return {"ok": True, "recipe": steps, "message": f"{len(steps)} steps recorded."}
