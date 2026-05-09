---
name: ui-design-token-doc
description: YAML template for the Design Token Doc — the single artifact developers import to wire colors, type, spacing, radius, shadow, and motion into Tailwind config or CSS vars.
role: ui_designer
trigger: producing the first artifact for a new product or brand refresh; after picking a theme via ui-theme-catalog; when the dev asks "what tokens am I using?"
---

# Design Token Doc

The Design Token Doc is the highest-leverage artifact you produce. It's what the developer imports to set up Tailwind config or CSS variables. Get it right once; every screen inherits from it.

## Template (fill ALL fields with concrete values)

```yaml
THEME: [Theme Name from ui-theme-catalog OR custom name + 1-line tone description]

Typography:
  Font family:
    Display/H1:  [Font name]               # e.g. "Inter Display", "DejaVu Sans"
    Body:        [Font name]
    Mono/Code:   [Font name]               # optional; "JetBrains Mono" or system mono
  Scale:                                   # px values, mobile-first
    Display:  36px / 40px line-height / weight 700
    H1:       30px / 36px / 700
    H2:       24px / 32px / 600
    H3:       20px / 28px / 600
    Body:     16px / 24px / 400
    Small:    14px / 20px / 400
    Tiny:     12px / 16px / 400

Colors:
  --color-primary:    #______   # brand, CTAs, primary actions
  --color-secondary:  #______   # supporting accent
  --color-bg:         #______   # page background
  --color-surface:    #______   # card / panel / modal background
  --color-text:       #______   # primary text on bg
  --color-muted:      #______   # secondary text, captions
  --color-accent:     #______   # highlight, hover, focus rings
  --color-border:     #______   # default border / divider color
  --color-success:    #10B981   # green, can override
  --color-warning:    #F59E0B   # amber, can override
  --color-error:      #EF4444   # red, can override
  --color-info:       #3B82F6   # blue, can override

Spacing:                          # 4-or-8 grid; pick one and stick to it
  unit: 4px                       # base
  scale: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96]

Border Radius:
  --radius-tight:    4px          # tight chips, small inputs
  --radius-balanced: 8px          # default for buttons, cards
  --radius-soft:     16px         # large cards, hero panels
  --radius-pill:     9999px       # pills, avatars

Shadow:
  --shadow-small:    0 1px 3px rgba(0,0,0,0.12)
  --shadow-medium:   0 4px 6px rgba(0,0,0,0.16)
  --shadow-large:    0 10px 20px rgba(0,0,0,0.20)
  style: [flat | subtle | elevated | dramatic]   # pick one

Motion:
  duration:
    instant: 80ms
    fast:    180ms                # default for hover/press
    medium:  300ms                # default for transitions
    slow:    600ms                # large layout shifts only
  easing:
    standard: cubic-bezier(0.4, 0, 0.2, 1)        # most transitions
    spring:   cubic-bezier(0.34, 1.56, 0.64, 1)   # delights, bouncy
    sharp:    cubic-bezier(0.4, 0, 1, 1)          # exits
  feel: [snappy | smooth | springy | minimal]     # pick one

Breakpoints:
  mobile:   <640px       # base styles
  tablet:    640–1024px  # md:
  desktop:  >1024px      # lg:
  wide:     >1440px      # xl: (optional)

Dark Mode:
  enabled: [true | false]
  strategy: [media-query | class-based]
  notes: [any color flips beyond bg/text inversion]

Accessibility:
  contrast verified: [yes — list combinations checked, e.g. text-on-bg, primary-on-bg]
  focus ring: [color + width + offset, e.g. "2px solid var(--color-accent), offset 2px"]
  reduced-motion: [respect prefers-reduced-motion: yes]
```

## Filled example (using Arctic Frost theme)

```yaml
THEME: Arctic Frost (calm + trustworthy, healthcare/professional)

Typography:
  Font family:
    Display/H1:  DejaVu Sans
    Body:        DejaVu Sans
    Mono/Code:   JetBrains Mono
  Scale:
    Display:  36px / 40px / 700
    H1:       30px / 36px / 700
    H2:       24px / 32px / 600
    H3:       20px / 28px / 600
    Body:     16px / 24px / 400
    Small:    14px / 20px / 400
    Tiny:     12px / 16px / 400

Colors:
  --color-primary:    #4a6fa5   # Steel Blue
  --color-secondary:  #d4e4f7   # Ice Blue
  --color-bg:         #fafafa   # White
  --color-surface:    #ffffff
  --color-text:       #1a2332
  --color-muted:      #5a6b7d
  --color-accent:     #6b8fc4
  --color-border:     #c0c0c0   # Silver
  --color-success:    #10B981
  --color-warning:    #F59E0B
  --color-error:      #EF4444
  --color-info:       #4a6fa5

Spacing:
  unit: 4px
  scale: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96]

Border Radius:
  --radius-tight:    4px
  --radius-balanced: 8px
  --radius-soft:     16px
  --radius-pill:     9999px

Shadow:
  --shadow-small:    0 1px 3px rgba(15,23,42,0.08)
  --shadow-medium:   0 4px 12px rgba(15,23,42,0.10)
  --shadow-large:    0 18px 40px rgba(15,23,42,0.12)
  style: subtle

Motion:
  duration: { instant: 80ms, fast: 180ms, medium: 300ms, slow: 600ms }
  easing:
    standard: cubic-bezier(0.4, 0, 0.2, 1)
    spring:   cubic-bezier(0.34, 1.56, 0.64, 1)
    sharp:    cubic-bezier(0.4, 0, 1, 1)
  feel: smooth

Breakpoints:
  mobile:   <640px
  tablet:    640–1024px
  desktop:  >1024px

Dark Mode:
  enabled: true
  strategy: class-based
  notes: bg flips to #1a2332, surface to #2a3340, text inverts to #fafafa

Accessibility:
  contrast verified: yes — primary-on-bg 7.2:1, text-on-bg 12.6:1, muted-on-bg 5.4:1
  focus ring: 2px solid var(--color-accent), offset 2px
  reduced-motion: respect prefers-reduced-motion
```

## Output

Place the filled YAML in your spec artifact under section **2. Design Tokens**. Optionally `write` it to `/workspace/design/tokens.yaml` so the developer can import it directly. The artifact is the source of truth; the file is convenience.

## Common mistakes

- Leaving `#______` placeholders. The developer will use random values.
- Using Tailwind class names (`text-blue-500`) instead of hex. Tailwind config NEEDS the hex.
- Defining only light-mode colors when the spec mentions dark mode. Dark mode is a parallel set of values, not "the dev figures it out."
- Picking shadow opacity 0.5+ for "elevated" — looks heavy. Subtle shadows (0.08–0.16) read more modern.
- Skipping accessibility verification. Run ui-accessibility-check before publishing.
