# God-Tier Sites — Assessment, Plan & Constraints

> Goal: the products Arceus's AI company ships must be god-tier in **both design and
> functionality** — not basic. This doc is the assessment + the enforceable constraints +
> the implementation plan. Status: PLAN (2026-06-13).

## 0. Evidence (what "basic" looks like today)

Live sample — TaskVault (`taskvault-v0.arceus.sh`), built fully autonomously: a flat
white-card CRUD form (Title / Priority / Due / Add), a plain task list, an AI-breakdown
box. It *works* and is *clean*, but it is **generic** — default shadcn, system font, no
depth, no motion, no signature, and functionally a toy (add/list/delete + one AI call).
That is the ceiling we are raising.

---

## 1. Why output plateaus at "basic" — root causes

### Design
- **D1. The aesthetic menu is a slide-deck palette catalog, not a web design system.**
  `ui-theme-catalog` offers 4 colors + *presentation fonts* (DejaVu Sans, FreeSerif) per
  theme. No type scale, spacing rhythm, depth/shadow system, motion, or component states.
  It even admits themes 7/10 are "generic" but offers nothing better. → safe, flat output.
- **D2. No god-tier reference standard.** Nothing benchmarks output to Linear/Vercel/
  Stripe/Apple. The agent has no concrete picture of "great."
- **D3. No design-quality gate, and the one role that could judge looks (tester) is blind.**
  The tester explicitly has NO browser/screenshots; the verifier only flags "raw hex
  instead of tokens." So **nothing ever fails a beat for being basic.** The loop optimizes
  for "builds + imports," never "world-class."
- **D4. The scaffold floor is plain shadcn** (system font, flat cards, no motion/depth).

### Functionality
- **F1. "Demo-first MVP" framing is the ambition ceiling.** CEO strategy titles are
  literally "Demo-First …MVP"; PM writes "3–8 stories"; agents build the minimum that
  passes. Toy scope is the *target*, not a failure.
- **F2. No functional-depth standard.** Nothing demands keyboard shortcuts, search/filter/
  sort, bulk actions, undo, optimistic UI, real empty/loading/error states, validation,
  or meaningful data depth. "Add/list/delete" satisfies acceptance criteria.
- **F3. The verifier checks correctness/security, not richness.** A stub button or a
  missing state is never flagged as "shallow." Build-passes = done.

---

## 2. The asset: `awesome-design-md` corpus (the design constraint, pre-authored)

`~/awesome-design-md` — 58 god-tier brand design systems (apple, linear.app, vercel,
stripe, raycast, notion, figma, airbnb, supabase, cohere, clickhouse, ferrari, tesla,
spacex, …) each a complete **Google Stitch DESIGN.md** (9 sections: theme/atmosphere,
color roles + hex, typography hierarchy, component stylings + states, layout/spacing,
depth/elevation, do's & don'ts, responsive, agent-prompt guide). ~15k lines, markdown —
the format LLMs read best. Purpose-built: "copy a DESIGN.md, tell your agent 'build a
page that looks like this,' get pixel-perfect UI."

**This replaces inventing a rubric.** We bundle the corpus into Arceus; the UI designer
picks the closest brand to the product and adapts its DESIGN.md as the product's spec.

---

## 3. DESIGN god-tier — plan & constraints

### Plan
1. **Bundle the corpus** into a UI-designer reference skill `ui-design-system-library`:
   an INDEX (brand → one-line aesthetic + best-for) as SKILL.md, with all 58 `DESIGN.md`
   files as skill resources the agent reads on demand. (Confirm skill-seeding copies the
   whole dir; if not, fold the index + top ~12 systems inline.)
2. **UI-designer flow**: pick the closest brand aesthetic to the product's domain/mood →
   read that `DESIGN.md` → adapt it into **`/workspace/DESIGN.md`** (the product's own
   design system, customized hex/name but keeping the craft: type scale, weights,
   letter-spacing, depth, motion, component states) + derive `tokens.yaml` from it.
3. **Developer**: implement to `/workspace/DESIGN.md` *faithfully* — real web font
   (Inter/Geist via the scaffold), the exact depth/shadow/border system, motion/
   transitions, every component state. Not default shadcn.
4. **Scaffold floor**: ship Inter + a depth/shadow scale + motion utilities + a polished
   starting layout so even the baseline clears "generic."
5. **Design-quality gate** (the missing loop): extend the post-beat verifier with a
   DESIGN dimension that reads the shipped CSS/components against `/workspace/DESIGN.md`
   and flags flat/default/system-font/no-motion/no-depth as high-severity → auto-fix task.
   (Phase 2: a real screenshot critic via headless browser + vision model.)

### Constraints (non-negotiable — a UI beat fails if any is unmet)
- **C-D1.** A real web font (Inter/Geist/Satoshi/…) is loaded and used — NEVER the system
  default. Headings use a deliberate type scale with negative letter-spacing at display sizes.
- **C-D2.** A `/workspace/DESIGN.md` exists (adapted from a god-tier reference) and the UI
  visibly follows it (color roles, depth, radii, motion).
- **C-D3.** Depth is layered (multi-stop shadows / considered borders / surface hierarchy),
  not flat single-shadow cards.
- **C-D4.** Purposeful motion: transitions on interactive elements; ≥1 meaningful
  micro-interaction. Respect `prefers-reduced-motion`.
- **C-D5.** Every interactive element has hover / focus-visible / active / disabled states.
- **C-D6.** Real empty, loading (skeleton, not "Loading…"), and error states.
- **C-D7.** Responsive + a deliberate dark mode (not auto-inverted).
- **C-D8.** A signature element (hero, gradient mesh, distinctive nav, etc.) — one thing
  that makes it memorable, not template-generic.

---

## 4. FUNCTIONALITY god-tier — plan & constraints

### Plan
1. **Kill the "MVP/demo-first" ceiling** in CEO strategy + PM framing. Replace with a
   "ship a complete, opinionated product slice" bar: fewer features, each *fully realized*.
2. **PM**: every core story must specify the full interaction surface — states, edge cases,
   keyboard, validation, persistence — not just the happy path. Add a functional-depth
   rubric (`pm-functional-depth`).
3. **CTO**: data model + API must support the real interactions (search/filter/sort/
   pagination, bulk, optimistic update, derived state), not just CRUD.
4. **Developer**: implement the depth — handlers actually wired, no dead buttons, no TODOs
   shipped, real validation + error handling.
5. **Functionality gate**: extend the verifier with a FUNCTIONALITY dimension flagging
   stubs/dead controls/missing states/`TODO`/`alert()`/`console.log`-as-feature as
   high-severity → auto-fix.

### Constraints (non-negotiable — a feature beat fails if any is unmet)
- **C-F1.** No dead controls: every button/link/form does something real (no stubs, no
  `alert()`/`console.log` standing in for behavior, no unhandled `onClick`).
- **C-F2.** Core list/data UIs include search **and** filter **and** sort where N>~5.
- **C-F3.** Keyboard support: Enter submits, Esc cancels, focus order is sane; ≥1 real
  shortcut for a primary action.
- **C-F4.** Optimistic UI or explicit pending state on every mutation; no frozen UI on async.
- **C-F5.** Input validation with inline, specific errors (not just a red border).
- **C-F6.** Real persistence (server + SQLite) for anything the spec says is saved — never
  localStorage as the system of record; survives reload + multi-tab.
- **C-F7.** Empty/loading/error/success states for every data surface (mirrors C-D6).
- **C-F8.** Undo or confirm on destructive actions; no silent data loss.

---

## 5. Enforcement architecture (where constraints bind)

| Lever | Change | Constraints enforced |
|------|--------|----------------------|
| `ui-design-system-library` skill (NEW) | bundle 58 DESIGN.md + index | C-D1,2,8 |
| `ui-designer.ts` prompt | pick brand → adapt `/workspace/DESIGN.md`; the bar | C-D1–8 |
| `developer.ts` prompt | implement to DESIGN.md; no dead controls; states | C-D*, C-F1,4,5,7 |
| scaffold (template) | Inter + depth + motion + polished start | C-D1,3,4 floor |
| `pm.ts` + `pm-functional-depth` skill | full interaction surface per story | C-F2,3,5,8 |
| `cto.ts` | data/API for real interactions | C-F2,4,6 |
| `code-review.ts` verifier | + DESIGN + FUNCTIONALITY dimensions | all (the gate) |
| CEO strategy prompt | drop "MVP/demo-first"; "complete slice" | F1 ceiling |

The verifier extension is the keystone — it's the only place that **fails** a beat for
being basic, closing the feedback loop that D3/F3 leave open.

## 6. Phasing
1. Bundle corpus + `ui-design-system-library` skill; wire `ui-designer.ts`. (design source)
2. Scaffold floor (Inter + depth + motion + starting layout). (raises baseline)
3. `developer.ts` + `pm.ts` + `cto.ts` + CEO bars + `pm-functional-depth`. (ambition)
4. Verifier DESIGN + FUNCTIONALITY dimensions. (the gate)
5. Deploy → fresh company → compare output to TaskVault baseline.
6. (Later) screenshot + vision design critic.
