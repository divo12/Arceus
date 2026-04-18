---
title: Next.js 15+ Best Practices (App Router era, 2026)
audience: Engineers shipping Next 15/16 on Vercel or OpenNext
---

# 03 · Next.js 15+ Best Practices (2026)

For Arceus's Next 15 web app. Confidence tags inline. Pin your Next minor — semantics shift between minors.

## 1. App Router mental model

- **Server Components are default; `"use client"` is an opt-in boundary** that bundles everything it imports into the client JS. Treat `"use client"` like `"use expensive"` — minimize, push down the tree, prefer passing server-rendered children as props. `[high confidence]`
- **`<Suspense>` + `loading.tsx` for streaming.** Wrap slow data-dependent subtrees so fast parts paint immediately. `error.tsx` catches render errors in that segment; `not-found.tsx` handles 404s.
- **Parallel routes (`@slot`) + intercepted routes (`(.)photo/[id]`)** enable modals-with-URLs, dashboards with independent loading states, tab UIs. Overused → nav nightmare. Limit to genuine split-view or modal-over-page cases.
- **Client bundle is the cost center.** One `"use client"` on a top-level layout pulls the whole subtree client-side. Audit with `next build --profile` + `@next/bundle-analyzer`.
- **Server → Client props must be serializable** (no functions, Dates survive, class instances don't). AI frequently writes props that silently break in production builds.
- **Route Handlers (`app/api/*/route.ts`)** for third-party webhooks, file uploads, non-React clients. For same-app mutations → Server Actions.

**Why it matters:** App Router's performance story only works if you internalize the server-default model. Fighting it produces worse results than Pages Router ever did.

## 2. Data fetching

- **`fetch()` in Server Components is deduped per-request** (request memoization). Add cache tags: `fetch(url, { next: { tags: ['posts'], revalidate: 60 } })`, then `revalidateTag('posts')` from a Server Action after mutation. `[high confidence]`
- **`unstable_cache`** (graduating to `cache`) wraps arbitrary async functions (e.g. Drizzle queries) with the same tag/revalidate semantics. Critical: `fetch` caching doesn't apply to DB drivers.
- **React's `cache()`** dedupes within a single render only — use for expensive pure functions called from multiple components in the same request (`getCurrentUser()`).
- **Don't fetch authenticated data in a cacheable Server Component.** Either opt the route into dynamic (`cookies()`/`headers()` forces it) or use `unstable_cache` with user-scoped keys. Leaking cached authenticated responses across users is the most common Next.js data bug.
- **Server Actions for mutations, Route Handlers for external callers.** Actions get progressive enhancement, origin-check CSRF protection, automatic revalidation.
- **After mutations: `revalidatePath('/dashboard')` or `revalidateTag('posts')`.** Without this, cached Server Component output stays stale.

**Why it matters:** Next's caches are powerful but silent — a misconfigured cache is invisible in dev and fatal in prod.

## 3. Partial Prerendering (PPR) + streaming SSR

- **PPR = static shell + dynamic holes.** Page prerendered at build; dynamic subtrees (wrapped in `<Suspense>` reading `cookies()`/`headers()`) stream at request. Enabled via `experimental.ppr = 'incremental'` + `export const experimental_ppr = true` per route. `[high confidence]`
- **Stability (early 2026):** PPR was still `experimental` in Next 15 through 15.x. Pin your version; verify status on nextjs.org/docs before relying on it. `[speculation on late-2026 status]`
- **Use PPR when a page has a genuine static shell with personalized islands** (marketing page with logged-in nav). Don't use for fully dynamic dashboards — just use full dynamic rendering with streaming Suspense.
- **Streaming SSR without PPR is stable**: wrap slow parts in Suspense, Next streams HTML chunks as they resolve. Node runtime works best; edge runtime more constrained.
- **PPR interacts with caching:** static shell lives in Full Route Cache; dynamic parts don't. Tag-based revalidation still invalidates the shell correctly.

**Why it matters:** PPR is the best TTFB primitive Next has shipped, but experimental = breaking changes. Pin your version.

## 4. Performance

- **Turbopack is stable for `next dev` (Next 15 GA)**; moving toward stable for `next build` (alpha → beta through 2025). `[speculation on exact build-stable release]`
- **`@next/bundle-analyzer` is the first tool** when first-load JS exceeds ~150 kB. Look for accidental server-code imports on the client (a Drizzle import in a `"use client"` file pulls `pg` polyfills).
- **`next/dynamic({ ssr: false })`** for heavy client-only widgets (charts, editors, maps). Pair with Suspense.
- **`next/image` checklist:** always set `sizes` for responsive; `priority` on LCP image; `fetchPriority="high"` above the fold; remote loader for third-party CDNs. Misconfigured `sizes` = #1 Lighthouse penalty.
- **`next/font`:** prefer local in 2026 (Google Fonts subsetting is fine, local via `next/font/local` avoids build-time network dep + better CI reproducibility). `display: 'swap'` is default.
- **Route segment config** (`export const dynamic`, `revalidate`, `fetchCache`, `runtime`) — **be explicit**. Implicit `'auto'` has caused production caching surprises across Next 13→14→15.
- **`generateStaticParams`** returns params to prerender at build; combined with `dynamicParams = true` gives ISR-like on-demand additions.

**Why it matters:** Next performance problems in 2026 are almost always "accidentally dynamic" or "accidentally client" — both visible in build output if you look.

## 5. Caching (Next 15's big shift)

- **Four caches, narrowest → widest:**
  1. **Request Memoization** — per-render (React `cache`/dedupe)
  2. **Data Cache** — persistent across requests, tag-invalidated
  3. **Full Route Cache** — prerendered HTML + RSC payload
  4. **Router Cache** — client-side navigation cache
- **Next 15 flipped defaults:** `fetch()` **no longer cached by default**; Route Handler `GET` **no longer cached by default**. Opt in with `cache: 'force-cache'` or `{ next: { revalidate } }`. Fixed a major footgun; broke many upgrades. `[high confidence]`
- **Tag-based invalidation scales.** Tag cached fetches/functions by entity (`['post', postId]`, `['user', userId, 'posts']`) so mutations invalidate precisely without nuking everything.
- **`revalidatePath` is coarser than `revalidateTag`** — invalidates all caches for a route. Prefer tags for surgical invalidation; paths for "I don't know which pages use this."
- **Stale-while-revalidate via `revalidate: N`**: serves stale on request N+1, triggers bg regen, returns fresh on N+2. Good for content that's fine slightly stale (blogs, product listings).
- **Router Cache gotchas:** client-side nav can show stale content up to 30s (dynamic) / 5min (static) by default. `router.refresh()` after Server Action mutations if you need immediate freshness across tabs.

**Why it matters:** Next's caches are your cheapest scale lever; they're also the biggest source of "works locally, broken in prod" bugs.

## 6. Server Actions

- **Server Actions > route handlers for same-app mutations.** Typed args, automatic revalidation integration, progressive enhancement (forms work without JS), origin-check CSRF protection. `[high confidence]`
- **Always validate + authorize inside the action.** Client-side call site is not a trust boundary. Zod/Valibot on line 1, re-check auth via `cookies()` — don't rely on a caller having already checked.
- **`useActionState` + `useFormStatus`** for form UX; **`useOptimistic`** for optimistic UI. React 19 APIs, stable in Next 15.
- **Serialization:** args and returns must be serializable (same rules as RSC props). No functions, no class instances. React 19 extended `Map`/`Set` support — verify per version.
- **CSRF:** Next checks `Origin` vs `Host` automatically for actions. Disable only with caution. Actions POST to the current route; if proxying through a CDN, preserve `Origin`.
- **Don't abuse actions for queries.** Actions are POSTs and uncached. Use to mutate + revalidate, not to fetch.

**Why it matters:** Server Actions are the Next team's bet for 2026+ — tRPC-style layers are increasingly redundant for same-app use.

## 7. Auth + middleware

- **Auth options in 2026:**
  - **Auth.js v5** (NextAuth renamed) — most flexible OSS, first-class App Router.
  - **Clerk** — best hosted DX with prebuilt components.
  - **Supabase Auth** — free with Supabase, native RLS integration.
  - **Better-Auth** — newer, type-first, framework-agnostic; gaining traction.
  - `[high confidence on options; speculation on 2026 market share]`
- **Middleware runs on Edge by default** — no Node APIs, no native modules (no `pg`, no `bcrypt`). Routing/redirects only; JWT verify with `jose` (Edge-compatible).
- **Next 15.2+ supports Node.js runtime in middleware (experimental)** — unlocks Drizzle/Supabase SDK, but runs every request; keep it lean.
- **Cookies in Server Components are read-only.** Only `cookies().set()` in Server Actions or Route Handlers. Most common 2024→2025 auth upgrade gotcha.
- **Auth guards in layouts** cascade to child pages but don't re-run on client navigations between siblings unless the layout re-renders — don't rely on layout-only checks for sensitive data. Add checks inside page Server Components too.
- **Supabase Auth specifically:** use `@supabase/ssr` (successor to `auth-helpers`); set cookies via server client; pair with RLS so the DB enforces authz even if app checks miss.

**Why it matters:** middleware looks like the right place for auth — it's actually wrong for anything that needs your DB.

## 8. Deployment

- **Vercel is the smoothest path** (PPR, ISR, image opt, observability native). Next features ship Vercel-first.
- **Self-host via `next start`** works fine for traditional deploys; `output: 'standalone'` = minimal Node bundle for Docker (~500 kB + your app vs full `node_modules`).
- **OpenNext** adapts Next for AWS Lambda / Cloudflare Workers with surprising feature parity (ISR, image opt, middleware). `@opennextjs/cloudflare` is the 2026 way to run Next on Workers.
- **Netlify's adapter** — reasonable, traditionally a half-step behind Vercel on new Next features.
- **Edge vs Node runtime:** Edge for globally distributed, stateless, DB-through-HTTP (Neon/Turso). Node for direct Postgres (Supabase with pool), filesystem access, heavy CPU.
- **ISR vs on-demand revalidation:** time-based (`revalidate: N`) vs event-based (`revalidateTag`/`revalidatePath` from actions or webhooks). Combine — time as safety net, events for freshness.
- **Observability:** Next supports OpenTelemetry via `@vercel/otel` or manual `instrumentation.ts`. Traces cover fetches, Server Actions, RSC renders.

**Why it matters:** portability is real — OpenNext means "Vercel or bust" is no longer true.

## 9. Testing

- **Playwright for e2e.** App Router streaming + Server Actions work naturally in a real browser. `page.route()` to mock network boundaries.
- **React Testing Library + Vitest** for component tests. Vitest beats Jest on ESM/TS ergonomics + watch speed. Next 15's Turbopack test integration is still evolving. `[speculation on late-2026 status]`
- **Server Components are hard to unit-test** (async + RSC-specific). Test the data layer they call with unit tests; test rendered output with Playwright.
- **Mocking Server Actions in unit tests:** import as plain async functions. In component tests, pass a mock prop or use MSW for the action POST endpoint.
- **Mock `fetch` via MSW** at the network layer — avoids coupling to Next cache internals; identical in Vitest and Playwright.

**Why it matters:** App Router testing strategy is "test the seams, not the framework" — trying to unit-test RSCs fights the tool.

---

## Top 8 Next.js practices for an AI-edited codebase

1. **Default to Server Components; require a comment on every `"use client"`** explaining why (form handlers, browser APIs, third-party client lib). AI client-ifies too much.
2. **Every Server Action starts with `const session = await requireUser()` + `const input = schema.parse(raw)`.** Codify with a `defineAction(schema, handler)` wrapper so the AI can't skip either.
3. **Ban direct `fetch` in components; require a `lib/data/*.ts` module** that sets cache tags and revalidation. Makes cache invalidation auditable in one place.
4. **Always set `export const dynamic`, `revalidate`, `runtime` explicitly** on route segments. No implicit `'auto'`.
5. **Typed `revalidateTag` constants.** Export `const TAGS = { post: (id: string) => ['post', id] as const }` and import — prevents AI from typoing tags that silently don't invalidate.
6. **No DB imports in middleware or `"use client"` files.** Lint rule (`no-restricted-imports`) keyed to your Drizzle/Supabase server module path.
7. **Server Action return types must be `{ ok: true; data } | { ok: false; error }`** — never `throw`. Makes `useActionState` pleasant; forces AI to handle error branches.
8. **Pin Next.js minor version; check release notes on upgrade.** Caching defaults and Server Action semantics shift between minors; AI-generated upgrades miss these.

---

## Applied to Arceus

| Arceus area | Rule from this file |
|---|---|
| `apps/web/app/` layouts + pages | §1 — Server default, justify every `"use client"` |
| Mutations (sprint approve/reject, task create) | §6 — Server Action + `defineAction` wrapper |
| Data fetches in server components | §2 — `lib/data/*.ts` module with typed cache tags |
| Cache invalidation after mutations | §5 — `revalidateTag(TAGS.sprint(sprintId))` not coarse `revalidatePath` |
| Middleware (auth check) | §7 — Edge-only; verify JWT with `jose`; DB reads go in layouts/pages |
| Streaming expensive dashboards | §3 — `<Suspense>` + `loading.tsx`; consider PPR for marketing pages only |
| Observability | §8 — `@vercel/otel` + `instrumentation.ts` + `traceparent` on outbound fetches |

## Key sources

- [Next.js docs — Server Components / Caching / Server Actions / Routing](https://nextjs.org/docs/app)
- [Next.js 15 release post](https://nextjs.org/blog/next-15)
- [Vercel — Partial Prerendering](https://vercel.com/blog/partial-prerendering-with-next-js-creating-a-new-default-rendering-model)
- [Vercel — Turbopack for builds](https://vercel.com/blog/turbopack-builds)
- [Auth.js docs](https://authjs.dev/) · [Supabase SSR auth guide](https://supabase.com/docs/guides/auth/server-side/nextjs)
- [OpenNext docs](https://open-next.js.org/) · [MSW](https://mswjs.io/) · [Playwright](https://playwright.dev/)
