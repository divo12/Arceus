"""Arceus Flow-Tester — an LLM-driven browser agent that exercises a product's
core user flow (like a human QA / like the Arceus operator does by hand) and
returns a structured verdict.

It reuses the `browser-use` Agent via `run_agent_task` (browseruse_session.py):
give it a URL + a goal, it drives a real Chromium, and reports what works /
breaks plus a design-quality judgement. Runs as its OWN Railway service so the
browser never touches the slim Arceus API container (which is why the old
in-container probe was removed).

Endpoints:
  GET  /health      → liveness
  POST /flow-test   → { url, goal?, max_steps? } → verdict + action trace + screenshot
"""
from __future__ import annotations

import base64
import os
import uuid
from typing import Any, Optional

import logging

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from browseruse_session import run_agent_task, screenshot, close_session

logger = logging.getLogger("flow-tester")
app = FastAPI(title="Arceus Flow-Tester")


def _env(*names: str) -> str:
    """First non-empty value among env var names (supports ARCEUS_* and AZURE_* prefixes)."""
    for n in names:
        v = os.getenv(n, "").strip()
        if v:
            return v
    return ""


def build_llm():
    """Build the vision LLM for the browser agent.

    Prefer an EXPLICIT Azure config (reuse Arceus's Azure creds + a vision
    deployment) so we don't depend on browser-use's preset deployment names.
    Returns None to fall back to browseruse_session's env resolver.
    """
    endpoint = _env("AZURE_OPENAI_ENDPOINT", "ARCEUS_AZURE_OPENAI_ENDPOINT")
    key = _env("AZURE_OPENAI_API_KEY", "ARCEUS_AZURE_OPENAI_API_KEY")
    version = _env("AZURE_OPENAI_API_VERSION", "ARCEUS_AZURE_OPENAI_API_VERSION") or "2025-04-01-preview"
    # The deployment NAME of a VISION-capable model (e.g. gpt-5.2 / gpt-5.2-mini / gpt-4o).
    deployment = _env(
        "FLOW_TESTER_AZURE_DEPLOYMENT",
        "AZURE_OPENAI_DEPLOYMENT",
        "ARCEUS_AZURE_OPENAI_DEPLOYMENT",
        "ARCEUS_AZURE_OPENAI_BROWSER_DEPLOYMENT",
    )
    if endpoint and key and deployment:
        try:
            from browser_use import ChatAzureOpenAI  # type: ignore
            llm = ChatAzureOpenAI(
                model=deployment,
                api_key=key,
                azure_endpoint=endpoint,
                api_version=version,
            )
            logger.info("flow-tester LLM: Azure deployment '%s'", deployment)
            return llm
        except Exception as e:  # noqa: BLE001 - surface clearly, fall back
            logger.warning("Azure LLM build failed (%s); falling back to env resolver", e)
    return None

# Shared-secret auth — set FLOW_TESTER_TOKEN in the service env; the Arceus API
# sends it as `Authorization: Bearer <token>`. Reachable on Railway's private
# network, but the token is a second layer.
TOKEN = os.getenv("FLOW_TESTER_TOKEN", "").strip()

# The default QA brief. The agent SEES the page (vision) each step, so its
# verdict is grounded in what actually rendered — not the source code.
DEFAULT_GOAL = (
    "You are a meticulous QA tester evaluating a freshly built web app. "
    "Exercise its CORE user flows end-to-end with realistic inputs: create/add the "
    "primary item, edit it, toggle/complete it, delete it; then try any search, "
    "filter, sort, and any AI or primary-action buttons you see. "
    "Watch closely for: buttons/links that do nothing (dead controls), actions that "
    "throw or error, inputs that accept invalid data with no inline validation, data "
    "that does NOT persist after the action, and missing empty/loading/error states. "
    "Separately judge the VISUAL quality: god-tier (intentional typography, spacing, "
    "depth, motion, polish — like Linear/Vercel/Stripe) vs basic/generic (flat default "
    "shadcn, system font, no depth). "
    "Work EFFICIENTLY — you have a tight step budget. Don't over-explore; do a "
    "few real interactions covering the core flow, then CONCLUDE within ~7 actions. "
    "When done, finish your final answer in EXACTLY this shape:\n"
    "VERDICT: PASS or FAIL\n"
    "WORKS: <one line: does the core flow work end to end?>\n"
    "ISSUES: <numbered list of concrete broken/dead/missing things, or 'none'>\n"
    "DESIGN: <god-tier | acceptable | basic — plus one line why>"
)


class FlowTestRequest(BaseModel):
    url: str
    goal: Optional[str] = None
    # Tuned so the agent reliably reaches a verdict within AGENT_RUN_TIMEOUT_S
    # (~200s @ ~20s/step). 12 steps could not finish in the old 120s cap, so the
    # run was abandoned mid-verdict — see browseruse_session._run_async.
    max_steps: int = 8


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/flow-test")
def flow_test(req: FlowTestRequest, authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    if TOKEN:
        token = (authorization or "").removeprefix("Bearer ").strip()
        if token != TOKEN:
            raise HTTPException(status_code=401, detail="unauthorized")

    session = f"flowtest_{uuid.uuid4().hex[:8]}"
    # Pin the agent to the target URL explicitly — url_for_open alone doesn't
    # reliably navigate the agent, and without it in the task the agent wanders
    # (e.g. onto localhost). The product lives ONLY at this URL.
    nav = (
        f"FIRST navigate to this EXACT url and do ALL of your testing on it (never "
        f"go to localhost or any other host): {req.url}\n\n"
    )
    body = f"{req.goal}\n\n{DEFAULT_GOAL}" if req.goal else DEFAULT_GOAL
    task = nav + body

    try:
        result = run_agent_task(
            session,
            task,
            max_steps=max(5, min(req.max_steps, 10)),
            create_session_if_missing=True,
            url_for_open=req.url,
            llm=build_llm(),
        )

        # Best-effort final screenshot as visual evidence (the session stays
        # alive until close_session below).
        shot_b64: Optional[str] = None
        try:
            shot = screenshot(session)
            raw = shot.get("raw") if isinstance(shot, dict) else None
            if isinstance(raw, (bytes, bytearray)):
                shot_b64 = base64.b64encode(bytes(raw)).decode("ascii")
        except Exception:
            pass

        data = result.get("data", {}) if isinstance(result, dict) else {}
        return {
            "ok": result.get("ok"),
            "is_successful": data.get("is_successful"),
            "verdict": result.get("message"),          # agent's final report (VERDICT/WORKS/ISSUES/DESIGN)
            "action_trace": data.get("action_trace"),  # per-step actions + errors
            "final_url": data.get("url"),
            "title": data.get("title"),
            "screenshot_b64": shot_b64,
        }
    finally:
        try:
            close_session(session)
        except Exception:
            pass
