---
name: qa-bug-report-writing
description: Structured bug report with repro, expected/actual, severity, evidence. Replaces free-form bug filing.
role: qa
trigger: about to call task_report_bug after finding an issue; filing a verification failure; handing off a defect to dev
---

# Bug Report Writing

A good bug report is a repro recipe the developer can execute without asking you questions. A bad one is a description that leads to 3 round-trips.

## When this fires

- About to call `task_report_bug` after finding a defect
- A verification test failed and you need to file the finding
- Exploratory testing turned up unexpected behavior
- Handing off a regression to dev via `memory_handoff`

Not this skill when: the bug is obvious and one-line (typo, wrong icon). Just file with description; skip the ceremony.

## The mandatory fields

Every bug report has all of these. Missing any = not actionable.

### 1. Title (1 line, imperative or descriptive)

- Bad: "Bug on checkout"
- Bad: "It's broken"
- Good: "Checkout submit button inactive when Apply Coupon is clicked first"

Rule: someone scanning a list of 20 bugs knows what this one is about from the title alone.

### 2. Environment

Which build / branch / deploy does this apply to?

```
Environment:
  - Branch: main
  - Commit SHA: abc123
  - Preview URL: <url>
  - Browser: Chrome 118 (if browser-specific)
  - User role / account: <if auth-specific>
```

### 3. Repro steps

Numbered, minimal, exact. The dev should be able to follow them without interpretation.

```
1. Go to /checkout with items in cart
2. Click "Apply Coupon"
3. Enter valid coupon code SAVE10, click Apply
4. Note coupon applied successfully
5. Click Submit button
```

Rules:
- Include starting state (which page, what data)
- Numbered steps, one action per step
- End at the moment the bug manifests

### 4. Expected behavior

What should happen, referenced to the AC:

> Expected: Submit button remains active after coupon applied. AC2 states "Users can apply coupon and proceed to submit in the same session."

### 5. Actual behavior

What actually happens:

> Actual: Submit button becomes inactive (grayed, non-clickable) immediately after coupon application. No error message shown.

### 6. Severity

Pick one:

| Severity | Definition | Example |
|---|---|---|
| **Blocker** | Can't ship without fixing; blocks a primary flow | Login broken; payments fail |
| **Critical** | Major functionality broken; workaround exists but bad | Checkout works but tax wrong for some users |
| **Major** | Feature partially broken or edge case fails | Search misses results for unicode queries |
| **Minor** | Cosmetic or rare edge | Button style slightly off; empty state message wrong |
| **Trivial** | Typo, polish | "occuring" → "occurring" |

Severity drives prioritization. Over-inflating = crying wolf; under-inflating = real bugs get deprioritized.

### 7. Evidence

Attach artifacts:

- `workspace_capture_browser_probe` screenshot + console log at the moment of failure
- Network trace if API involved
- Video recording if timing-dependent
- `workspace_collect_evidence({probeArtifactIds, testOutputArtifactIds})` → one bundle ID

Reference via `task_report_bug({evidenceArtifactIds: [...]})`.

### 8. Notes (optional but valuable)

- Hypothesis: "Might be related to <other task> that merged recently"
- Scope: "Only reproduces in Chrome, not Safari"
- Related: "Possibly same root cause as bug #X"

## The emit

```
task_report_bug({
  title: "<descriptive title>",
  description: "<environment + repro + expected + actual + severity + notes>",
  severity: "<level>",
  evidenceArtifactIds: [<capture bundle>],
  relatedTaskIds: [<original implementation task>]
})
```

## Heuristics

- **Minimal repro is a gift to the dev.** Trim steps until the bug disappears, then add back the one that brings it back.
- **Expected + Actual is non-negotiable.** Without both, dev guesses what "wrong" means.
- **Include evidence even when it feels redundant.** Text descriptions drift; screenshots don't.
- **Sort severity by product impact, not by personal annoyance.** A cosmetic bug you hate is still Minor.
- **Related bugs: link them.** "Probably same cause as #42" saves dev investigation time.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Dev asks "can you reproduce" | Repro steps missing starting state | Include "go to X with Y data" as step 1 |
| Dev closes as "works for me" | Missing environment info | Always include branch + commit SHA + browser |
| Severity dispute | Over- or under-inflated | Use the table; map impact to severity, not emotion |
| Evidence missing → dev can't tell if UI or API issue | Skipped capture bundle | Capture + collect evidence is mandatory |

## Anti-patterns

- **"It's broken."** Non-actionable. Title must describe the specific break.
- **Paragraph-form repro.** "I went to the page and clicked some things." Numbered steps, always.
- **Attaching 10 screenshots without explanation.** Pick 2-3 that show the key moment; label them.
- **Severity: Blocker on everything.** Devalues the label. Use Blocker only when shipping stops.
- **Filing without checking for duplicates.** Search existing bugs for similar patterns before filing.
