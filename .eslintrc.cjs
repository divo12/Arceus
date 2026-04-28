/**
 * ESLint config — currently a skeleton.
 *
 * The repo doesn't ship ESLint as a dev dependency yet; this file
 * exists so when ESLint is added, the silent-catch rule is already
 * configured and starts enforcing on day one. Until then the
 * `bun scripts/check-no-silent-catch.ts` script (wired as
 * `npm run lint:silent-catch`) covers the same ground.
 *
 * To activate:
 *   bun add -d eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
 *   bun x eslint .
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  rules: {
    /**
     * C2 audit — ban every form of silent error swallowing.
     *
     * Allowed alternatives (any of):
     *   - `swallowAndAudit(where, fn, ctx)` from `apps/api/src/observability/swallow.ts`
     *   - `swallowAndReport(where, fn, ctx)` (awaitable variant)
     *   - A re-thrown / propagated error
     *   - A catch followed by `// silent: <reason>` justification
     */
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='BlockStatement'][arguments.0.body.body.length=0]",
        message:
          "Bare `.catch(() => {})` is forbidden. Use `swallowAndAudit(where, fn, ctx)` or annotate with `// silent: <reason>`.",
      },
      {
        selector:
          "CallExpression[callee.property.name='catch'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='Identifier']",
        message:
          "Returning a literal from `.catch` swallows the error. Use `swallowAndAudit` or `swallowAndReport`.",
      },
      {
        selector:
          "CatchClause[body.body.length=0]",
        message:
          "Empty catch blocks hide failures. Either re-throw, log via observability.logEvent, or annotate with `// silent: <reason>`.",
      },
      {
        selector:
          "CallExpression[callee.property.name='catch'][arguments.0.type='MemberExpression'][arguments.0.object.name='console']",
        message:
          "`.catch(console.warn)` only surfaces failures to stdout. Use `swallowAndAudit` so the inspector + activity_log see the failure too.",
      },
    ],
  },
  ignorePatterns: [
    "dist/**",
    "node_modules/**",
    "**/*.test.ts",
    "**/*.e2e-test.ts",
    "apps/web/**",
    "apps/api/src/observability/swallow.ts",
    "scripts/check-no-silent-catch.ts",
  ],
};
