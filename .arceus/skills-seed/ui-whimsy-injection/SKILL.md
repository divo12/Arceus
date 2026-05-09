---
name: ui-whimsy-injection
description: Add purposeful delight to a completed UI — micro-interactions, playful copy, celebrate-worthy moments — without slowing the product down. Replaces flat, generic interfaces.
role: ui_designer
trigger: a UI feature is implemented and works but feels mundane; reviewing a flow before ship; designing empty/loading/success states
---

# Whimsy Injection

A boring app loses to a charming one even when the boring one is faster. Whimsy is the difference between "I'll use it" and "I'll show my friends." But it has to earn its place — every animation, every joke, every micro-interaction needs to serve the user, not the designer's ego.

## Where whimsy actually pays off

These moments deserve attention. Anywhere else, restraint is the better instinct.

1. **Onboarding** — first impression sets emotional tone. One distinctive animation or copy line beats ten polished-but-generic ones.
2. **Empty states** — instead of "No items yet," give a personality-filled prompt that explains what to do AND makes the user smile. "Your first note is one tap away" + a gentle hover prompt on the button.
3. **Loading states** — entertain instead of explain. Skeleton screens with subtle motion, rotating playful messages ("crunching pixels…", "convincing the database…"), pull-to-refresh micro-animation.
4. **Success moments** — first save, milestone reached, action completed: brief acknowledgement (subtle confetti, scale-bounce on the saved item, a check that draws itself).
5. **Error states** — turn frustration into goodwill. "We dropped that one. Mind trying again?" beats "Error 500." Helpful tone, never patronizing.
6. **CTAs** — buttons that beg to be pressed have personality in shape, hover, and label. "Save changes" → "Save these changes" or context-specific verbs.

## Anti-patterns

Skip these. They ruin the experience even when individually clever.

- **Animations that block input** — anything the user has to wait through twice is too long.
- **Jokes in critical paths** — payment confirmations, security warnings, destructive actions need clarity, not cleverness.
- **Mascots everywhere** — once or twice as a delight is fun; on every screen it becomes noise.
- **Sound effects without a mute** — instantly hostile.
- **Whimsy that excludes** — references that only land for specific cultures, ages, or insider groups.
- **One-time delight that fires every time** — the 100th time a user sees the confetti, it's annoying. Cap or vary.

## Implementation principles

- **CSS over JS** — `transform`, `opacity`, `transition` carry 90% of micro-interactions cheaper and smoother than JS animation libraries.
- **Respect `prefers-reduced-motion`** — skip non-essential animation when the user has motion sensitivity. Test it.
- **Animate in <250ms** — anything slower feels like the app is laggy, not playful.
- **Springy easing** — `cubic-bezier(0.34, 1.56, 0.64, 1)` for delights that should feel alive. Linear easing kills personality.
- **Limit on weight** — total motion should not push interaction past 16ms frame budget. Test on a low-end device.

## Concrete patterns to reuse

| Where | Pattern |
|---|---|
| Button press | `scale(0.97)` on `:active`, returns on release |
| Item created | Slide-in + brief glow, fade glow over 600ms |
| Toggle on | Spring scale to 1.05 then settle |
| Pull-to-refresh | Custom indicator (logo morph, spinning emoji) instead of generic |
| Empty list | Friendly illustration + 1-line CTA + one-line tip |
| Error toast | Approachable copy, undo affordance if possible |
| 404 | Don't apologize; give a way forward (search, home, sitemap) |

## Copy is half the whimsy

The visual gets attention, the words make people smile. Three rules:

1. Talk like a helpful friend, not a customer service script.
2. Acknowledge the user's emotion ("That was annoying. Try again?").
3. Use contractions and casual verbs unless the brand is explicitly formal.

Replace these phrases on sight:
- "An error occurred" → "Something broke on our side. Trying again usually works."
- "Are you sure?" → "Heads up — this can't be undone."
- "Loading…" → vary it: "Almost there", "Catching up", "Pulling the latest"
- "No results" → "Nothing matches that. Try fewer words?"

## Audit checklist

Run through the feature you're shipping:
- [ ] First-use moment has one distinctive detail
- [ ] Every list view has an empty state with copy + action
- [ ] Every loading >300ms has a skeleton or animated placeholder
- [ ] Every success has acknowledgement (visual or copy)
- [ ] Every error has a recovery path in the message
- [ ] Every CTA has hover + active states
- [ ] `prefers-reduced-motion` paths are tested
- [ ] No animation blocks input
- [ ] Total motion budget <16ms per frame on low-end mobile

If 7+ of these are present, you've earned the polish. If <5, the feature ships flat — fix before handing off.

## Output

`task_append_result` with the list of whimsy additions, where each lives in the code, and what user moment it serves.
