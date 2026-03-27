# Layer 1: Organization UI Design Guide

> **Date**: 2026-03-27 | **Companion to**: `2026-03-27-layer1-organization-implementation.md`
> **Scope**: UI specifications for Role Editor, Hierarchy Proposals, enhanced OrgChart, Agent Authority, and NewAgent governance
> **Design system**: Follows Paperclip conventions — dark-first, dense, keyboard-driven, OKLCH tokens

---

## Table of Contents

1. [New Pages](#1-new-pages)
2. [Modified Pages](#2-modified-pages)
3. [New Components](#3-new-components)
4. [Design Guide Page Additions](#4-design-guide-page-additions)
5. [Navigation Changes](#5-navigation-changes)
6. [Interaction Patterns](#6-interaction-patterns)
7. [Responsive Behavior](#7-responsive-behavior)

---

## 1. New Pages

### 1.1 Role Editor (`/roles`)

**File**: `ui/src/pages/RoleEditor.tsx`
**Purpose**: Board configures role definitions — system prompts, delegation authority, spawn rules

#### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Roles                                               [+ New Role]  │
│  Configure agent role definitions for this company                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ CEO ──────────────────────────────────────────────────────┐    │
│  │  [Crown icon]  CEO  [directive]  [built-in]  [lock icon]   │    │
│  │                                                             │    │
│  │  System Prompt ──────────────────────────────────────────── │    │
│  │  │ You are the Chief Executive Officer. You set vision,   │ │    │
│  │  │ coordinate the team, and report to the Board...        │ │    │
│  │  └─────────────────────────────────────────────────────── │    │
│  │                                                             │    │
│  │  Delegation Authority ──────────────────────────────────── │    │
│  │  Can delegate to: [CTO] [PM] [Engineer] [Designer]         │    │
│  │  Style: [directive ▼]                                       │    │
│  │                                                             │    │
│  │  Spawn Rules ───────────────────────────────────────────── │    │
│  │  Can create:  [CTO] [PM] [Engineer] [Designer] [QA] [DevOps] │  │
│  │  Max concurrent: [10]     Spawn depth: 1 (fixed)           │    │
│  │                                                             │    │
│  │  Tools: [web-search] [market-analysis] [meeting] [+]       │    │
│  │  Skills: [strategy] [leadership] [research] [+]            │    │
│  │                                                             │    │
│  │                             [Reset to Default]  [Save]      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ CTO ──────────────────────────────────────────────────────┐    │
│  │  ...collapsed by default...                     [Expand ▼]  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ PM ───────────────────────────────────────────────────────┐    │
│  │  ...collapsed...                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

#### Specifications

**Page header**:
```
text-xl font-bold       → "Roles"
text-sm text-muted-foreground mt-1  → "Configure agent role definitions for this company"
```

**Role card** (one per role definition, uses `Collapsible` from shadcn):
```
Container:     border border-border rounded-lg bg-card
Header row:    px-4 py-3 flex items-center gap-3
               ├── AgentIcon (role-appropriate icon, w-8 h-8 in bg-muted rounded-lg)
               ├── Role label: text-sm font-semibold
               ├── DelegationStyleBadge (new component, see 3.1)
               ├── if isBuiltIn: Badge variant="outline" → "built-in"
               ├── if isBuiltIn: Lock icon (h-3.5 w-3.5 text-muted-foreground)
               └── Collapsible trigger (ChevronDown, right-aligned)
Expanded body: px-4 pb-4 space-y-4 border-t border-border
```

**System prompt editor**:
```
Label:    text-xs text-muted-foreground font-medium uppercase tracking-wide
Textarea: min-h-[120px] text-sm font-mono bg-muted/30 border border-border rounded-md px-3 py-2
          resize-y, placeholder="Enter the role's behavioral instructions..."
```

**Delegation authority section**:
```
Label:           text-xs text-muted-foreground font-medium uppercase tracking-wide
"Can delegate to": Horizontal wrap of role tag chips (see 3.2 RoleTagChip)
                   Add via Popover with role multi-select
"Style":          Select dropdown → directive | collaborative | autonomous
                  Each option has a muted description line below the label
```

**Spawn rules section**:
```
"Can create":       Role tag chips (same as delegation, different color)
"Max concurrent":   Input type="number" w-20, min=0, max=20
"Spawn depth":      Read-only text "1 (fixed)" in text-xs text-muted-foreground
```

**Tools / Skills**: Tag input pattern — horizontal wrap of removable tags with `[+]` button that opens a text input popover.

**Footer**:
```
Container:  flex items-center justify-end gap-2 pt-3 border-t border-border
Buttons:    [Reset to Default] → Button variant="ghost" size="sm" (only if isBuiltIn)
            [Save]             → Button variant="default" size="sm"
```

---

### 1.2 Hierarchy Proposals (`/hierarchy/proposals`)

**File**: `ui/src/pages/HierarchyProposals.tsx`
**Purpose**: Board reviews, approves, and activates org chart changes proposed by agents

#### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Hierarchy Proposals                                                │
│  Review and approve organizational changes                         │
├────────────────────────────────────────────────────────────────────┤
│  [Pending (2)]  [All]                           ← PageTabBar       │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ Proposal #1 ─────────────────────────────────────────────┐     │
│  │  ┌──────────────────┐                                      │     │
│  │  │  [Network icon]  │  "Add Designer role under CTO"       │     │
│  │  │  proposed         │  Proposed by: CEO (Atlas) · 2h ago  │     │
│  │  └──────────────────┘                                      │     │
│  │                                                             │     │
│  │  Rationale:                                                 │     │
│  │  "The product needs dedicated design work. Adding a        │     │
│  │   Designer reporting to CTO for UI/UX execution."          │     │
│  │                                                             │     │
│  │  Changes:                                                   │     │
│  │  + Designer → reports_to → CTO                              │     │
│  │  + CTO → delegates_to → Designer                           │     │
│  │                                                             │     │
│  │  ┌─ Current ──────────┐  ┌─ Proposed ─────────────┐       │     │
│  │  │    ┌─────┐         │  │    ┌─────┐              │       │     │
│  │  │    │ CEO │         │  │    │ CEO │              │       │     │
│  │  │    └──┬──┘         │  │    └──┬──┘              │       │     │
│  │  │    ┌──┴──┐         │  │  ┌───┼───┐             │       │     │
│  │  │  ┌─┴─┐┌─┴─┐       │  │┌─┴─┐┌┴──┐┌───┐        │       │     │
│  │  │  │CTO││ PM│       │  ││CTO││PM ││Des│        │       │     │
│  │  │  └───┘└───┘       │  │└───┘└───┘└───┘        │       │     │
│  │  └────────────────────┘  └────────────────────────┘       │     │
│  │                                                             │     │
│  │              [Reject]  [Approve]  [Approve & Activate]      │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌─ Proposal #2 ─────────────────────────────────────────────┐     │
│  │  ...                                                        │     │
│  └─────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Specifications

**Tab bar**: `PageTabBar` with items `["pending", "all"]`. Pending tab shows count badge:
```tsx
<span className="bg-yellow-500/20 text-yellow-500 rounded-full px-1.5 py-0.5 text-[10px] font-medium ml-1">
  {pendingCount}
</span>
```

**Proposal card**:
```
Container:    border border-border rounded-lg bg-card
Header:       px-4 py-3 flex items-center gap-3
              ├── Icon container: rounded-lg bg-primary/10 p-2
              │   └── Network icon (h-4 w-4 text-primary)
              ├── Title: text-sm font-semibold
              ├── StatusBadge (proposed | approved | active | rejected)
              └── Metadata: text-xs text-muted-foreground → "Proposed by: {name} · {timeAgo}"
Body:         px-4 pb-4 space-y-4
```

**Rationale block**:
```
Label:   text-xs text-muted-foreground font-medium uppercase tracking-wide → "Rationale"
Content: text-sm text-foreground bg-muted/30 rounded-md px-3 py-2 border border-border
```

**Changes diff list**:
```
Label:     text-xs text-muted-foreground font-medium uppercase tracking-wide → "Changes"
Container: space-y-1
Added:     text-xs font-mono → "+" prefix in text-emerald-500
Removed:   text-xs font-mono → "−" prefix in text-red-500
Modified:  text-xs font-mono → "~" prefix in text-amber-500
```

**Side-by-side mini org charts**:
```
Container: grid grid-cols-2 gap-4
Each side: border border-border rounded-lg p-4 bg-muted/20
Label:     text-xs text-muted-foreground font-medium mb-2 → "Current" / "Proposed"
Chart:     Simplified SVG tree (reuse OrgChart layout algorithm at smaller scale)
           CARD_W = 80, CARD_H = 36, GAP_X = 12, GAP_Y = 32
           Node: rounded-md bg-card border px-2 py-1 text-[10px] font-medium
           New nodes: border-emerald-500 border-dashed
           Removed nodes: border-red-500 border-dashed opacity-50
```

**Action buttons**:
```
Container: flex items-center justify-end gap-2 pt-3 border-t border-border
[Reject]:              Button variant="ghost" size="sm" className="text-destructive"
[Approve]:             Button variant="outline" size="sm"
[Approve & Activate]:  Button variant="default" size="sm"
```

**Empty state** (no pending proposals):
```tsx
<EmptyState icon={Network} message="No hierarchy proposals pending." />
```

---

## 2. Modified Pages

### 2.1 OrgChart Enhancements (`/org`)

**File**: `ui/src/pages/OrgChart.tsx`

#### New: Delegation edges (dashed lines)

Add a second pass after rendering `reports_to` edges (solid lines). Delegation edges use:

```
SVG path:     stroke-dasharray="6,4" stroke-width="1.5"
Color:        stroke="var(--chart-1)" (purple, the primary accent)
              opacity="0.6"
Arrow marker: Small arrowhead at target end
```

Toggle control (top-right, next to zoom buttons):
```
Container: flex items-center gap-1.5 bg-background border border-border rounded-md px-2 py-1
Label:     text-[10px] text-muted-foreground
Toggle:    shadcn Switch (size sm)
Text:      "Delegation"
```

#### New: Delegation style badge on agent cards

Below the adapter type line in each org card, add:

```
text-[10px] font-medium uppercase tracking-wide
Colors by style:
  directive:     text-amber-500    bg-amber-500/10  px-1.5 py-0.5 rounded-full
  collaborative: text-blue-500     bg-blue-500/10   px-1.5 py-0.5 rounded-full
  autonomous:    text-emerald-500  bg-emerald-500/10 px-1.5 py-0.5 rounded-full
```

#### New: Hierarchy status banner

When pending proposals exist, show a banner above the org chart:

```
Container:  flex items-center gap-2 px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-4
Icon:       AlertTriangle (h-4 w-4 text-yellow-500)
Text:       text-sm text-yellow-700 dark:text-yellow-400
            → "{count} hierarchy proposal(s) pending review"
Link:       text-sm font-medium underline → navigates to /hierarchy/proposals
```

#### New: Active snapshot status indicator

Top-left corner of the chart area:

```
Container: flex items-center gap-1.5 px-2 py-1 bg-background/80 backdrop-blur rounded-md border border-border
Dot:       w-2 h-2 rounded-full bg-emerald-500 (if active) or bg-yellow-500 (if proposed)
Text:      text-[10px] text-muted-foreground → "Active snapshot · {date}"
```

---

### 2.2 Agent Detail Authority Section

**File**: `ui/src/pages/AgentDetail.tsx`

Add a new tab "Authority" (or section in the properties panel) showing:

```
┌─ Authority ────────────────────────────────────────────┐
│                                                         │
│  Role Definition                                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │  [Crown]  CEO  [directive]  [→ Edit Role]        │   │
│  │  "You are the CEO. You set vision..."            │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Delegation Authority                                   │
│  Can delegate to:                                       │
│  [CTO ✓] [PM ✓] [Engineer ✓] [Designer ✓]             │
│                                                         │
│  Spawn Authority                                        │
│  Can create: [Engineer] [QA] [DevOps]                   │
│  Budget: ████████░░ 7/10 active (3 remaining)           │
│                                                         │
│  Active Delegations                                     │
│  → CTO: "Design auth system" (in_progress)              │
│  → PM: "Write user stories" (in_progress)               │
│  ← Board: "Build authentication" (delegated to you)     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Specifications

**Section header**: `text-xs text-muted-foreground font-semibold uppercase tracking-wide`

**Role definition card**:
```
Container:   rounded-lg border border-border bg-muted/20 px-4 py-3
Row 1:       flex items-center gap-2
             ├── AgentIcon (role icon, w-6 h-6)
             ├── Role label: text-sm font-semibold
             ├── DelegationStyleBadge
             └── Link to role editor: text-xs text-primary hover:underline
Row 2:       text-xs text-muted-foreground mt-1 line-clamp-2
             → truncated system prompt preview
```

**Delegation authority**:
```
Label:     text-xs text-muted-foreground font-medium
Chips:     RoleTagChip (see 3.2) for each allowed role
           If empty: text-xs text-muted-foreground italic → "Sub-agents only"
```

**Spawn authority**:
```
Chips:     RoleTagChip for each allowed agent type
Progress:  Budget bar (same pattern as existing budget progress bars)
           w-full h-2 bg-muted rounded-full overflow-hidden
           Inner: bg-primary rounded-full, width = (active/max)*100%
           Color thresholds: <60% green, 60-85% yellow, >85% red
Label:     text-xs text-muted-foreground → "{active}/{max} active ({remaining} remaining)"
```

**Active delegations list**:
```
Container: space-y-1 mt-2
Each row:  flex items-center gap-2 text-xs
           ├── Arrow icon: ArrowRight (outgoing) or ArrowLeft (incoming)
           │   Outgoing: text-muted-foreground
           │   Incoming: text-primary
           ├── Agent name: font-medium
           ├── Task title: text-muted-foreground truncate
           └── StatusBadge (small)
```

---

### 2.3 NewAgent Form Governance

**File**: `ui/src/pages/NewAgent.tsx`

#### Role picker enhancement

Replace the current flat role list in the Popover with grouped, described options:

```
PopoverContent: w-72 p-0
Each role option:
  Container: flex items-start gap-3 px-3 py-2 hover:bg-accent/50 cursor-pointer
             ├── AgentIcon (role icon, w-6 h-6 mt-0.5)
             ├── div
             │   ├── Role label: text-sm font-medium
             │   └── Description: text-xs text-muted-foreground line-clamp-2
             │       → "Translates goals into technical architecture"
             └── if disabled by spawn rules:
                 Lock icon + tooltip "Not allowed by {parent}'s spawn rules"
  Disabled:  opacity-50 pointer-events-none
  Selected:  bg-accent/30
```

#### Delegation style selector

New property chip in the chips row (next to Role and Reports To):

```tsx
<button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50">
  <GitBranch className="h-3 w-3" />
  {delegationStyleLabel}
</button>
```

Opens a Popover with 3 options, each with description:

```
directive:     "Do X exactly as I say" — Full oversight, specific instructions
collaborative: "Let's figure out how" — Shared context, mutual input
autonomous:    "Handle it your way"   — Minimal oversight, goal-driven
```

#### Spawn budget warning

When the parent agent's spawn budget is full, show below the form:

```
Container: flex items-center gap-2 px-4 py-2 rounded-md bg-amber-500/10 border border-amber-500/20
Icon:      AlertTriangle (h-4 w-4 text-amber-500)
Text:      text-xs text-amber-700 dark:text-amber-400
           → "{parent.name} has reached the maximum number of reports ({max})"
```

---

## 3. New Components

### 3.1 DelegationStyleBadge

**File**: `ui/src/components/DelegationStyleBadge.tsx`

A small inline badge showing the delegation style with semantic coloring.

```tsx
interface DelegationStyleBadgeProps {
  style: "directive" | "collaborative" | "autonomous";
  size?: "sm" | "md";
}
```

**Styling**:
```
Base:          inline-flex items-center rounded-full font-medium uppercase tracking-wide whitespace-nowrap
Size sm:       text-[10px] px-1.5 py-0.5
Size md:       text-xs px-2 py-0.5

directive:     bg-amber-500/10    text-amber-600    dark:text-amber-400
collaborative: bg-blue-500/10     text-blue-600     dark:text-blue-400
autonomous:    bg-emerald-500/10  text-emerald-600  dark:text-emerald-400
```

**Labels**: `D` (sm) / `directive` (md), `C` (sm) / `collaborative` (md), `A` (sm) / `autonomous` (md)

**Tooltip** (via Radix Tooltip): Shows the full word + one-line description on hover.

---

### 3.2 RoleTagChip

**File**: `ui/src/components/RoleTagChip.tsx`

An inline tag representing a role, used in delegation authority and spawn rules lists.

```tsx
interface RoleTagChipProps {
  role: AgentRole;
  removable?: boolean;
  onRemove?: () => void;
  variant?: "delegation" | "spawn";
}
```

**Styling**:
```
Base:       inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium
delegation: border-blue-500/30  bg-blue-500/10  text-blue-700 dark:text-blue-300
spawn:      border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300

Remove btn: ml-0.5 h-3 w-3 text-muted-foreground hover:text-foreground cursor-pointer (X icon)
```

**Content**: AGENT_ROLE_LABELS[role] (e.g., "Engineer", "CTO")

---

### 3.3 HierarchyEdgeLegend

**File**: `ui/src/components/HierarchyEdgeLegend.tsx`

Small legend for the org chart showing edge type meanings.

```tsx
// No props — always shows the same legend
```

**Layout**:
```
Container: flex items-center gap-4 text-[10px] text-muted-foreground
Item 1:    ── (solid 2px line sample) "Reports to"
Item 2:    ╌╌ (dashed 2px line sample, purple) "Delegates to"
```

Positioned bottom-left of the org chart SVG area:
```
absolute bottom-3 left-3 bg-background/80 backdrop-blur rounded-md border border-border px-2.5 py-1.5
```

---

### 3.4 AuthorityMatrix

**File**: `ui/src/components/AuthorityMatrix.tsx`

A compact table visualization of the full delegation authority matrix for all roles.

```tsx
interface AuthorityMatrixProps {
  roles: RoleDefinition[];
}
```

**Layout**: Table where rows = "from" roles, columns = "to" roles:

```
┌──────────┬─────┬─────┬─────┬──────┬──────────┐
│ From \ To│ CEO │ CTO │  PM │ Eng  │ Designer │
├──────────┼─────┼─────┼─────┼──────┼──────────┤
│ CEO      │  ·  │  ✓  │  ✓  │  ✓   │    ✓     │
│ CTO      │     │  ·  │  ✓  │  ✓   │    ✓     │
│ PM       │     │     │  ·  │  ✓   │    ✓     │
│ Engineer │     │     │     │  ·   │          │
│ Designer │     │     │     │      │    ·     │
└──────────┴─────┴─────┴─────┴──────┴──────────┘
```

**Styling**:
```
Table:       text-xs border border-border rounded-lg overflow-hidden
Header row:  bg-muted/50 text-muted-foreground font-medium
Header col:  bg-muted/50 text-muted-foreground font-medium text-right pr-2
Cell:        w-12 h-8 text-center
  Allowed:   text-emerald-500 → "✓"
  Self:      text-muted-foreground → "·"
  Blocked:   empty (leave blank, not "✗")
Hover:       bg-accent/30 on row+column highlight
```

---

### 3.5 SpawnBudgetBar

**File**: `ui/src/components/SpawnBudgetBar.tsx`

Progress bar showing spawn capacity usage.

```tsx
interface SpawnBudgetBarProps {
  active: number;
  max: number;
}
```

**Styling**:
```
Container:  flex items-center gap-2
Bar:        w-24 h-2 bg-muted rounded-full overflow-hidden
Inner:      h-full rounded-full transition-all duration-300
            <60%:  bg-emerald-500
            60-85%: bg-amber-500
            >85%:  bg-red-500
Label:      text-xs text-muted-foreground tabular-nums → "{active}/{max}"
```

---

## 4. Design Guide Page Additions

**File**: `ui/src/pages/DesignGuide.tsx`

Add a new `<Section title="Organization">` containing:

### SubSection: DelegationStyleBadge

Show all 3 styles in both sizes:
```tsx
<div className="flex items-center gap-3">
  <DelegationStyleBadge style="directive" size="sm" />
  <DelegationStyleBadge style="collaborative" size="sm" />
  <DelegationStyleBadge style="autonomous" size="sm" />
</div>
<div className="flex items-center gap-3">
  <DelegationStyleBadge style="directive" size="md" />
  <DelegationStyleBadge style="collaborative" size="md" />
  <DelegationStyleBadge style="autonomous" size="md" />
</div>
```

### SubSection: RoleTagChip

Show delegation and spawn variants with removable option:
```tsx
<div className="flex items-center gap-2 flex-wrap">
  <RoleTagChip role="ceo" variant="delegation" />
  <RoleTagChip role="cto" variant="delegation" />
  <RoleTagChip role="engineer" variant="spawn" />
  <RoleTagChip role="designer" variant="spawn" removable onRemove={() => {}} />
</div>
```

### SubSection: AuthorityMatrix

Show the full matrix with demo data matching the spec's canonical delegation rules.

### SubSection: SpawnBudgetBar

Show at different utilization levels:
```tsx
<SpawnBudgetBar active={2} max={10} />   {/* green */}
<SpawnBudgetBar active={7} max={10} />   {/* amber */}
<SpawnBudgetBar active={9} max={10} />   {/* red */}
<SpawnBudgetBar active={0} max={0} />    {/* empty — sub-agents only */}
```

### SubSection: Hierarchy Edge Legend

Show the legend component standalone.

### SubSection: Org Chart Edge Types

Side-by-side SVG samples showing:
- Solid line (reports_to): `stroke-width="2" stroke="var(--border)"`
- Dashed line (delegates_to): `stroke-width="1.5" stroke="var(--chart-1)" stroke-dasharray="6,4" opacity="0.6"`

---

## 5. Navigation Changes

### Sidebar

**File**: `ui/src/components/Sidebar.tsx` (or `SidebarSections.tsx`)

Add a new section group "Organization" with items:

```
Organization
├── Org Chart       → /org           (existing, Network icon)
├── Roles           → /roles         (new, Shield icon)
└── Proposals       → /hierarchy/proposals (new, GitPullRequest icon)
    └── if pendingCount > 0: show count dot (amber)
```

Pending count dot on "Proposals" nav item:
```
Positioned: absolute -top-0.5 -right-0.5
Size:       w-2 h-2 rounded-full bg-amber-500
```

### Breadcrumbs

```
/roles                    → Company > Roles
/roles/:slug              → Company > Roles > {RoleLabel}
/hierarchy/proposals      → Company > Hierarchy > Proposals
/hierarchy/proposals/:id  → Company > Hierarchy > Proposals > Proposal #{shortId}
```

### Routes

**File**: `ui/src/App.tsx`

```tsx
<Route path="roles" element={<RoleEditor />} />
<Route path="hierarchy/proposals" element={<HierarchyProposals />} />
```

---

## 6. Interaction Patterns

### Role Editor

| Action | Trigger | Behavior |
|--------|---------|----------|
| Expand/collapse role | Click header or chevron | Collapsible animation (existing shadcn pattern) |
| Edit system prompt | Type in textarea | Debounced, marks card as dirty |
| Add delegation target | Click `[+]` next to chips | Opens Popover with available roles |
| Remove delegation target | Click `×` on RoleTagChip | Removes from array, marks dirty |
| Change delegation style | Select dropdown | Updates immediately, marks dirty |
| Save | Click `[Save]` button | PUT to `/roles/:id`, toast on success |
| Reset to default | Click `[Reset]` | Confirmation dialog, then restores seed values |
| Add tool/skill | Click `[+]` after tags | Opens small text input popover, Enter adds |

### Hierarchy Proposals

| Action | Trigger | Behavior |
|--------|---------|----------|
| Switch tab | Click Pending/All | Filters list |
| Approve | Click `[Approve]` | PATCH status=approved, toast, refresh list |
| Approve & Activate | Click `[Approve & Activate]` | Approve then activate in sequence, show success dialog with link to org chart |
| Reject | Click `[Reject]` | Opens small dialog for rejection reason (required), then PATCH |
| View diff | Automatic | Mini org charts render on card mount |

### OrgChart Delegation Toggle

| Action | Trigger | Behavior |
|--------|---------|----------|
| Toggle delegation edges | Switch component | Shows/hides dashed delegation lines with 200ms fade transition |
| Hover delegation edge | Mouse over dashed line | Highlight source+target cards with `ring-2 ring-primary/30` |

### Agent Detail Authority

| Action | Trigger | Behavior |
|--------|---------|----------|
| Navigate to role editor | Click "Edit Role" link | Navigates to `/roles` with role pre-expanded |
| Click delegation target | Click RoleTagChip | Navigates to that agent's detail page |

---

## 7. Responsive Behavior

### Mobile (< md breakpoint)

**Role Editor**:
- Cards stack full-width
- System prompt textarea: min-h-[80px]
- Chips wrap naturally (flex-wrap already in place)

**Hierarchy Proposals**:
- Side-by-side org charts stack vertically: `grid grid-cols-1 md:grid-cols-2`
- Action buttons: full-width stacked `flex flex-col gap-2`

**OrgChart delegation toggle**:
- Move to bottom of chart area (above legend)
- Delegation edges hidden by default on mobile

**Agent Detail authority section**:
- Full-width, no changes needed (already vertical layout)

**NewAgent governance**:
- Role picker popover: full-width on mobile
- Spawn warning: full-width

### Keyboard

| Shortcut | Context | Action |
|----------|---------|--------|
| `r` | Org chart | Toggle delegation edges |
| `Enter` | Proposal card focused | Expand card |
| `a` | Proposal card focused | Approve |
| `Shift+a` | Proposal card focused | Approve & Activate |
| `Escape` | Role editor editing | Discard changes to current field |

---

## Component File Summary

| Component | File | New/Modified |
|-----------|------|--------------|
| `DelegationStyleBadge` | `ui/src/components/DelegationStyleBadge.tsx` | New |
| `RoleTagChip` | `ui/src/components/RoleTagChip.tsx` | New |
| `HierarchyEdgeLegend` | `ui/src/components/HierarchyEdgeLegend.tsx` | New |
| `AuthorityMatrix` | `ui/src/components/AuthorityMatrix.tsx` | New |
| `SpawnBudgetBar` | `ui/src/components/SpawnBudgetBar.tsx` | New |
| `RoleEditor` | `ui/src/pages/RoleEditor.tsx` | New |
| `HierarchyProposals` | `ui/src/pages/HierarchyProposals.tsx` | New |
| `OrgChart` | `ui/src/pages/OrgChart.tsx` | Modified |
| `AgentDetail` | `ui/src/pages/AgentDetail.tsx` | Modified |
| `NewAgent` | `ui/src/pages/NewAgent.tsx` | Modified |
| `DesignGuide` | `ui/src/pages/DesignGuide.tsx` | Modified |
| `Sidebar` | `ui/src/components/Sidebar.tsx` | Modified |
| API client | `ui/src/api/roles.ts` | New |
| API client | `ui/src/api/hierarchy.ts` | New |
