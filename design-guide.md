Swiss Design (International Typographic Style)
A design philosophy born in 1950s Switzerland that prioritizes clarity, objectivity, and mathematical precision. It treats design as a system, not decoration.

Core Principles
Grid is Law — All layout decisions are governed by a strict modular grid system. Content aligns to invisible columns and baselines.
Typography as Architecture — Type is the primary design element. Use sans-serif typefaces (Helvetica, Neue Haas Grotesk, Univers, Aktiv Grotesk, Inter). Hierarchy is built through weight, size, and spacing — never decoration.
Objective Communication — Design serves content. Remove anything that doesn't communicate. No ornament, no gratuitous imagery.
Asymmetric Balance — Compositions favor asymmetry over centered layouts, creating dynamic visual tension within the grid.
Whitespace as Structure — Negative space is an active design element, not leftover emptiness. It creates rhythm and breathing room.
Photography over Illustration — When imagery is needed, use objective photography. Avoid stylized or illustrative graphics.
Visual DNA
Property	Value
Border Radius	0px – 4px (sharp, geometric)
Borders	Thin rules (1px solid) used as grid dividers, not decoration
Shadows	None. Depth is achieved through layering and contrast
Typography	Sans-serif only. Large display type (48–120px), strict size scale
Font Weight	Bold (700–900) for headlines, Regular (400) for body
Line Height	Tight: 1.1 – 1.2 for headlines, 1.5 – 1.6 for body
Letter Spacing	Tight (-0.02em to -0.04em) for headlines
Grid	12-column modular grid, strict alignment
Colors	Limited palette: 1–2 accent colors + black/white
Technical Standards
Grid First — Always start with grid grid-cols-12.
Horizontal Rules — Use border-t or border-b to section content.
Numbering — Index items with small numbers (01, 02) in a dedicated column.
Uppercase Captions — Small text is always uppercase with wide tracking (tracking-widest).
No Shadows — Elevation is communicated through contrast and spacing.
Anti-Patterns
Rounded corners > 4px
Drop shadows or glows
Gradient backgrounds
Decorative illustrations
Centered text layouts (except single-line captions)

name	ui-designer
description	Design beautiful interfaces using 16+ design systems including Material You, Fluent Design, Apple HIG, Ant Design, Carbon Design, Shopify Polaris, Minimalism, Glassmorphism, Neo-Brutalism, Neumorphism, Skeuomorphism, Claymorphism, Swiss Design, and Atlassian Design. Expert in Tailwind CSS, color harmonics, component theming, and accessibility (WCAG).
UI Designer Skill
Expert design guidance for creating aesthetically pleasing, user-centric interfaces across multiple design languages. This skill focuses on the visual and structural design intent before and during implementation.

Core Capabilities
1. Color Palette Generation
Generate cohesive and harmonic color palettes tailored to the project's vibe.

Deliverables: HEX codes, Tailwind config extensions, and CSS variables.
Palettes: Default to high-end pastels, dark luxury, or tonal Material You sets.
2. Component Theming
Establish robust theme systems (Light/Dark) through consistent design tokens.

Define --bg, --text, --accent, and --border variables.
Ensure unified states (hover, focus, active) across all UI elements.
3. Accessibility Audits
Evaluate and refine interfaces for maximum inclusivity and compliance.

Focus: WCAG AA/AAA contrast ratios, semantic HTML, and intuitive navigation.
Guidance: ARIA attributes, focus ring management, and screen-reader friendliness.
Design Systems Library (16 Total)
Category	System	Key Traits	Best For	Reference
Enterprise	Fluent Design	Acrylic materials, reveal effects, 5 principles	Windows apps, Microsoft 365, enterprise	fluent-design.md
Enterprise	Ant Design	Natural, 8px grid, 12-column	Admin panels, B2B, data-heavy apps	ant-design.md
Enterprise	Carbon Design	16-column grid, IBM Plex, clarity	Enterprise software, data visualization	carbon-design.md
Enterprise	Atlassian Design	Bold, collaboration-focused, 8px grid	Project management, team tools	atlassian-design.md
Platform	Apple HIG	SF Pro, vibrancy, blur materials, 44pt targets	iOS, macOS, native apps	apple-hig.md
Platform	Shopify Polaris	Merchant-focused, fresh, teal brand	E-commerce, merchant tools	shopify-polaris.md
Modern	Material You	Dynamic color, large corners, tonal palettes	Android, modern web apps	material-you.md
Modern	Glassmorphism	Backdrop blur, vibrant gradients	Dashboards, hero sections	glassmorphism.md
Modern	Neumorphism	Soft 3D, dual shadows, monochromatic	Creative projects, minimal UI	neumorphism.md
Modern	Neo-Brutalism	Thick borders, hard shadows, bold colors	Creative agencies, artistic brands	neo-brutalism.md
Modern	Claymorphism	Soft 3D, double inner shadows, playful	Playful apps, consumer products	claymorphism.md
Classic	Minimalism	Typography-driven, generous padding	Content sites, portfolios	minimalism.md
Classic	Swiss Design	12-column grid, no shadows, asymmetric	Professional services, typography	swiss-design.md
Classic	Skeuomorphism	Realistic textures, physical mimicry	Luxury products, vintage themes	skeuomorphism.md
Hybrid	M3 Pastel Glass	Material + Glass, 28px corners	Modern SaaS, creative tools	m3-pastel-glass.md
Hybrid	Neo-M3 Hybrid	Brutalism + M3, 3px borders, hard shadows	Tech media, editorial sites	neo-m3-hybrid.md
Automation: Cursor Integration
This skill can automatically update your project's .cursorrules to keep the AI aligned with your design goals.

apply_ui_rules.py
Run this script to append design rules to your current directory's .cursorrules.

python3 $WORKSPACE/skills/ui-designer-skill/scripts/apply_ui_rules.py --style [fluent|ant|carbon|atlassian|apple-hig|polaris|material|minimal|glass|neumorphism|neo-brutalism|claymorphism|skeuomorphism|swiss|m3-pastel|neo-m3] --palette [pastel|dark|vibrant|mono]
Workflows
1. Design Conception
When starting a new feature, ask for:

Primary design language? (Choose from 16+ systems: Fluent, Ant, Carbon, Atlassian, Apple HIG, Polaris, Material You, Glassmorphism, Neumorphism, Neo-Brutalism, Claymorphism, Minimalism, Swiss Design, Skeuomorphism, or hybrid styles)
Color vibe? (Pastel, Dark, High-Contrast, Monochromatic, Brand-specific)
Target platform? (Web, iOS, Android, Desktop, Cross-platform)
2. Component Architecture
Plan the HTML/React structure with Tailwind classes. Focus on Grid/Flex layouts and responsiveness.

Best Practices
Consistency: Stick to one design language per project.
Accessibility: Ensure enough contrast for text.
Azzar's Rule: "Just enough engineering to get it done well." (Wong edan mah ajaib).