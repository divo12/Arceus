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

## Using a Theme
Once selected, map its colors to the Design Token Doc format:
```yaml
THEME: [Theme Name]
Typography:
  Display/H1:  [Font name] — [weight]
  Body:        [Font name] — [weight]
  Mono/Code:   [Font name] — optional
Colors:
  --color-primary:    #______  (brand, CTAs)
  --color-secondary:  #______  (supporting)
  --color-bg:         #______  (page background)
  --color-surface:    #______  (card/panel background)
  --color-text:       #______  (primary text)
  --color-muted:      #______  (secondary text)
  --color-accent:     #______  (highlight, hover states)
  --color-success:    #10B981
  --color-warning:    #F59E0B
  --color-error:      #EF4444
Border Radius: [tight 4px / balanced 8px / soft 16px / pill 9999px]
Shadow Style:  [flat / subtle / elevated / dramatic]
Motion Feel:   [snappy / smooth / springy / minimal]