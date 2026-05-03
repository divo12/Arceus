---
name: ui-accessibility-check
description: WCAG-based checkpoint list for every UI spec or component. Accessibility is first-class, not afterthought.
role: ui
trigger: completing a design spec, before handing off to dev via design-to-dev-handoff, or reviewing an existing component for a11y
---

# Accessibility Check

Accessibility is design quality. If your UI works for someone using a screen reader or keyboard, it works for everyone — the reverse isn't true. Catch issues in design, not in post-launch audit.

## When this fires

- Finalizing a design spec artifact
- Before calling `task_complete` on a design task
- Design-to-dev handoff (pair with `design-to-dev-handoff`)
- Reviewing a component an agent flagged for UX review

Not this skill when: non-user-facing admin tools used once by engineering, or pure API work with no UI.

## The seven-point checklist

Every UI screen / component / flow must pass all seven.

### 1. Color contrast

Foreground-background contrast ratios (WCAG AA):
- Normal text (≤ 18pt): ≥ 4.5:1
- Large text (≥ 18pt or 14pt bold): ≥ 3:1
- Icons / UI components: ≥ 3:1

Tools: Figma contrast plugin; WebAIM contrast checker.

Red flags: light gray on white "secondary text," placeholder text illegible, error red that fails contrast.

### 2. Keyboard navigation

Every interactive element must be reachable and operable via keyboard:

- Tab order follows visual reading order (top-to-bottom, left-to-right)
- Focus visible: every focusable element has a clearly visible focus indicator (not just browser default — especially if styles removed outline)
- No keyboard traps: user can always Tab out
- Modals: focus moves into modal on open; returns to trigger on close
- Esc closes modals / dismisses overlays

### 3. Semantic HTML / ARIA

- Use `<button>` for buttons, not `<div onClick>`. Native semantics for free.
- Headings (`<h1>`, `<h2>`) create a logical outline — screen-reader users navigate by heading
- Form inputs: every `<input>` has an associated `<label>`
- Icon-only buttons: `aria-label="Close dialog"` or equivalent
- Decorative images: `alt=""` (empty); meaningful images: descriptive alt

Don't over-ARIA: native HTML first; ARIA only when semantics aren't available.

### 4. Text alternatives

- Images: meaningful alt text (not "image of..." — just describe)
- Icons: screen-reader text or aria-label
- Video: captions, transcripts
- Charts: table or text alternative below

Rule: close your eyes, hear the page via a screen reader — does it make sense?

### 5. Forms + errors

- Every input labeled
- Required fields marked (not just asterisk color — use text or aria-required)
- Errors identified: which field? what's wrong? how to fix?
- Errors announced: `aria-live` or screen-reader-focused error summary
- Don't rely on color alone (red border) — include icon or text

### 6. Motion + animation

- Respect `prefers-reduced-motion` — disable parallax, autoplay, aggressive animations
- No flashing > 3 Hz (seizure risk)
- Autoplay carousels: pausable; don't rotate faster than 5s without user control
- Loading animations: have text equivalent ("Loading…") for screen readers

### 7. Responsive + zoom

- Works at 200% browser zoom without horizontal scroll
- Works in narrow viewports (mobile) without hidden content
- Text reflows when resized; no overflow cut-off
- Touch targets ≥ 44×44px on mobile

## The loop

```
1. Walk each of the 7 points against the design
2. Note violations + proposed fix in the spec
3. For each violation flagged:
   - Update the design (if cheap)
   - OR document as "known limitation; dev to mitigate at implementation"
4. Include the a11y notes in the design spec artifact:
   artifact_create({
     kind: "spec",
     title: "<feature> design spec",
     content: "<design notes + a11y checklist result>"
   })
5. Hand off to dev via design-to-dev-handoff; include a11y checklist result explicitly
```

## Heuristics

- **Fix in design, not in code.** A color-contrast violation caught at design = 5-minute swap; caught in QA = full re-spec.
- **Test with a real screen reader.** VoiceOver on Mac (Cmd+F5), NVDA on Windows. 10 minutes reveals issues no tool catches.
- **Keyboard-first design.** If it works via keyboard, it usually works via mouse. Reverse isn't true.
- **Don't trust designers' "accessible" claims without verification.** Including your own. Run the checklist.
- **Native > custom.** Stock `<select>`, `<input type="date">`, etc. have free a11y; custom implementations often break.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "Accessibility audit caught X issues" post-launch | Didn't run checklist during design | Make checklist a gate on design-task completion |
| Devs add a11y attributes wrong (incorrect aria-label, wrong role) | Handoff didn't specify | Spec explicit ARIA requirements when non-obvious |
| Keyboard users report frustration | Focus order wrong or traps exist | Design the tab order explicitly; don't leave it to implementation |
| Screen reader unusable | Over-reliance on ARIA / divs everywhere | Use semantic HTML first |

## Anti-patterns

- **"We'll add a11y later."** Later = never. Design it in from the start.
- **`div onClick={...}`** instead of `<button>`. Breaks keyboard, screen reader, focus.
- **Removing focus outline without replacing it.** Invisible focus = unusable keyboard nav.
- **Color as the only indicator.** Red border without icon = invisible to colorblind users.
- **"Accessible if you configure your browser correctly."** That's not accessible.
- **ARIA as a fix for bad HTML.** If you need 10 ARIA attributes, rewrite the HTML.
