---
name: ui-design-system-library
description: God-tier design source. The workspace ships 58 real brand design systems (Linear, Vercel, Apple, Stripe, Raycast, Notion, Figma, Airbnb, Supabase, …) as full DESIGN.md specs at /workspace/.design-systems/<brand>/DESIGN.md. Pick the one closest to the product, then adapt it into /workspace/DESIGN.md so the developer builds god-tier UI, not generic shadcn. Use this INSTEAD of inventing a palette or picking the old slide-deck theme catalog.
role: ui_designer
trigger: establishing aesthetic direction for ANY product or screen — before writing tokens or prototypes. This replaces ui-theme-catalog for web products.
---

# Design System Library (god-tier reference)

Generic-looking output is a failure. The fix is not "pick nicer colors" — it's to
stand on a complete, world-class design *system*. The workspace ships 58 of them.

## Workflow (every design task)

1. **Read the index:** `read({path: "/workspace/.design-systems/_INDEX.md"})` — 58 brands,
   each with its atmosphere one-liner.
2. **Pick the closest match** to the product's domain + emotional tone. Examples:
   - Dev tool / precise / dark → **linear.app**, **vercel**, **warp**, **clickhouse**, **cursor**
   - AI / infra / confident → **cohere**, **mistral.ai**, **together.ai**, **claude**, **minimax**
   - Consumer / warm / photographic → **airbnb**, **spotify**, **pinterest**, **revolut**
   - Fintech / trust → **stripe**, **coinbase**, **wise**, **kraken**
   - Docs / editorial / calm → **notion**, **mintlify**, **sanity**, **resend**
   - Bold / premium / dramatic → **apple**, **tesla**, **spacex**, **ferrari**, **lamborghini**
   - Playful / crafted → **clay**, **framer**, **raycast**, **figma**
   Pick ONE. Do not blend two systems.
3. **Read the full spec:** `read({path: "/workspace/.design-systems/<brand>/DESIGN.md"})`.
   It has the exact palette + hex, typography hierarchy (font, weights, letter-spacing,
   scale), component states, layout/spacing, depth/elevation, do's & don'ts, responsive.
4. **Adapt — don't copy blindly.** `write({path: "/workspace/DESIGN.md", content: ...})`:
   keep the *craft* (type scale, weight choices, negative letter-spacing at display sizes,
   the depth/shadow system, border treatment, motion, component states) but re-skin to the
   product's name/brand hue. This `/workspace/DESIGN.md` is the contract the developer
   implements against — it must be concrete (hex, px, weights), not adjectives.
5. Derive `tokens.yaml` (the existing `ui-design-token-doc` shape) FROM your DESIGN.md so
   the developer can wire `tailwind.config.js` + CSS vars directly.

## The bar (carry into your DESIGN.md — the developer is held to these too)

- **Real web font**, loaded — Inter / Geist / Satoshi / a system the reference uses. NEVER
  the bare system default. A deliberate type scale; negative letter-spacing on large headings.
- **Layered depth** — multi-stop shadows / considered borders / surface hierarchy. Not one
  flat `shadow-sm` on white cards.
- **Purposeful motion** — transitions on interactive elements + ≥1 real micro-interaction.
  Honor `prefers-reduced-motion`.
- **Every interactive element**: hover / focus-visible / active / disabled states defined.
- **Real states**: empty, loading (skeleton — not the word "Loading…"), error.
- **A deliberate dark mode** (the reference shows how) — not an auto-inverted afterthought.
- **A signature element** — the one memorable thing (hero treatment, gradient mesh,
  distinctive nav/sidebar, mono-label accents) that makes it look intentional, not template.

## `/workspace/.design-systems/` is reference-only

It's gitignored and never shipped in the product. Read from it; never import it into `src/`.
Your output is `/workspace/DESIGN.md` + tokens — those are what the developer consumes.

## Anti-patterns

- Picking a palette from the old `ui-theme-catalog` (slide-deck colors + presentation fonts) for a web product. Use this library instead.
- Writing a DESIGN.md of adjectives ("modern, clean") with no hex/px/weights. The developer can't implement vibes.
- Defaulting to plain shadcn tokens. shadcn is the component scaffold; the *aesthetic* comes from your adapted DESIGN.md.
