---
name: ui-design-system-consistency
description: Check new UI against design-system tokens. Flag drift. Prevents ad-hoc colors, one-off spacing, component sprawl.
role: ui
trigger: creating new UI components or screens; adding a visual element that didn't exist before; reviewing a spec before handoff
---

# Design System Consistency

Design systems erode by paper cuts. One ad-hoc color here, one custom margin there — 6 months later the system has no single source of truth. This skill catches drift at creation time.

## When this fires

- Creating a new component or screen
- Adding a button, card, modal, or form element
- Adopting a pattern that doesn't yet exist in the system
- Reviewing a design spec before handoff to dev

Not this skill when: working on a one-off internal admin tool where design system doesn't apply. Still worth a brief check, but full enforcement isn't needed.

## The check (before the design ships)

### 1. Colors — did you use tokens?

- Every color used must be a design-system token (e.g. `--color-primary`, `--color-error`)
- Not a hex code (`#4A90E2`) unless the token doesn't exist
- If you need a new color → propose a token addition, don't just use a hex

### 2. Typography — did you use the scale?

- Every text element uses a defined type style (`body`, `caption`, `h1`, `h2`, `h3`)
- Not custom `font-size: 15.5px` unless justified and the system extends to include it
- Line-height, font-weight follow system scale

### 3. Spacing — did you use the grid?

- Margins + padding come from spacing tokens (`--spacing-4`, `--spacing-8`)
- Not arbitrary `margin-top: 17px`
- If the design needs a new spacing, either round to nearest token or propose addition

### 4. Components — did you reuse or reinvent?

Before creating a new component, check the system:

- Does it exist? (button, card, modal, input, toast, banner...)
- Does a near-match exist that could be extended?
- If reinventing: **don't**. Either use the existing, extend it, or propose an addition to the system.

### 5. Patterns — does this match established interaction?

- Modals behave like other modals (same dismiss, same focus)
- Forms follow same error placement
- Tables use same sorting/filtering affordances
- Deviation needs justification

## The loop

```
1. Draft the design
2. For each element:
   - Pull the color(s) used — all tokens?
   - Pull the text styles — all from the scale?
   - Pull the spacing — all from the grid?
   - Check component reuse — any reinventing?
3. For each drift found:
   - Fix (swap to token) OR
   - Justify + propose system addition via memory_handoff({targets: ["ui", "sl"], kind: "finding"})
4. Annotate the design spec:
   - Tokens used
   - New tokens proposed (if any)
   - Pattern deviations and why
5. Hand off via design-to-dev-handoff with explicit token references
```

## Proposing additions to the system

When a genuine new need emerges:

1. Document: what's the use case, what doesn't fit existing tokens?
2. Propose a specific addition: new color token, new spacing, new component variant
3. Handoff to SL or design lead for registry update
4. Don't ship the ad-hoc version before the system update lands — either wait or tag as temporary with a follow-up task

## Heuristics

- **The system exists because consistency compounds.** One-off decisions save 5 minutes now; cost hours later.
- **Extend > reinvent.** Adding a `variant: "danger"` to an existing button > creating a new DangerButton component.
- **The designer's job is to protect the system.** Dev will implement what they see in specs. If specs drift, system drifts.
- **Exceptions should be rare and logged.** Every intentional deviation is a memory entry explaining why.
- **System additions are first-class work.** If the project needs a new token/component, that's its own task, not a sidecar.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Designers use hex codes | No easy way to find tokens | Publish token reference; check in design tooling |
| Multiple "button" components in codebase | Each feature added their own | Consolidate; add variants to canonical component |
| Spacing visually inconsistent across screens | Ad-hoc margins | Enforce spacing tokens in design review |
| New pattern doesn't match existing similar one | Each designer invented independently | Pattern library; review cross-screen consistency |

## Anti-patterns

- **"This is a special case."** Most "special cases" aren't. Check the existing patterns before claiming.
- **Hex code with a comment "// close to primary."** Use primary. If primary's wrong for this case, propose a new token.
- **Copy-pasting component CSS and tweaking.** Creates parallel truths. Extend the component, or add variant.
- **Skipping the system check because "it's a prototype."** Prototypes get shipped. Check anyway.
- **Fighting the system on every screen.** If the system consistently doesn't fit, the system needs evolution — log it formally, don't drift silently.
