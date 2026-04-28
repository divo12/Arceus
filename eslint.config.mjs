/**
 * ESLint flat config — repo-wide.
 *
 * Scope (intentional)
 * ───────────────────
 * This config is conservative: it focuses on RULES that catch real
 * production bugs (the C2 silent-error patterns), not stylistic
 * preferences. Style is handled by Prettier (when added) and the
 * existing per-file conventions; ESLint only flags hazards.
 *
 * Pre-commit gate
 * ───────────────
 * `lint-staged` runs `eslint --fix` on staged TS/JS files via the
 * `.husky/pre-commit` hook. Run manually with:
 *   bun x eslint .         (or: npx eslint .)
 *
 * To opt out of a specific rule on one line, use:
 *   // eslint-disable-next-line no-restricted-syntax
 * The silent-catch rule additionally honours `// silent: <reason>`
 * — same convention as `scripts/check-no-silent-catch.ts`.
 */
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // ─── Ignore patterns ───────────────────────────────────────────
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "apps/web/.next/**",
      "apps/web/tsconfig.tsbuildinfo",
      // Generated drizzle migration metadata — not source we author.
      "packages/db/src/migrations/meta/**",
      // Test files have different swallow semantics; covered by separate
      // lint pass when tests are stabilised.
      "**/*.test.ts",
      "**/*.e2e-test.ts",
      // Frontend has different "graceful degradation" semantics for
      // .catch(() => null) on fetch; out of scope for this enforcement.
      "apps/web/**",
      // The helper itself defines the patterns being banned.
      "apps/api/src/observability/swallow.ts",
      // Generated test artefacts checked in by mistake.
      "**/dist/**",
    ],
  },

  // ─── TS files in production source ─────────────────────────────
  {
    files: [
      "apps/api/src/**/*.ts",
      "apps/api/src/**/*.tsx",
      "apps/tui/src/**/*.ts",
      "apps/tui/src/**/*.tsx",
      "packages/contracts/src/**/*.ts",
      "packages/db/src/**/*.ts",
      "packages/company-runtime/src/**/*.ts",
      "packages/hippocampus/src/**/*.ts",
      "packages/task-engine/src/**/*.ts",
      "packages/arceus-mcp/src/**/*.ts",
      ".opencode/**/*.ts",
    ],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        // No project-aware linting — we rely on `tsc --noEmit` for type
        // analysis. ESLint here is purely syntactic / pattern-matching.
        // Project-aware mode would be ~10× slower and gain us nothing
        // for the rules we enforce.
        project: null,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // ── C2 audit — ban silent error swallowing ─────────────────
      // Same patterns enforced by scripts/check-no-silent-catch.ts;
      // this rule duplicates the check at the AST level so editor
      // integrations (VS Code red squiggles) flag violations live.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='BlockStatement'][arguments.0.body.body.length=0]",
          message:
            "Bare `.catch(() => {})` is forbidden. Use `swallowAndAudit` from `apps/api/src/observability/swallow.ts`, or annotate with `// silent: <reason>`.",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='Literal'][arguments.0.body.value=null]",
          message:
            "`.catch(() => null)` swallows the error. Use `swallowAndReport` from observability/swallow.ts, or annotate with `// silent: <reason>`.",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='Identifier'][arguments.0.body.name='undefined']",
          message:
            "`.catch(() => undefined)` swallows the error. Use `swallowAndReport`, or annotate with `// silent: <reason>`.",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='MemberExpression'][arguments.0.object.name='console']",
          message:
            "`.catch(console.warn|error|log)` only surfaces failures to stdout. Use `swallowAndAudit` so the inspector + activity_log + OTel see them.",
        },
        {
          selector: "CatchClause[body.body.length=0]",
          message:
            "Empty catch block hides failures. Either re-throw, use `swallowAndAudit`, or annotate with `// silent: <reason>`.",
        },
      ],

      // ── Other safety rails (light touch) ───────────────────────
      // Don't allow accidental `console.log` in production runtime.
      // We have observability.logEvent for that.
      "no-console": [
        "warn",
        { allow: ["warn", "error", "info"] }, // these are still allowed; only `.log` warns
      ],

      // No `eval` / no `with` — universal hazards.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-with": "error",

      // No `var` — let / const only.
      "no-var": "error",
      "prefer-const": "warn",
    },
  },

  // ─── Scripts directory — looser rules (one-off ops) ────────────
  {
    files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Scripts can console.log — they're CLIs.
      "no-console": "off",
      // Scripts often need bare catches for cleanup blocks; this rule
      // is enforced strictly only on production source.
      "no-restricted-syntax": "off",
    },
  },
];
