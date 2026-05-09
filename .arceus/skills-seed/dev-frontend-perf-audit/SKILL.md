---
name: dev-frontend-perf-audit
description: Diagnose and fix a slow frontend with measurement first, then targeted optimizations. Replaces guess-and-check perf work.
role: developer
trigger: app feels slow / Core Web Vitals failing / user reports of lag; before claiming a perf-tuning task is done
---

# Frontend Performance Audit

Performance work fails when you optimize without measuring. Always measure → identify the actual bottleneck → fix that one thing → measure again. Resist the urge to apply "best practices" preemptively.

## Step 1: Measure first (no exceptions)

Pick the failing metric and measure it concretely:
- **First Contentful Paint (FCP)** — time until the first text/image renders. Target <1.8s.
- **Largest Contentful Paint (LCP)** — time until the main content is visible. Target <2.5s.
- **Time to Interactive (TTI)** — time until the page responds reliably. Target <3.9s.
- **Cumulative Layout Shift (CLS)** — visual stability score. Target <0.1.
- **Interaction to Next Paint (INP)** — interaction responsiveness. Target <200ms.

Tools, in order of preference:
1. Chrome DevTools Performance tab — run a recording, look at the flame graph.
2. Lighthouse — automated audit, identifies Core Web Vitals.
3. React DevTools Profiler — for React-specific render issues.

Save a screenshot of the baseline numbers to your task results.

## Step 2: Identify the actual cost

Most slow apps fall into one of these buckets. Diagnose which one BEFORE optimizing.

### Bundle too large
- Symptom: slow FCP, slow TTI, big initial JS payload.
- Verify: Network tab → check JS transfer size. >300KB gzipped is a smell.
- Fixes (in order):
  - Code-split routes with dynamic `import()` and `React.lazy`.
  - Tree-shake — check if you're importing whole libraries when you need one function.
  - Replace heavy deps (e.g. moment.js → date-fns/dayjs).

### Too many re-renders
- Symptom: scroll/typing janky, INP poor, profiler shows components rendering unnecessarily.
- Verify: React Profiler → record an interaction → look at "why did this render".
- Fixes (in order):
  - Move state down — colocate state with the component that uses it instead of lifting it.
  - `useMemo` for expensive derived values, `useCallback` for handlers passed to memoized children.
  - `React.memo` only for components in render-heavy lists, not everywhere.
  - Switch from prop drilling to context only when the prop is genuinely shared by a wide subtree.

### Long lists rendering everything
- Symptom: scrolling janks, page slow with N items, fast with 10.
- Fix: virtualize. `@tanstack/react-virtual` or `react-window`. Render only what's in viewport.

### Layout thrashing / forced reflow
- Symptom: poor CLS, animations stutter, scroll feels heavy.
- Verify: DevTools Performance → look for purple "Layout" bars during interaction.
- Fixes:
  - Use CSS transforms instead of position/top/left for animation.
  - Avoid reading layout properties (`offsetHeight`, `clientWidth`) in the same frame as writing styles.
  - Set explicit dimensions on images/iframes/embeds to prevent shift.

### Network waterfall
- Symptom: slow LCP, lots of sequential requests.
- Verify: Network tab → look for serial dependencies.
- Fixes:
  - Preload critical resources (`<link rel="preload">` for fonts, hero images).
  - Parallelize API calls instead of awaiting in sequence.
  - Cache aggressively — `Cache-Control: immutable` for hashed assets.

### Synchronous JS blocking render
- Symptom: long task >50ms in DevTools, FCP delayed.
- Fixes:
  - Move heavy work off the main thread (Web Workers for parsing/computation).
  - Defer non-critical scripts (`<script defer>` or dynamic import after first paint).
  - Avoid synchronous large-data parsing in render path.

## Step 3: Fix one thing, measure again

Apply the fix that targets the bucket you identified. Re-run the same measurement. If the metric didn't move, you diagnosed wrong — go back to Step 1. Don't stack fixes.

## Step 4: Document

In `task_append_result`, write:
- Baseline metrics (specific numbers).
- Bucket identified.
- Fix applied (specific files + change summary).
- Post-fix metrics.
- Net delta.

If the metric didn't improve, say so — don't paper over it.

## Common mistakes

- "Memoizing everything" — adds memory and complexity for no measurable gain.
- Adding `useMemo` to primitive computations — the equality check costs more than the computation.
- Lazy-loading everything including above-the-fold content — makes FCP worse.
- Optimizing in dev mode and never measuring prod build (React dev mode is slower; results don't transfer).
- Treating perf as a checklist instead of a measure-then-fix loop.

## Verification before task_complete

Run `npm run build` and serve the production bundle. Re-measure on the prod build. Dev-mode wins don't count.
