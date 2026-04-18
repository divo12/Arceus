---
title: Software Engineering Practices — Research Folder
generated: 2026-04-19
stack: TypeScript / Next.js 15+ / PostgreSQL 16+ / Supabase / Drizzle / AI-heavy
audience: Experienced engineers shipping Arceus (AI-agent platform)
confidence: high on practices; mixed on 2026 specifics (tagged inline)
---

# Software Engineering Practices — 2026 Research Folder

Dense, cited research on how to build a modern TypeScript + Next.js + Postgres product in 2026 when **AI does most of the typing** (Claude Code, Cursor, Codex, custom agents via MCP).

Written for Arceus-shaped teams: small, AI-heavy, trunk-based, Postgres-backed, agent-centric.

## Files

| # | File | Covers |
|---|---|---|
| - | [`README.md`](README.md) | Index + top rules + sequencing |
| 1 | [`01-typescript.md`](01-typescript.md) | Strict tsconfig 2026, type design, runtime schemas (Zod vs Valibot vs ArkType), error handling (`Result`/`neverthrow`), ESLint 9 flat, Vitest, TS 7 / Native Previews |
| 2 | [`02-postgres.md`](02-postgres.md) | Schema design for PG 16/17/18, indexing, concurrency (CAS + advisory locks + SKIP LOCKED), RLS, zero-downtime migrations with pgroll/Drizzle, backups + observability |
| 3 | [`03-nextjs.md`](03-nextjs.md) | App Router mental model, Server Actions, the four caches (Next 15 default flip), PPR, middleware limits, Vercel vs OpenNext |
| 4 | [`04-system-design.md`](04-system-design.md) | DDD-lite, 12-factor (what still holds), API design (REST/tRPC/gRPC), idempotency + CAS, scalability patterns, observability (SLIs/OTel), security (OWASP 2025) |
| 5 | [`05-product-engineering.md`](05-product-engineering.md) | Shape Up, scope hammering, trunk + feature flags, ADRs + C4 + Diátaxis, RFC culture, measurement before launch |
| 6 | [`06-ai-tooling-leverage.md`](06-ai-tooling-leverage.md) | **Crown file.** Claude Code / Cursor / Codex / Aider / MCP / evals / context engineering / safety rails — and the 2026 synthesis |

Read `06-ai-tooling-leverage.md` first if short on time.

---

## TL;DR — the 2026 stack for Arceus-shaped teams

**Deterministic infra under stochastic tooling.** That one sentence captures the discipline. Agents are fast and wrong in novel ways; the ground under them has to be boring and correct.

**Base layer (the ground):**
- PostgreSQL 17+ with `timestamptz` everywhere, `bigint generated always as identity` or UUID v7 for IDs, JSONB only for sparse/audit payloads, RLS enabled with `FORCE ROW LEVEL SECURITY` and `(select auth.uid())` pattern for Supabase.
- TypeScript with the full strict suite (`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `erasableSyntaxOnly` when on Node ≥22.18). `any` is a lint error; `unknown` at every boundary with Zod/Valibot parsing.
- Next.js 15+ with App Router — Server Components default, `"use client"` requires a justification comment, Server Actions for same-app mutations, tag-based `revalidateTag` for cache invalidation.
- Drizzle ORM + typed migrations; `pgroll` or Drizzle's custom SQL for zero-downtime expand/contract schema changes.

**Reliability layer:**
- Idempotency-Key on every non-GET; `If-Match`/version ETag on every mutation (compound CAS like Paperclip's checkout).
- Transactional outbox for reliable events; queue-backed async work with idempotent consumers; circuit breakers around LLM providers.
- OpenTelemetry for logs+metrics+traces; SLIs/SLOs/error budgets on user-visible outcomes (not infra metrics).
- OWASP Top 10:2025 + MCP security hygiene (SSRF egress filtering, no token passthrough, scoped least-privilege tokens).

**Team layer:**
- Trunk-based development. PRs ≤ 400 LOC. Feature flags (GrowthBook / LaunchDarkly / Vercel Flags) with kill switches on every new agent behavior.
- ADRs in `docs/adr/NNNN-*.md`, C4 diagrams lightweight, Diátaxis-split reference docs.
- Shape Up appetite + scope hammering — AI multiplies output; Shape Up keeps scope sane.

**AI layer:**
- **Claude Code**: CLAUDE.md = policy, Skills = procedures, Hooks = deterministic laws (lint/type-check/secret-scan on PostToolUse).
- **Cursor**: `.cursor/rules/*.mdc`, Agent mode for well-scoped edits, MCP-exposed infra.
- **MCP servers** as the bridge between agents and everything (DB, Sentry, flags, Arceus internals). Read-only in prod, staging-only for writes, human-approved deploys.
- **Eval-driven development**: Promptfoo in-repo + Braintrust in CI. Every prompt change ships with an eval diff. Evals are the new tests for prompts + agents.
- **AI-first PR review** (Graphite Agent / Copilot Review / `claude-code review`) triages; humans own merge.

---

## Top 12 non-obvious rules for an AI-heavy team in 2026

From combined research; each rule is defended in the deeper files.

1. **CLAUDE.md is policy, Skills are procedures, Hooks are laws.** If it must happen every time, it's a hook, not a prompt rule (~80% compliance on rules; 100% on hooks). [`06`]
2. **Idempotency-Key on every POST, `If-Match` ETag on every mutation.** Agents retry more than humans; without both you corrupt state. [`04`]
3. **Expose infra via MCP once, consume everywhere — but read-only in prod.** MCP servers must never accept passed-through tokens. SSRF-block RFC1918 + cloud metadata ranges. [`06`]
4. **Evals ship with every prompt change.** Promptfoo YAML in-repo + CI gate. Treat prompt edits like DB migrations. [`06`]
5. **PR size cap ≈ 400 lines.** AI happily writes 2000; humans (and AI reviewers) degrade. [`05`]
6. **Subagents → `/compact` → `/clear` → restart.** Escalate; don't guess. Match the context-engineering lever to the problem. [`06`]
7. **Feature-flag every new agent behavior with a kill switch.** Agents regress in ways unit tests miss; flags let you disarm without a deploy. [`05`, `06`]
8. **Tool descriptions are attack surface.** Validate MCP server metadata client-side; treat tool results as untrusted user content. [`06`]
9. **Staging is AI-accessible; production is not.** Prod MCP = read-only + scoped. Destructive ops need human-in-the-loop. [`06`]
10. **Block RFC1918 + `169.254.0.0/16` on every server-side fetch.** Cloud-metadata exfil is the default agent SSRF payload. [`04`, `06`]
11. **Shape Up your AI scope.** Fixed appetite, variable scope, hammer aggressively. AI velocity + uncapped scope ships features nobody asked for. [`05`]
12. **Docs are agent context.** Every ADR, README, Diátaxis page doubles as input for the next Claude session. The team with the best docs now has the best agents. [`05`]

---

## Non-obvious rules for an AI-edited TypeScript codebase

From `01-typescript.md` §Top 10 — TS-specific additions to the list above:

- **Full strict-mode suite** (not just `strict: true`). `noUncheckedIndexedAccess` alone blocks a whole class of AI guesswork.
- **Branded IDs.** Prevents "swapped argument" bugs AI commits routinely.
- **`Result` / `neverthrow` for fallible ops.** Makes missing error paths a compile error.
- **Exhaustive switches via `assertNever` or `satisfies never`.** New enum arm = new compile error in every switch the agent has to touch.
- **No new barrel files** — bundlers still hate them, and agents love them. Lint-rule the pattern.
- **`isolatedDeclarations` on library packages.** Forces explicit return types — inline documentation for the next agent.
- **Vitest + `fast-check` for pure logic.** Fast feedback loops the agent can run itself.

## Non-obvious rules for Postgres under AI

From `02-postgres.md` §Top 8 — PG-specific:

- **Pin types in the schema DSL.** Never let AI scaffold `timestamp` without `withTimezone: true`.
- **Every table gets `id`, `created_at timestamptz default now()`, `updated_at` trigger, RLS enabled.** Codify in a Drizzle helper.
- **Partial index on `deleted_at IS NULL` whenever soft-delete exists.** Add a lint rule.
- **Require `EXPLAIN` output in PRs** that add queries reading > 1000 rows. Reviewer verifies no `Seq Scan` on large tables.
- **Never `SELECT *` in server code.** AI-added columns silently leak into API responses.
- **Ban `DROP COLUMN` in generated migrations** without a human `// reviewed-destructive` marker.

## Non-obvious rules for Next.js under AI

From `03-nextjs.md` §Top 8 — Next-specific:

- **Default Server; require a comment on every `"use client"`.** AI client-ifies too eagerly.
- **Every Server Action starts with `requireUser()` + `schema.parse(raw)`.** Codify with a `defineAction` wrapper.
- **All fetches go through `lib/data/*.ts`** with explicit cache tags.
- **Always set `export const dynamic/revalidate/runtime`** — no implicit `'auto'`.
- **Typed `revalidateTag` constants** — prevents AI from typoing tags that silently don't invalidate.
- **Server Action return types are `{ ok: true, data } | { ok: false, error }`** — never throw.

---

## Sequencing — what to adopt first

Priority order for an Arceus-shaped team starting from scratch (weeks are rough):

| Week | Focus | Source files |
|---|---|---|
| 1 | tsconfig flags (all strict), Biome/Oxlint config, `typescript-eslint` type-aware rules, Vitest setup | `01` |
| 1-2 | PG schema conventions (timestamptz, UUID v7 or identity, RLS enabled by default, partial-index pattern) | `02` |
| 2 | Next.js conventions (`defineAction` wrapper, `lib/data/*.ts`, explicit route segment config, typed tags) | `03` |
| 3 | Idempotency-Key middleware, CAS checkout pattern, OpenTelemetry with `traceparent` propagation | `04` |
| 3-4 | CLAUDE.md + Skills + Hooks (PostToolUse: lint + type-check + secret-scan); Cursor `.cursor/rules/*.mdc` | `06` |
| 4 | MCP servers for infra (Postgres RO, Sentry, flag state, internal sprint API); eval-first prompt changes | `06` |
| 5+ | Trunk + flags, ADRs in repo, C4 overview diagram, SLIs published, error budget alerts | `05` |

Each row is a shippable PR. Do not skip weeks 1-2 — the later practices depend on a strict type-safe base.

---

## Methodology

Three parallel research agents (Apr 2026): one for TypeScript, one for Postgres + Next.js, one for system design + AI tooling. Every claim carries `[high confidence]` or `[speculation]` inline, and primary-source URLs. The three digests are the source material for files 01-06.

Agent 2 (PG + Next) operated from training-cutoff knowledge without live web access; Agents 1 and 3 did full WebSearch/WebFetch research with 2025-2026 primary sources (Microsoft TypeScript blog, Anthropic engineering blog, MCP security spec, OWASP, Basecamp, Google SRE Workbook, Vercel docs, Next.js docs, Supabase docs).

Gaps acknowledged:
- Exact TS 7 GA date is "early 2026" per Microsoft — treat any claim requiring TS 7 features as provisional.
- Next 16 / PPR stability status may have shifted; pin your Next version and check the release notes.
- PG 18 exact feature list may have changed; cross-reference with release notes when planning migrations.
