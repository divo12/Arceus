/**
 * ESLint flat config — repo-wide.
 *
 * Strict + stylistic type-aware rules on everything that isn't
 * generated, vendored, or a test fixture. We accept the larger error
 * surface and burn it down rule-by-rule. CI's `lint` job is the gate.
 *
 * Two non-snippet additions:
 *   1. `projectService: true` instead of a single `project:` path —
 *      monorepo resolution. Without it, type-aware rules can't see
 *      source under apps/* and packages/* and silently degrade.
 *   2. `ignores` block — ESLint picks up dist/, node_modules/,
 *      apps/web/**, generated drizzle migration metadata, and test
 *      files otherwise.
 *
 * Silent-catch enforcement lives in `scripts/check-no-silent-catch.ts`
 * (pre-commit hook + CI). Not duplicated here.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "apps/web/**",
      // Generated drizzle migration metadata — not source we author.
      "packages/db/src/migrations/meta/**",
      // Test files have different swallow / type semantics.
      "**/*.test.ts",
      "**/*.e2e-test.ts",
      // The helper itself defines the patterns being banned elsewhere.
      "apps/api/src/observability/swallow.ts",
      // Config / build / one-off CLI files outside any tsconfig project.
      // Type-aware ESLint can't parse them and crashes per-file otherwise.
      "**/*.mjs",
      "**/*.cjs",
      "**/*.mts",
      "apps/api/server.js",
      "scripts/**",
      "apps/tui/scripts/**",
      "packages/arceus-mcp/bin/**",
      "packages/arceus-mcp/test/**",
      "packages/db/drizzle.config.ts",
      "docs/**",
      "workspace/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: false,
          allowNullish: false,
          allowRegExp: true,
        },
      ],
    },
  },
);
