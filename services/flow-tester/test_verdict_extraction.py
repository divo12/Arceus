"""
Tests for the flow-tester verdict-recovery fix (2026-06-14).

Bug: a real flow-test run drove the product end-to-end and the agent reached a
verdict (VERDICT: FAIL …) at its final step, but the terminal `done` action hit a
transient `CDP client not initialized` drop, so `history.final_result()` was None
and the HTTP response came back with an empty verdict (`ok:false, verdict:""`).
At sprint finalize Arceus then saw an empty result and never parsed the verdict /
spawned a fix task. `_pick_verdict_message` recovers the verdict from the agent's
captured output even when the clean final_result is missing.

Run: python3 -m pytest services/flow-tester/test_verdict_extraction.py
(top-level imports of browseruse_session don't require browser_use — it's lazily
imported inside the browser functions.)
"""
from browseruse_session import _pick_verdict_message


def test_prefers_clean_final_result():
    assert _pick_verdict_message("VERDICT: PASS\nWORKS: yes", ["noise"]) == "VERDICT: PASS\nWORKS: yes"


def test_recovers_verdict_when_final_result_is_none():
    # The exact bug: done-action dropped, final_result None, but the verdict text
    # is in the captured candidates.
    candidates = [
        "Clicked Run now",
        "VERDICT: FAIL\nWORKS: create/run/view/search worked\nISSUES: 1. no edit/delete",
    ]
    out = _pick_verdict_message(None, candidates)
    assert out.startswith("VERDICT: FAIL")
    assert "no edit/delete" in out


def test_recovers_verdict_when_final_result_is_empty_string():
    assert _pick_verdict_message("", ["VERDICT: PASS"]) == "VERDICT: PASS"


def test_picks_the_most_recent_verdict_candidate():
    candidates = ["VERDICT: PASS (early)", "did stuff", "VERDICT: FAIL (final)"]
    assert _pick_verdict_message(None, candidates) == "VERDICT: FAIL (final)"


def test_falls_back_to_last_non_empty_when_no_verdict_marker():
    assert _pick_verdict_message(None, ["", "some observation", ""]) == "some observation"


def test_returns_empty_when_nothing_usable():
    assert _pick_verdict_message(None, ["", "   ", ""]) == ""
    assert _pick_verdict_message(None, []) == ""
