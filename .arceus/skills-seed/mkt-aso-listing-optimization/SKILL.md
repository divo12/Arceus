---
name: mkt-aso-listing-optimization
description: Optimize an app store listing — keywords, title, screenshots, description — for organic discovery and conversion. Replaces "we'll figure out the listing later."
role: marketing
trigger: preparing an app store listing for launch; listing has been live but downloads are flat; reviewing a competitor's listing for benchmarks
---

# ASO Listing Optimization

App store search is a closed system. Two apps with identical features see vastly different download volumes based on listing quality. The work splits into discovery (will users find it?) and conversion (will they install?).

## Step 1: Keyword research

Goal: a ranked list of 8–15 keywords with realistic targeting.

- **Seed keywords** — list 5 phrases that describe the app from a user's perspective, not yours. "App for parents to coordinate school schedules" not "family OS platform."
- **Auto-complete mining** — type each seed into the App Store and Play Store search bar. Capture every suggestion. These are real searches.
- **Competitor scraping** — find 3 competitors. Note the keywords in their title and subtitle. These are usually high-volume.
- **Long-tail** — combine seeds with modifiers ("free", "for parents", "offline"). Lower volume, lower competition, easier to rank.
- **Score each keyword**: estimated volume (high/med/low) × estimated difficulty (high/med/low). Best ratio wins.

Output: a prioritized keyword list with reasoning.

## Step 2: Metadata

### iOS App Store (strict character limits)
- **Title (30 chars)** — brand + 1 strong keyword. `Mosaic: Family Schedule`
- **Subtitle (30 chars)** — different keywords from title. `Calendar & reminders for parents`
- **Keywords field (100 chars, comma-separated, no spaces)** — pack with relevant terms not already in title/subtitle. `coordinate,school,kids,family,planner,reminders,events,routine`
- **Promotional text (170 chars)** — current value prop, can change without re-review. Use for launches/seasonal.
- **Description** — readable prose, NOT keyword-stuffed (Apple penalizes). First 3 lines are the conversion battlefield.

### Google Play (different rules)
- **Title (50 chars)** — more room for keywords. Still readable.
- **Short description (80 chars)** — direct conversion driver. Lead with the user benefit.
- **Long description (4000 chars)** — keyword density does help here, but readability matters. 1–2% target density per keyword.

## Step 3: Visual assets

Visuals drive conversion more than copy. Test these in order.

| Element | Impact on conversion | Test priority |
|---|---|---|
| App icon | Highest — first impression | First |
| First screenshot | Second-highest | Second |
| Preview video (if used) | Lifts conversion 15–25% on average | After icon |
| Screenshots 2–5 | Diminishing returns | Last |

### Icon principles
- Distinctive against neighbor icons in search results.
- Readable at 60×60 px (the smallest size shown).
- No text inside the icon (text disappears at small sizes).
- Brand color, not stock-image gradient.

### Screenshot story (5 screenshots)
1. **Hook** — main value prop, biggest text, screenshot of the most beautiful screen.
2. **Core flow** — what they actually do day-to-day.
3. **Differentiator** — the feature competitors don't have.
4. **Social proof** — quote from a review, an award, a number ("Used by 100k families").
5. **CTA / summary** — gentle close, "Start free."

Caption every screenshot with one tight sentence. Don't rely on the visual to speak for itself.

## Step 4: Description structure

Both stores reward this format:

```
[3-line hook — what is it, who is it for, why is it different]

[Bullet list of features, each one line, benefit-first]
• Schedule once — every parent sees it
• Kid-by-kid pickup roles
• Reminders that don't yell

[Social proof block]
★★★★★ "Finally, no more group-text chaos." — Beta tester
Featured in [outlet] / Awarded [recognition] / Used by [number]

[Clear CTA]
Free to start. No account required.

[Tertiary info — links, support, privacy]
```

The first 3 lines are critical. iOS shows them above the "more" fold; Google Play uses them in featured cards.

## Step 5: Conversion testing (Google Play)

Google Play has built-in A/B testing. Run one element at a time:
- Icon variant
- First screenshot variant
- Short description variant

Each test takes 7–14 days for significance. Don't change other elements during the test or you'll confound the result.

iOS has no built-in tests; use external mock-listing tools (PickFu, SplitMetrics) on the icon and first screenshot before launch.

## Step 6: Localize the high-leverage stuff

Translating just the title, subtitle/short description, and first screenshot caption into your top 3 non-English markets often doubles installs in those markets. Full localization comes later.

## Common mistakes

- Stuffing keywords into the description until it's unreadable. Penalized on iOS, ignored by users on Android.
- Generic stock-image-style icons. Looks like every other "AI productivity" app.
- Screenshot 1 being "Welcome to [App]". Wastes the most valuable real estate on a tour.
- Title that's the brand only — "Mosaic". Wastes ~20 keyword characters.
- Treating ASO as a one-time pre-launch task. It's continuous; listings need to evolve with reviews and seasonality.

## Output

Attach an ASO brief artifact to the claimed task with:
- Final title, subtitle, keyword field
- Final short + first 3 lines of long description
- Screenshot order with one-line captions for each
- Keyword priority list with rationale
- Top 2 A/B tests to run after launch
