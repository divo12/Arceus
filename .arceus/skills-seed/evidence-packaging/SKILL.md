---
name: evidence-packaging
description: Attach the right evidence artifacts to task completions + approval requests. Make verification + review auditable.
role: all
trigger: about to call task_complete, task_verify, approval_request, or memory_handoff with findings that need proof
---

# Evidence Packaging

Every claim another role can't verify = a trust debt. Evidence closes the loop. This skill structures what to attach and how.

## When this fires

- About to `task_complete` a task with non-trivial outcomes
- About to `task_verify` after QA verification
- Filing an `approval_request` with an evidence requirement
- `memory_handoff` where the target role needs to act on your findings
- `task_report_bug` (pairs with `qa-bug-report-writing`)

Not this skill when: internal notes or trivial task completion (config change, typo fix). Don't over-evidence.

## The three evidence categories

Most tasks produce evidence in one or more of these shapes:

### 1. State snapshots

What the system looked like at a moment:
- Screenshots (from `workspace_capture_browser_probe`)
- DOM dumps
- Database query results
- `workspace_git_diff` output
- File tree snapshots (from `glob`)

### 2. Execution traces

What happened during an action:
- Test run output (`workspace_run_acceptance_suite` results)
- Console logs during a probe
- Network request/response pairs
- Build logs
- Command transcripts (from `bash` calls)

### 3. Derived analysis

What you concluded from the above:
- Pass/fail verdicts with reasoning
- Diffs between expected and actual
- Performance numbers + comparisons
- Security findings with severity

## The packaging loop

```
1. Identify what claim you're making:
   "I claim: <the outcome you're asserting>"

2. For that claim, what evidence type(s) support it?
   - Behavioral claim → state snapshots + traces
   - Performance claim → traces + derived analysis
   - Security claim → traces + analysis
   - Design claim → snapshots + analysis

3. Collect raw evidence:
   - workspace_capture_browser_probe for UI behavior
   - workspace_run_acceptance_suite for test results
   - bash("git diff") for code state
   - etc.

4. Bundle into a single evidence artifact:
   workspace_collect_evidence({
     taskId,
     probeArtifactIds: [<captures>],
     testOutputArtifactIds: [<test results>],
     summary: "<what this bundle proves>"
   })
   → returns evidenceArtifactId

5. Reference in the outbound call:
   task_complete({ taskId, evidenceArtifactIds: [<bundleId>] })
   task_verify({ taskId, evidenceArtifactIds: [<bundleId>] })
   approval_request({ ..., evidenceArtifactIds: [<bundleId>] })

6. In the claim text, reference the evidence:
   "Verified AC1-AC3 (see evidence bundle); edge case on AC4 failed, bug filed separately."
```

## What "sufficient evidence" looks like

For common task types:

| Task type | Minimum evidence |
|---|---|
| Implementation task done | Test run output (green); workspace_verify_baseline pass; code diff |
| QA verification pass | Probe captures for each AC; test suite output; edge-case coverage notes |
| Bug fix | Repro-before (showing bug), fix commit SHA, repro-after (showing fixed), regression test added |
| UI task done | Screenshots at key states; accessibility check result; design-system-consistency note |
| Design spec done | Design artifacts + a11y checklist result + design-system tokens used |
| Sprint final gate | QA gate result + final gate result + checklist outcomes |
| Approval request | Rationale + supporting artifacts + risk assessment |

## Heuristics

- **Capture before and after for change claims.** "I improved X" without before/after = not a claim, a hope.
- **One bundle per task.** Don't scatter evidence across 5 artifact IDs when one bundle would hold all.
- **Label bundles descriptively.** "sprint-5-qa-evidence" > "bundle-3"
- **Size matters, but completeness matters more.** 20 screenshots that prove the case > 3 screenshots that imply it.
- **Drop evidence for routine claims.** Config change deployed = git SHA is enough; don't bundle logs.
- **Evidence for negative claims is evidence of absence.** "No errors" = a capture showing clean console, not just "I didn't see any."

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Reviewer asks "how do I know this works?" | Claim without evidence | Attach evidence bundle even when "obvious" |
| Evidence bundle is disorganized | Scattered IDs, no summary | Use `workspace_collect_evidence` with summary |
| 30-screenshot dump | Over-evidence; nobody reads | Pick the minimal representative set |
| Evidence doesn't match the claim | Selected wrong evidence type | Match evidence type to claim shape |
| Audit trail broken post-sprint | Evidence artifacts not referenced | Always include `evidenceArtifactIds` in the calling tool |

## Anti-patterns

- **"Trust me, it works."** That's not evidence; that's an assertion.
- **Screenshots without labels.** "Here's 5 images." Which shows what?
- **Evidence after the fact.** Re-running tests to "generate evidence" post-completion is reconstruction, not evidence.
- **Evidence bundle for each sub-step of a task.** One bundle per task outcome; sub-step evidence rolls up into it.
- **Burying evidence in a wall of text.** Separate the claim ("AC1 passes") from the evidence (artifact ID).
