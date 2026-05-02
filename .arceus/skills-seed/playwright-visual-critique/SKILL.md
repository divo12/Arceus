---
name: playwright-visual-critique
description: Live UI review using playwright-mcp — screenshot + accessibility snapshot the preview, then produce structured design critique backed by evidence.
role: ui
trigger: reviewing a built frontend feature, critiquing a dev's implementation against design spec, or running ui-accessibility-check on a live preview
---

# Playwright Visual Critique

Design critique must be grounded in what actually shipped, not a Figma mockup. This skill is how the UI designer inspects a live preview using playwright-mcp browser tools and produces critique that developers can act on.

## When this fires

- Reviewing a developer's implementation of a UI task
- Running a design consistency check against a live preview
- Paired with `ui-accessibility-check` — first capture state, then walk the checklist
- Producing a design feedback artifact before sprint gate

Not this skill when: reviewing design specs in Figma/artifacts only (no live preview), or pure copy/content review.

## Playwright-mcp tools for design review

| Tool | What you use it for |
|---|---|
| `browser_navigate` | Open the feature at its preview URL |
| `browser_screenshot` | Capture visual state — the primary design evidence tool |
| `browser_snapshot` | Accessibility tree — verify semantic structure and labels |
| `browser_click` | Trigger hover states, open dropdowns, expand accordions |
| `browser_type` | Fill forms to see validation states, focused styles |
| `browser_wait_for` | Wait for animations to settle before screenshotting |
| `browser_console_messages` | Check for layout errors or missing assets logged to console |
| `browser_network_requests` | Verify fonts, images, and icons loaded (no 404s) |

## The visual critique loop

```
1. Navigate to the feature
   browser_navigate({ url: previewUrl })

2. Capture the landing state
   browser_screenshot()   ← hero screenshot for the artifact
   browser_snapshot()     ← accessibility tree for semantic audit

3. Walk the interaction states — for each key state:
   a. Trigger it (click, hover, type)
   b. browser_wait_for({ timeout: 500 }) to let transitions settle
   c. browser_screenshot() to capture
   d. Note the visual finding: spacing, color, hierarchy, motion

4. Run the accessibility layer (ui-accessibility-check)
   Use browser_snapshot to verify:
   - Heading hierarchy (h1 → h2 → h3)
   - Button labels (role: "button", name: not empty)
   - Input-label pairs
   - Alt text presence on images

5. Check asset health
   browser_network_requests() — any 404s on fonts, icons, images?

6. Produce the critique artifact
   artifact_create({
     kind: "spec",
     title: "<feature> design critique",
     content: structured findings below
   })
```

## Critique artifact structure

Produce findings in this format — specific, actionable, prioritized:

```
## Design Critique: <Feature Name>
Reviewed at: <preview URL>
Screenshots: [attached artifact IDs]

### P1 — Must Fix Before Merge
- [ ] <finding>: <what's wrong> → <fix>
  Evidence: screenshot-id or snapshot excerpt

### P2 — Should Fix This Sprint
- [ ] <finding>: <what's wrong> → <fix>

### P3 — Backlog
- [ ] <finding>: <what's wrong> → <fix>

### Passes
- ✓ <what looks correct>
```

## What to look for

**Spacing and layout**
- Does padding/margin match the design system? (check Tailwind class usage in DOM via snapshot)
- Is the grid consistent? No orphaned elements floating outside the layout?

**Typography hierarchy**
- Is there a clear h1? Do sub-headings descend logically?
- Font sizes consistent with the scale? No rogue inline sizes?

**Color and contrast**
- Primary actions visually prominent vs. secondary?
- Error and success states use semantic color (not just red/green)?

**Interactive states**
- Hover, active, focused states present and distinct?
- Loading states designed (skeleton, spinner) or blank?
- Empty states handled (no data shown gracefully)?

**Motion**
- Transitions smooth and purposeful, not jarring?
- Respect prefers-reduced-motion where possible?

**Mobile / responsive**
- Resize the viewport via `browser_navigate` with a narrow URL or use screenshot at different widths

## Heuristics

- **Screenshot after every interaction, not just on load.** The loaded state is the easiest to get right. Hover and error states are where polish breaks.
- **Use the snapshot to verify the semantic structure, not just to read content.** A div that looks like a button is a design bug.
- **Critique the empty state.** Developers often style the happy path; the zero-data state is almost always unstyled.
- **Link every finding to evidence.** "Spacing looks off" is not actionable. "Header has 8px padding but design system uses 16px — see screenshot-2" is.
- **Separate P1 (blocking) from P2 (nice to have).** Not everything needs to block the sprint.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Critique too vague to act on | No screenshot evidence, no specifics | Always attach screenshot ID to each finding |
| All states look fine on first load | Only checked the landing state | Walk hover, error, empty, loading states explicitly |
| Missing a11y issues | Skipped accessibility tree check | Always run browser_snapshot; pair with ui-accessibility-check |
| Dev disputes the finding | No reproducible step | Include the interaction steps in the critique ("click button X, see...") |

## Anti-patterns

- **"Looks good overall."** That's not a critique artifact — that's an approval. Document what's correct too, but always produce structured findings.
- **Critiquing the mockup, not the live preview.** The mockup doesn't ship. Always use browser tools on the actual built UI.
- **Skipping interaction states.** The loaded state is the easy part. Focus energy on hover, focus, error, and empty.
- **Reporting design issues without priority.** P1/P2/P3 classification is the designer's job. Don't leave the dev to guess what needs fixing.
