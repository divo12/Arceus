---
name: apple-design-system
description: Apple-inspired design system with cinematic layouts, SF Pro typography, binary light/dark sections, single accent color. Include design direction in your technical plan.
role: cto
---

# Apple Design System Inspiration

## When to use
Use this skill for any frontend web app that needs premium, polished visual design. Apply these principles to create interfaces with cinematic drama, controlled typography, and Apple-level visual quality.

## 1. Visual Theme & Atmosphere

Vast expanses of pure black and near-white serve as cinematic backdrops. The design is reductive: every pixel exists in service of the product, and the interface retreats until invisible.

**Key Characteristics:**
- SF Pro Display/Text with optical sizing — letterforms adapt automatically to size context
- Binary light/dark section rhythm: black (#000000) alternating with light gray (#f5f5f7)
- Single accent color: Apple Blue (#0071e3) reserved exclusively for interactive elements
- Product-as-hero imagery on solid color fields — no gradients, no textures, no distractions
- Extremely tight headline line-heights (1.07-1.14) creating compressed, billboard-like impact
- Full-width section layout with centered content — the viewport IS the canvas
- Pill-shaped CTAs (980px radius) creating soft, approachable action buttons
- Generous whitespace between sections allowing each moment to breathe

## 2. Color Palette & Roles

### Primary
- **Pure Black (#000000):** Hero section backgrounds, immersive showcases
- **Light Gray (#f5f5f7):** Alternate section backgrounds. Not white — the slight blue-gray tint prevents sterility
- **Near Black (#1d1d1f):** Primary text on light backgrounds

### Interactive
- **Apple Blue (#0071e3):** Primary CTA backgrounds, focus rings. The ONLY chromatic color
- **Link Blue (#0066cc):** Inline text links on light backgrounds
- **Bright Blue (#2997ff):** Links on dark backgrounds

### Text
- **White (#ffffff):** Text on dark backgrounds, button text on blue/dark CTAs
- **Near Black (#1d1d1f):** Primary body text on light backgrounds
- **Black 80% (rgba(0,0,0,0.8)):** Secondary text, nav items
- **Black 48% (rgba(0,0,0,0.48)):** Tertiary text, disabled states

### Dark Surfaces
- **Dark Surface 1 (#272729):** Card backgrounds in dark sections
- **Dark Surface 2 (#262628):** Subtle surface variation
- **Dark Surface 3 (#28282a):** Elevated cards on dark backgrounds

### Shadows
- **Card Shadow:** `rgba(0,0,0,0.22) 3px 5px 30px 0px` — soft, diffused, photographic

## 3. Typography Rules

### Font Family
- **Display (20px+):** SF Pro Display, Helvetica Neue, Helvetica, Arial, sans-serif
- **Body (<20px):** SF Pro Text, Helvetica Neue, Helvetica, Arial, sans-serif

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing |
|------|------|--------|-------------|----------------|
| Display Hero | 56px (3.50rem) | 600 | 1.07 | -0.28px |
| Section Heading | 40px (2.50rem) | 600 | 1.10 | normal |
| Tile Heading | 28px (1.75rem) | 400 | 1.14 | 0.196px |
| Card Title | 21px (1.31rem) | 700 | 1.19 | 0.231px |
| Sub-heading | 21px (1.31rem) | 400 | 1.19 | 0.231px |
| Body | 17px (1.06rem) | 400 | 1.47 | -0.374px |
| Body Emphasis | 17px (1.06rem) | 600 | 1.24 | -0.374px |
| Button Large | 18px (1.13rem) | 300 | 1.00 | normal |
| Button | 17px (1.06rem) | 400 | 2.41 | normal |
| Link | 14px (0.88rem) | 400 | 1.43 | -0.224px |
| Caption | 14px (0.88rem) | 400 | 1.29 | -0.224px |
| Micro | 12px (0.75rem) | 400 | 1.33 | -0.12px |

### Principles
- Weight restraint: scale spans 300-700 but most text lives at 400 and 600
- Negative tracking at ALL sizes: -0.28px at 56px, -0.374px at 17px, -0.224px at 14px
- Extreme line-height range: headlines compress to 1.07, body opens to 1.47

## 4. Component Stylings

### Buttons

**Primary Blue (CTA):**
- Background: #0071e3, Text: #ffffff, Padding: 8px 15px, Radius: 8px
- Font: 17px, weight 400
- Focus: 2px solid #0071e3 outline

**Primary Dark:**
- Background: #1d1d1f, Text: #ffffff, Padding: 8px 15px, Radius: 8px

**Pill Link (Learn More / Shop):**
- Background: transparent, Text: #0066cc (light) or #2997ff (dark)
- Radius: 980px (full pill), Border: 1px solid #0066cc
- Hover: underline decoration

**Filter / Search Button:**
- Background: #fafafc, Text: rgba(0,0,0,0.8), Radius: 11px
- Border: 3px solid rgba(0,0,0,0.04)

### Cards & Containers
- Background: #f5f5f7 (light) or #272729-#2a2a2d (dark)
- Border: none (borders are rare)
- Radius: 5px-8px
- Shadow: rgba(0,0,0,0.22) 3px 5px 30px 0px for elevated cards

### Navigation
- Background: rgba(0,0,0,0.8) with `backdrop-filter: saturate(180%) blur(20px)`
- Height: 48px, Text: #ffffff at 12px weight 400
- The nav floats above content with glass effect

## 5. Layout Principles

### Spacing
- Base unit: 8px
- Scale: 2, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 17, 20, 24px

### Grid
- Max content width: ~980px centered
- Full-viewport-width sections with centered content block
- Single-column for hero moments — one product, one message, full attention

### Whitespace
- Each section occupies near full-viewport height
- Alternating background colors (black, #f5f5f7) signal new "scenes"
- Text blocks tightly set, surrounding space vast

### Border Radius Scale
- Micro (5px): Small containers
- Standard (8px): Buttons, cards
- Comfortable (11px): Search inputs
- Large (12px): Feature panels
- Full Pill (980px): CTA links
- Circle (50%): Media controls

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | No shadow, solid background | Standard content |
| Nav Glass | `backdrop-filter: saturate(180%) blur(20px)` on rgba(0,0,0,0.8) | Sticky nav |
| Subtle Lift | rgba(0,0,0,0.22) 3px 5px 30px 0px | Product cards |
| Focus | 2px solid #0071e3 outline | Keyboard focus |

Shadow is RARE and always soft. Most elements have NO shadow — elevation comes from background color contrast.

## 7. Do's and Don'ts

### Do
- Use SF Pro Display at 20px+, SF Pro Text below 20px
- Apply negative letter-spacing at all text sizes
- Use Apple Blue (#0071e3) ONLY for interactive elements
- Alternate black and #f5f5f7 section backgrounds
- Use 980px pill radius for CTA links
- Keep imagery on solid-color fields
- Use translucent dark glass for sticky navigation
- Compress headline line-heights to 1.07-1.14

### Don't
- Don't introduce additional accent colors — entire chromatic budget is blue
- Don't use heavy shadows or multiple shadow layers
- Don't use borders on cards or containers
- Don't apply wide letter-spacing to SF Pro
- Don't use weight 800 or 900
- Don't add textures, patterns, or gradients to backgrounds
- Don't make the navigation opaque
- Don't center-align body text — only headlines center
- Don't use rounded corners larger than 12px on rectangular elements

## 8. Responsive Behavior

| Breakpoint | Width | Key Changes |
|------------|-------|-------------|
| Mobile | 360-480px | Single column, scaled typography |
| Tablet | 834-1024px | 2-column grids, expanded nav |
| Desktop | 1070-1440px | Full layout, max content width |
| Large Desktop | >1440px | Centered with generous margins |

- Hero headlines: 56px → 40px → 28px on mobile
- Product grids: 3-col → 2-col → single column
- Section backgrounds maintain full-width at ALL breakpoints

## 9. Quick Reference for Implementation

### CSS Variables
```css
:root {
  --apple-blue: #0071e3;
  --link-blue: #0066cc;
  --bright-blue: #2997ff;
  --bg-dark: #000000;
  --bg-light: #f5f5f7;
  --text-primary: #1d1d1f;
  --text-secondary: rgba(0, 0, 0, 0.8);
  --text-tertiary: rgba(0, 0, 0, 0.48);
  --card-shadow: rgba(0, 0, 0, 0.22) 3px 5px 30px 0px;
  --nav-bg: rgba(0, 0, 0, 0.8);
  --nav-blur: saturate(180%) blur(20px);
}
```

### Example Component Prompts
- Hero section: black bg, 56px weight 600, line-height 1.07, white text, two pill CTAs
- Product card: #f5f5f7 bg, 8px radius, no border, no shadow, 28px title, "Learn more" link in #0066cc
- Navigation: sticky 48px, rgba(0,0,0,0.8) + blur, 12px white links
- Section layout: alternating black/#f5f5f7 sections, each near full-viewport height
