---
name: ui-theme-catalog
description: 10 ready-to-use design themes with colors, fonts, and best-fit product types. Pick the closest match to a product's mood, customize hex as needed, or define a new named theme in the same format.
role: ui_designer
trigger: establishing aesthetic direction for a new product or brand refresh; before writing the Design Token Doc; when the team is debating colors/fonts in the abstract
---

# Theme Catalog

10 ready-to-use themes. Pick the closest match to the product's mood, then customize hex values as needed. If none fit, define a new named theme in the same format.

| # | Theme | Colors | Font Style | Description | Best For |
|---|-------|--------|------------|-------------|----------|
| 1 | **Arctic Frost** | Ice Blue `#d4e4f7` · Steel Blue `#4a6fa5` · Silver `#c0c0c0` · White `#fafafa` | DejaVu Sans | A cool and crisp winter-inspired theme that conveys clarity, precision, and professionalism. | Healthcare, clean tech, professional tools |
| 2 | **Botanical Garden** | Fern `#4a7c59` · Marigold `#f9a620` · Terracotta `#b7472a` · Cream `#f5f3ed` | DejaVu Serif heads / DejaVu Sans body | A fresh and organic theme featuring vibrant garden-inspired colors for lively presentations. | Nature, food, sustainability, wellness |
| 3 | **Desert Rose** | Dusty Rose `#d4a5a5` · Clay `#b87d6d` · Sand `#e8d5c4` · Burgundy `#5d2e46` | FreeSans | A soft and sophisticated theme with dusty, muted tones perfect for elegant presentations. | Fashion, beauty, wedding, interiors |
| 4 | **Forest Canopy** | Forest `#2d4a2b` · Sage `#7d8471` · Olive `#a4ac86` · Ivory `#faf9f6` | FreeSerif heads / FreeSans body | A natural and grounded theme featuring earth tones inspired by dense forest environments. | Eco, sustainability, health, outdoors |
| 5 | **Golden Hour** | Mustard `#f4a900` · Terracotta `#c1666b` · Beige `#d4b896` · Chocolate `#4a403a` | FreeSans | A rich and warm autumnal palette that creates an inviting and sophisticated atmosphere. | Restaurant, hospitality, artisan, seasonal |
| 6 | **Midnight Galaxy** | Deep Purple `#2b1e3e` · Cosmic Blue `#4a4e8f` · Lavender `#a490c2` · Silver `#e6e6fa` | FreeSans | A dramatic and cosmic theme with deep purples and mystical tones for impactful presentations. | Entertainment, gaming, luxury, creative |
| 7 | **Modern Minimalist** | Charcoal `#36454f` · Slate `#708090` · Light Gray `#d3d3d3` · White `#ffffff` | DejaVu Sans | A clean and contemporary theme with a sophisticated grayscale palette for maximum versatility. | Tech, architecture, data viz, B2B SaaS |
| 8 | **Ocean Depths** | Navy `#1a2332` · Teal `#2d8b8b` · Seafoam `#a8dadc` · Cream `#f1faee` | DejaVu Sans | A professional and calming maritime theme that evokes the serenity of deep ocean waters. | Corporate, finance, consulting, trust-first |
| 9 | **Sunset Boulevard** | Burnt Orange `#e76f51` · Coral `#f4a261` · Sand `#e9c46a` · Deep Purple `#264653` | DejaVu Serif heads / DejaVu Sans body | A warm and vibrant theme inspired by golden hour sunsets, perfect for energetic and creative presentations. | Creative agency, marketing, lifestyle, events |
| 10 | **Tech Innovation** | Electric Blue `#0066ff` · Cyan `#00ffff` · Dark Gray `#1e1e1e` · White `#ffffff` | DejaVu Sans | A bold and modern theme with high-contrast colors perfect for cutting-edge technology presentations. | Startups, AI/ML, software, digital product |

## How to choose

Walk through these questions in order:

1. **What's the product's emotional tone?** Calm and trustworthy, or energetic and bold? Trust-first products (finance, healthcare, B2B) gravitate toward themes 1, 7, 8. Energetic products (consumer, gaming, creative) toward 5, 9, 10.

2. **What's the audience?** Themes 3, 4, 5 read warmer for human-first products. Themes 1, 7, 10 read sharper for pro / technical tools. Themes 2, 6, 9 stand out — riskier but more memorable.

3. **What does the competition look like?** If every competitor uses default blue-on-white (theme 10 territory), differentiate by picking 2, 4, or 5. Looking like every other AI startup is a strategic loss.

4. **Will the product be used in light environments, dark, or both?** Themes 6, 8 lend themselves to dark mode primary. 1, 4, 5 are light-mode native. 7, 10 work both.

## When to define a new theme

If none of the 10 fit:
- Document the new theme in the same row format (Name | Colors | Font Style | Description | Best For).
- Save it to the next available number in this catalog (commit a SKILL.md update — pattern learner will pick it up).
- Use it. Other beats and other companies benefit from your new theme.

## Anti-patterns

- **Picking based on personal preference.** The product's audience and emotional tone drive the choice, not your taste.
- **Mixing two themes.** One product, one theme. Customize hex within a theme; don't blend palettes across themes.
- **Using the catalog as a placeholder** ("we'll pick later"). The token doc requires concrete values — pick now, refine after first user research.
- **Picking theme 7 or 10 by default** because they feel "safe." They are. They also produce generic-looking products. Pick deliberately, even if you ultimately choose them.

## Output

After picking, load `ui-design-token-doc` skill to fill the YAML token template using your chosen theme's colors. The token doc is the artifact developers import; this catalog is the decision tool.
