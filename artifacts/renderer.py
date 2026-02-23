"""Render markdown artifacts from structured input."""

from __future__ import annotations

from datetime import datetime, timezone


def render_decision_record(payload: dict) -> str:
    """Render a Decision Record from structured input."""
    now = datetime.now(timezone.utc)
    dec_id = payload.get("id") or f"DEC-{now.strftime('%Y%m%d')}-001"
    title = payload.get("title", "Untitled Decision")
    owner = payload.get("owner", "")
    status = payload.get("status", "Proposed")
    context = payload.get("context", "")
    decision = payload.get("decision", "")
    alternatives = payload.get("alternatives", [])
    rationale = payload.get("rationale", "")
    risks = payload.get("risks", [])
    metrics = payload.get("metrics", {})
    revisit_triggers = payload.get("revisit_triggers", [])

    lines = [
        f"# Decision Record: {title}",
        "",
        f"**ID:** {dec_id}",
        f"**Date:** {now.strftime('%Y-%m-%d')}",
        f"**Owner:** {owner}",
        f"**Status:** {status}",
        "",
        "## Context",
        "",
        context or "[To be filled]",
        "",
        "## Decision",
        "",
        decision or "[To be filled]",
        "",
        "## Alternatives considered",
        "",
        "| Option | Why not chosen |",
        "|--------|----------------|",
    ]
    for alt in alternatives:
        opt = alt.get("option", alt) if isinstance(alt, dict) else alt
        reason = alt.get("reason", "") if isinstance(alt, dict) else ""
        lines.append(f"| {opt} | {reason} |")
    lines.extend(["", "## Rationale", "", rationale or "[To be filled]", "", "## Risks", ""])
    for r in risks:
        if isinstance(r, dict):
            lines.append(f"- **{r.get('risk', r)}**: {r.get('mitigation', '')}")
        else:
            lines.append(f"- {r}")
    lines.extend(["", "## Metrics", ""])
    if isinstance(metrics, dict):
        primary = metrics.get("primary", "")
        guardrails = metrics.get("guardrails", "")
        if primary:
            lines.append(f"- **Primary:** {primary}")
        if guardrails:
            lines.append(f"- **Guardrails:** {guardrails}")
    else:
        lines.append(str(metrics) or "[To be filled]")
    lines.extend(["", "## Revisit triggers", "", "**What new evidence would change this decision?**", ""])
    for t in revisit_triggers:
        trigger = t.get("trigger", t) if isinstance(t, dict) else t
        lines.append(f"- [ ] {trigger}")
    if not revisit_triggers:
        lines.append("- [ ] [To be filled]")
    return "\n".join(lines) + "\n"


def render_evidence_brief(payload: dict) -> str:
    """Render an Evidence Brief from structured input."""
    now = datetime.now(timezone.utc)
    topic = payload.get("topic", "Untitled Brief")
    scope = payload.get("scope", "")
    findings = payload.get("findings", [])
    coverage = payload.get("coverage", {})
    contradictions = payload.get("contradictions", [])
    open_questions = payload.get("open_questions", [])
    recommendation = payload.get("recommendation", "")

    lines = [
        f"# Evidence Brief: {topic}",
        "",
        f"**Date:** {now.strftime('%Y-%m-%d')}",
        f"**Scope:** {scope}",
        "",
        "## What we know",
        "",
        "| Finding | Sources | Confidence |",
        "|---------|---------|------------|",
    ]
    for f in findings:
        if isinstance(f, dict):
            finding = f.get("finding", "")
            sources = f.get("sources", "")
            conf = f.get("confidence", "Medium")
        else:
            finding, sources, conf = str(f), "", "Medium"
        lines.append(f"| {finding} | {sources} | {conf} |")
    if not findings:
        lines.append("| [To be filled] | | |")
    lines.extend(["", "## Coverage", ""])
    if isinstance(coverage, dict):
        for k, v in coverage.items():
            lines.append(f"- **{k}:** {v}")
    else:
        lines.append(str(coverage) or "[To be filled]")
    lines.extend(["", "## Contradictions", ""])
    for c in contradictions:
        lines.append(f"- {c}")
    if not contradictions:
        lines.append("[None identified]")
    lines.extend(["", "## Open questions", "", "**What would change our decision if we knew?**", ""])
    for q in open_questions:
        question = q.get("question", q) if isinstance(q, dict) else q
        lines.append(f"- [ ] {question}")
    lines.extend(["", "## Recommendation", "", recommendation or "[To be filled]"])
    return "\n".join(lines) + "\n"


def render_options_set(payload: dict) -> str:
    """Render an Options Set from structured input."""
    title = payload.get("title", "Untitled Options Set")
    context = payload.get("context", "")
    options = payload.get("options", [])
    matrix = payload.get("tradeoff_matrix", {})
    recommendation = payload.get("recommendation", "")

    lines = [
        f"# Options Set: {title}",
        "",
        f"**Context:** {context}",
        "",
        "## Options",
        "",
    ]
    for i, opt in enumerate(options):
        if isinstance(opt, dict):
            name = opt.get("name", f"Option {i+1}")
            summary = opt.get("summary", "")
            constraints = opt.get("constraints", "")
            tradeoffs = opt.get("tradeoffs", "")
            effects = opt.get("second_order_effects", "")
        else:
            name, summary, constraints, tradeoffs, effects = str(opt), "", "", "", ""
        lines.extend([
            f"### {name}",
            f"- **Summary:** {summary}",
            f"- **Constraints:** {constraints}",
            f"- **Tradeoffs:** {tradeoffs}",
            f"- **Second-order effects:** {effects}",
            "",
        ])
    lines.extend(["## Tradeoff matrix", ""])
    if isinstance(matrix, dict) and matrix:
        dims = matrix.get("dimensions", [])
        rows = matrix.get("rows", {})
        if dims:
            header = "| Dimension | " + " | ".join(dims) + " |"
            lines.append(header)
            lines.append("|" + "---|" * (len(dims) + 1))
            for dim, vals in rows.items():
                if isinstance(vals, dict):
                    vals = [vals.get(dim, "") for dim in dims]
                lines.append(f"| {dim} | " + " | ".join(str(v) for v in vals) + " |")
    else:
        lines.append("| Dimension | Option A | Option B | Option C |")
        lines.append("|-----------|----------|----------|----------|")
        lines.append("| Value | | | |")
        lines.append("| Effort | | | |")
        lines.append("| Risk | | | |")
    lines.extend(["", "## Recommendation", "", recommendation or "[Requires Decision Record.]"])
    return "\n".join(lines) + "\n"
