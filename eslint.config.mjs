/**
 * ESLint flat config — repo-wide.
 *
 * Two-tier setup
 * ──────────────
 *   - Layer 1 (always on): silent-catch ban + safety rails (no-eval, etc.)
 *     Cheap, syntactic, runs in <1s.
 *   - Layer 2 (type-aware): strict + stylistic rules from typescript-eslint
 *     plus a curated set of bug-catching rules (no-floating-promises,
 *     no-misused-promises, await-thenable, require-await). Loads the TS
 *     program — costs ~5–10s per workspace but catches whole classes of
 *     async bugs the syntactic rules can't see.
 *
 * Pre-commit gate
 * ───────────────
 * `lint-staged` runs `eslint --fix` on staged TS/JS files via the
 * `.husky/pre-commit` hook. Run manually with:
 *   bun x eslint .         (or: npx eslint .)
 *   bun x eslint . --fix   (apply auto-fixes for the ~200 fixable rules)
 *
 * To opt out of a specific rule on one line, use:
 *   // eslint-disable-next-line no-restricted-syntax -- <reason>
 * The silent-catch grep script (`scripts/check-no-silent-catch.ts`)
 * additionally honours `// silent: <reason>` — its scope is narrower
 * (only bare swallows) so the two checks stack rather than overlap.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const PRODUCTION_FILES = [
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
];

export default tseslint.config(
  // ─── Ignore patterns ───────────────────────────────────────────
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "apps/web/**",
      "apps/web/tsconfig.tsbuildinfo",
      // Generated drizzle migration metadata — not source we author.
      "packages/db/src/migrations/meta/**",
      // Test files have different swallow / type semantics; covered by a
      // separate lint pass when tests are stabilised.
      "**/*.test.ts",
      "**/*.e2e-test.ts",
      // The helper itself defines the patterns being banned.
      "apps/api/src/observability/swallow.ts",
      // Generated test artefacts checked in by mistake.
      "**/dist/**",
      // Config files.
      "eslint.config.mjs",
    ],
  },

  // ─── Base layer: ESLint recommended ────────────────────────────
  js.configs.recommended,

  // ─── Type-aware strict + stylistic from typescript-eslint ──────
  ...tseslint.configs.strictTypeChecked.map((c) => ({
    ...c,
    files: PRODUCTION_FILES,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((c) => ({
    ...c,
    files: PRODUCTION_FILES,
  })),

  // ─── Production source — type-aware parser config + rule overrides ─
  {
    files: PRODUCTION_FILES,
    languageOptions: {
      parserOptions: {
        // projectService = monorepo-aware auto-detection of the nearest
        // tsconfig.json. Without this, type-aware rules can't load the
        // TS program and silently degrade to syntactic-only checks.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── C2 audit — ban silent error swallowing ─────────────────
      // Same patterns as `scripts/check-no-silent-catch.ts`; this
      // duplicates the check at the AST level so editor integrations
      // (VS Code red squiggles) flag violations live.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='BlockStatement'][arguments.0.body.body.length=0]",
          message:
            "Bare `.catch(() => {})` is forbidden. Use `swallowAndAudit` from `apps/api/src/observability/swallow.ts`, or annotate with `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='Literal'][arguments.0.body.value=null]",
          message:
            "`.catch(() => null)` swallows the error. Use `swallowAndReport` from observability/swallow.ts.",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='Identifier'][arguments.0.body.name='undefined']",
          message:
            "`.catch(() => undefined)` swallows the error. Use `swallowAndReport`.",
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
            "Empty catch block hides failures. Either re-throw, use `swallowAndAudit`, or annotate with `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
      ],

      // ── Other safety rails ─────────────────────────────────────
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-with": "error",
      "no-var": "error",
      "prefer-const": "warn",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],

      // ── Type-aware rule overrides ──────────────────────────────
      // The strict tier flags `${num}` and `${bool}` interpolations,
      // which produce 333+ violations on this codebase with low signal
      // (they all coerce predictably). Allow numbers and booleans;
      // keep the rule active for `unknown` / `any` / objects.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: false,
          allowAny: false,
          allowRegExp: true,
          allowNever: true,
        },
      ],

      // The strict tier flags every `if (x)` where `x` is provably
      // truthy/falsy at type level. On this codebase, ~200 hits are
      // legacy defensive checks (`if (!company) return;` where company
      // is typed as non-null but historically could be). Demote to
      // warning — they're worth seeing in the editor but shouldn't
      // block merges until the broader type cleanup lands.
      "@typescript-eslint/no-unnecessary-condition": "warn",

      // Same reasoning — ~74 legitimate `!.` assertions in legacy code.
      // Worth flagging in the editor but not blocking. The `// silent:`
      // / `swallowAndAudit` migration is the higher-value fix.
      "@typescript-eslint/no-non-null-assertion": "warn",

      // The strict tier requires explicit `: undefined` returns vs
      // implicit. Way too noisy for the value.
      "@typescript-eslint/no-confusing-void-expression": "warn",

      // Stylistic-only — let auto-fix handle it but don't block.
      "@typescript-eslint/array-type": "warn",
      "@typescript-eslint/consistent-type-definitions": "warn",
    },
  },

  // ─── Scripts directory — looser rules (one-off CLIs) ───────────
  {
    files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
);
