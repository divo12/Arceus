---
title: TypeScript Best Practices (2026)
audience: Experienced TS engineers shipping AI-edited code
---

# 01 · TypeScript Best Practices (2026)

Dense digest for an experienced engineer on a TS/Next/Postgres stack where Claude/Cursor/Codex write most of the lines. Confidence tags inline.

## 1. Strict-mode config beyond `strict: true`

- **Turn on `noUncheckedIndexedAccess`.** Adds `| undefined` to every index/array access — the single highest-leverage flag not in `strict`. `[high confidence]` ([whatislove.dev — strictest tsconfig](https://whatislove.dev/articles/the-strictest-typescript-config/), [2ality — tsconfig guide, Jan 2025](https://2ality.com/2025/01/tsconfig-json.html))
- **`exactOptionalPropertyTypes`** distinguishes "missing" from "present-and-undefined" — catches real DTO-shape bugs. `[high confidence]` ([TS docs](https://www.typescriptlang.org/tsconfig/))
- **`noPropertyAccessFromIndexSignature`** forces `obj["dynamic"]` over `obj.dynamic` for non-declared keys. Blocks AI from silently inventing fields. `[high confidence]` ([Lucas Paganini — 20 flags](https://www.lucaspaganini.com/academy/20-typescript-compiler-options-for-your-tsconfig-json/))
- **`verbatimModuleSyntax`** replaces `importsNotUsedAsValues` / `preserveValueImports`. Required for Node native type-stripping. `import` stays; `import type` erases. `[high confidence]`
- **`isolatedDeclarations` (TS 5.5+)** forces explicit return types on public APIs → parallel `.d.ts` emission via `tshy`/`oxc`. Pair with `noEmit: true` in libs. `[high confidence]`
- **`erasableSyntaxOnly` (TS 5.8)** bans enums, namespaces, parameter properties — exactly what Node's `--experimental-strip-types` can't run. Turn on the moment you commit to Node ≥22.18. `[high confidence]` ([Matt Pocock — erasableSyntaxOnly](https://www.totaltypescript.com/erasable-syntax-only))
- **TypeScript 7 / Native Previews.** Microsoft's Go port ("Project Corsa") — ~10× faster builds, early-2026 GA. Preview today via `@typescript/native-preview`. TS 6.0 is the last JS-codebase release. `[high confidence]` ([A 10× Faster TypeScript](https://devblogs.microsoft.com/typescript/typescript-native-port/), [Progress on TS 7, Dec 2025](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/), [InfoWorld — early 2026](https://www.infoworld.com/article/4100582/microsoft-steers-native-port-of-typescript-to-early-2026-release.html))

**Why it matters:** these flags convert silent "string somewhere → undefined at runtime" bugs into compile errors — doubly useful when AI writes the code and misses subtle nullability.

## 2. Type design

- **Discriminated unions ≫ enums.** Enums have runtime semantics (banned by `erasableSyntaxOnly`); `type Kind = "a" | "b"` + object unions works with `never`-based exhaustiveness. `[high confidence]`
- **Branded types for IDs.** `type UserId = string & { readonly __brand: "UserId" }`. Free at runtime; prevents passing `ProjectId` where `UserId` belongs. `[high confidence]`
- **`satisfies` for config objects.** Validates shape against a type while preserving narrowest inferred literals. Essential for typed routes, Zod schemas, RHF defaults. `[high confidence]` ([Matt Pocock — satisfies clarified](https://www.totaltypescript.com/clarifying-the-satisfies-operator))
- **`const` type parameters (TS 5.0+)** preserve literal inference through generics without caller-side `as const`. Makes type-safe router/DSL APIs ergonomic.
- **`using` / `await using` (TS 5.2+)** for explicit resource management (DB tx, file handles, spans). Prefer over try/finally pyramids.
- **Template literal types for routes/events.** Hono and tRPC derive client types purely from server declarations — no codegen. `[high confidence]` ([Hono RPC](https://hono.dev/docs/guides/rpc))
- **Runtime schemas — pick by axis:**
  - **ArkType** ~3–100× faster than Zod, smallest wire; TS-literal DSL has learning curve.
  - **Valibot** best for client bundles (~1.4 kB for a login form vs Zod's 17.7 kB via tree-shaking).
  - **Zod v4** slower than v3 (~17× regressions reported) but biggest ecosystem, safest default.
  - **effect/schema** for Effect-style apps.
  - `[high confidence on perf/bundle; speculation on long-term winner]` ([Pockit — Zod vs Valibot vs ArkType 2026](https://pockit.tools/blog/zod-valibot-arktype-comparison-2026/), [Valibot comparison](https://valibot.dev/guides/comparison/), [dev.to — Zod v4 17× slower](https://dev.to/dzakh/zod-v4-17x-slower-and-why-you-should-care-1m1))

**Why it matters:** the type system is the primary spec. If it captures domain invariants (IDs can't swap, switches must exhaust), agents can't regress them silently.

## 3. Error handling

- **Never throw strings or untyped objects.** Always `Error` subclasses with `cause` chains (ES2022).
- **Narrow `unknown`, not `any`.** In catch blocks (`useUnknownInCatchVariables` is in `strict`), use `instanceof Error` or Zod to narrow. `[high confidence]` ([dev.to — Type Guards 2025](https://dev.to/paulthedev/type-guards-in-typescript-2025-next-level-type-safety-for-ai-era-developers-6me))
- **`Result<T, E>` via `neverthrow`** where failure is a first-class outcome (validation, external APIs). Forces callers to handle both arms; `ResultAsync` wraps `Promise<Result>`. `[high confidence]` ([neverthrow](https://github.com/supermacro/neverthrow), [solberg.is — Practically Safe TS](https://www.solberg.is/neverthrow))
- **Parse at every boundary with Zod/Valibot/ArkType.** API responses, `JSON.parse`, env vars, form input are all `unknown` → parsed → typed. "Parse, don't validate."
- **TC39 `try` operator is Stage 0** — `const [ok, err, val] = try someFn()`. Do not bet on it before 2027. `[high confidence]` ([proposal-try-operator](https://github.com/arthurfiorette/proposal-try-operator))
- **Structured logging**: serialize name, message, full `cause` chain, and any attached context. Never `err.toString()`.

**Why it matters:** `Result` + Zod at boundaries means a thrown exception is genuinely exceptional. Every AI edit either passes the parse+Result chain or doesn't compile.

## 4. Module boundaries

- **Barrel files (`index.ts`) are still harmful in most bundlers.** Vite's own docs say avoid; Turbopack/Rspack struggle with invalidation across barrels; HMR times of 5-10s on ~100-file apps are reported from barrels alone. `[high confidence]` ([Vite Performance docs](https://vite.dev/guide/performance), [webpack discussion #16863](https://github.com/webpack/webpack/discussions/16863))
  - Exception: **published library entry points** with `"sideEffects": false` guaranteed.
- **`verbatimModuleSyntax` + ESM everywhere.** Enforces disciplined `import type` usage; matches Node native runtime.
- **Monorepos: pnpm workspaces + TS project references + live types.** Point `exports` at `.ts` in dev, `.js` in prod via conditional resolution. Colin McDonnell's "live types" pattern kills composite-build wait. `[high confidence]` ([Colin McDonnell — Live types in a TS monorepo](https://colinhacks.com/essays/live-types-typescript-monorepo))
- **Build tool choice:**
  - Published packages: `tshy` (dual ESM/CJS, native `tsc`, `isolatedDeclarations`) or `tsup` (esbuild, simpler).
  - Apps: let Vite/Turbopack/Next bundle; `tsc --noEmit` for types only.
- **Turborepo for task orchestration, not TS.** TS project refs handle incremental type-checking; Turborepo caches `build`/`test`/`lint`.

**Why it matters:** barrel files are a prime place where AI silently explodes bundle size and breaks HMR.

## 5. Testing

- **Vitest is the default for new TS codebases.** Native ESM, shared Vite config, 4-10× faster than Jest in real-world migrations. Jest 30 (June 2025) narrowed the gap, but ESM is still uphill. `[high confidence]` ([Vitest comparisons](https://vitest.dev/guide/comparisons), [Better Stack — Vitest vs Jest](https://betterstack.com/community/guides/scaling-nodejs/vitest-vs-jest/))
- **Node's native runner for lightweight packages.** `node --experimental-strip-types` (default in Node ≥23.6, no-flag in ≥22.18, warning-free in 24.11+). Kills the `tsx`/`ts-node` tax for scripts and small tests. ([Node.js docs — Running TS natively](https://nodejs.org/learn/typescript/run-natively))
- **Mocking ESM: `vi.mock` + `vi.hoisted`** for static imports; dependency injection beats module mocking long-term.
- **`fast-check` property tests** for parsers, reducers, invariants. Runner-agnostic.
- **Snapshot tests sparingly.** AI agents auto-update snapshots → silent regressions. Require explicit `-u` review.
- **`test.each` > `expect.extend`** for behavior variation; custom matchers for domain-level assertions only.

**Why it matters:** fast tests close the AI loop — agent writes code, tests run in ~1s, agent iterates.

## 6. Code quality automation

- **ESLint 9 flat config is table stakes.** Single `eslint.config.js`/`.ts`; compose plugins as arrays; `.eslintrc` is dead. `[high confidence]` ([typescript-eslint docs](https://typescript-eslint.io/packages/typescript-eslint/))
- **Type-aware rules that actually catch bugs:**
  - `@typescript-eslint/no-floating-promises` — missing `await`, unhandled rejections
  - `@typescript-eslint/no-misused-promises` — `Promise` passed to non-async callback
  - `@typescript-eslint/switch-exhaustiveness-check` — discriminated-union coverage at the linter
  - `@typescript-eslint/prefer-nullish-coalescing` + `prefer-optional-chain`
  - `@typescript-eslint/no-unnecessary-condition` (shines with `noUncheckedIndexedAccess`)
- **Biome 2.x vs Oxlint 1.x.**
  - Biome = format+lint combined, ~85% of typescript-eslint's type-aware coverage, production-ready.
  - Oxlint = fastest (~50-100× ESLint); type-aware rules stabilized late 2025 / early 2026.
  - Pragmatic setup: `oxlint` in pre-commit for speed; `eslint` in CI for full type-aware coverage. `[high confidence]` ([InfoQ — Oxlint v1.0](https://www.infoq.com/news/2025/08/oxlint-v1-released/), [solberg.is — fast type-aware linting](https://www.solberg.is/fast-type-aware-linting))
- **`tsc --noEmit` in CI, always.** Lint ≠ substitute; some diagnostics only exist at full-program check time.
- **`knip` for dead code.** Replaces `ts-prune` (maintenance mode). Unused exports/files/deps. Vercel removed ~300k LOC with it. `[high confidence]` ([knip.dev](https://knip.dev/), [Effective TypeScript — Use knip](https://effectivetypescript.com/2023/07/29/knip/))
- **`dprint`** for polyglot formatting if Biome doesn't cover a file type.

**Why it matters:** AI agents routinely leave dead code and floating promises; automation catches both before review.

## 7. Compiler performance

- **TS 7 (Native Previews) is the real fix.** 10× type-check speedup; parallel project builds. Preview now via `@typescript/native-preview`; GA "early 2026." `[high confidence]` ([microsoft/typescript-go](https://github.com/microsoft/typescript-go))
- **Project references + `composite: true`** cut cold type-check proportionally to graph fan-out. Essential above ~5 packages. `[high confidence]` ([TS Performance wiki](https://github.com/microsoft/TypeScript/wiki/Performance))
- **`incremental: true` + `tsBuildInfoFile`** caches last good check; pair with CI cache keyed on `pnpm-lock.yaml` + tsconfig hashes.
- **`skipLibCheck: true`** stays the right default — rechecking `node_modules` `.d.ts` is pure cost.
- **Profile with `--extendedDiagnostics` then `--generateTrace`.** Feed trace into `@typescript/analyze-trace` or Chrome tracing. Common hotspots: recursive conditional types, giant inferred Zod/Drizzle unions, ts-morph codegen. Break them with explicit return types.

**Why it matters:** slow `tsc` slows the whole AI loop. Project refs today, TS 7 soon.

## 8. Null safety + exhaustiveness

- **`assertNever` at every switch default.** `function assertNever(x: never): never { throw … }`. New variant → compile error everywhere. `[high confidence]` ([FullStory — Discriminated Unions + Exhaustiveness](https://www.fullstory.com/blog/discriminated-unions-and-exhaustiveness-checking-in-typescript/))
- **`satisfies never` (TS 4.9+)** — same guarantee without a helper call; idiomatic in library code where throwing is wrong.
- **ESLint `switch-exhaustiveness-check`** as belt-and-suspenders for devs omitting `default:`.
- **`as const` literals everywhere** — object/array literals become readonly tuples of literal types, unlocking discriminated unions and template-literal inference.
- **Ban `any`; prefer `unknown` + parse.** `@typescript-eslint/no-explicit-any` + `no-unsafe-*` family. `any` is the #1 AI-generated code smell. `[high confidence]`
- **Branded/tagged types at domain boundaries.** Combine with `assertNever` + Zod `.brand()` for parse-level guarantees propagating through the type system.

**Why it matters:** cheapest way to make a refactor safe is to make "add a case" a compile error.

---

## Top 10 practices for an AI-edited codebase

A 2025 study found **~94% of LLM TS compilation errors are type-check failures** — the model guessed a type. Stricter types don't just catch bugs, they steer the agent ([Builder.io — TS vs JS](https://www.builder.io/blog/typescript-vs-javascript), [pm.dartus.fr — Unexpected Benefits of TS with AI](https://pm.dartus.fr/posts/2025/typescript-ai-aided-development/)).

1. **Full strict suite.** `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noPropertyAccessFromIndexSignature` + `verbatimModuleSyntax` + `erasableSyntaxOnly`. Each flag blocks a class of AI guesswork.
2. **Ban `any` (lint error); push `unknown` → parse.** Zod/Valibot/ArkType at every boundary; force agents to reach for a schema instead of `any`.
3. **Branded IDs + domain types.** Prevent the "swapped argument" bug class AI commits routinely.
4. **`Result` / `neverthrow` for fallible operations.** Missing error paths become compile errors.
5. **Exhaustive `switch` via `assertNever` or `satisfies never`.** New arm → compile error in every switch the agent touches.
6. **No new barrel files in app code.** Refuse any PR that adds a new `index.ts` without justification.
7. **`isolatedDeclarations` on library packages.** Explicit return types = inline documentation for the next agent.
8. **Type-aware ESLint + `tsc --noEmit` + `knip` in CI, always.** Catches floating promises and dead code the agent forgets to clean up.
9. **Vitest + `fast-check` for pure logic.** Fast loop the agent can run itself; property tests catch edge cases the agent didn't imagine.
10. **Small files (≤400 lines) + explicit public API.** Agents reason best with focused files and named exports.

---

## Applied to Arceus (quick map)

| Arceus area | Rule from this file |
|---|---|
| `packages/contracts/src/` (Zod schemas) | §2 — schema choice, branded IDs, `satisfies` for routes |
| `apps/api/src/orchestrator.ts` error paths | §3 — `Result`-typed return shape; narrow `unknown` |
| `packages/company-runtime/src/skill-*.ts` switches | §8 — `assertNever` at every default |
| `packages/db` migrations | §2 — Zod-parse DB row shape at boundary |
| `apps/api/` root tsconfig | §1 — add the full strict suite if not yet; migrate to project refs |
| CI | §6 — Oxlint pre-commit + ESLint type-aware in CI + knip + `tsc --noEmit` |
| Hot paths with giant inferred types | §7 — add explicit return types; enable `isolatedDeclarations` on `packages/*` |

## Key sources (read in full during research)

- [Microsoft — A 10× Faster TypeScript](https://devblogs.microsoft.com/typescript/typescript-native-port/)
- [Progress on TypeScript 7, Dec 2025](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)
- [Matt Pocock — erasableSyntaxOnly](https://www.totaltypescript.com/erasable-syntax-only) · [satisfies clarified](https://www.totaltypescript.com/clarifying-the-satisfies-operator)
- [Effective TypeScript — Year in Review 2025](https://effectivetypescript.com/2025/12/19/ts-2025/)
- [2ality — tsconfig.json guide, Jan 2025](https://2ality.com/2025/01/tsconfig-json.html)
- [Pockit — Zod vs Valibot vs ArkType 2026](https://pockit.tools/blog/zod-valibot-arktype-comparison-2026/)
- [typescript-eslint docs](https://typescript-eslint.io/packages/typescript-eslint/) · [Knip](https://knip.dev/)
- [Node.js — Running TypeScript Natively](https://nodejs.org/learn/typescript/run-natively)
- [Colin McDonnell — Live types in a TS monorepo](https://colinhacks.com/essays/live-types-typescript-monorepo)
