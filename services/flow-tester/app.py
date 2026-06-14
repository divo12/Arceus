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

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from browseruse_session import run_agent_task, screenshot, close_session

app = FastAPI(title="Arceus Flow-Tester")

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
    "When done, finish your final answer in EXACTLY this shape:\n"
    "VERDICT: PASS or FAIL\n"
    "WORKS: <one line: does the core flow work end to end?>\n"
    "ISSUES: <numbered list of concrete broken/dead/missing things, or 'none'>\n"
    "DESIGN: <god-tier | acceptable | basic — plus one line why>"
)


class FlowTestRequest(BaseModel):
    url: str
    goal: Optional[str] = None
    max_steps: int = 25


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
    task = f"{req.goal}\n\n{DEFAULT_GOAL}" if req.goal else DEFAULT_GOAL

    try:
        result = run_agent_task(
            session,
            task,
            max_steps=max(5, min(req.max_steps, 40)),
            create_session_if_missing=True,
            url_for_open=req.url,
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
