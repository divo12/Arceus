/**
 * lint-staged config — runs eslint --fix on staged TS/TSX/JS/JSX files.
 *
 * Why no `tsc --noEmit` here: TypeScript needs the full project graph
 * to detect type errors accurately; running it on isolated files
 * produces both false positives (missing imports across files) and
 * false negatives. The pre-commit hook runs the workspace-wide
 * typecheck as a separate step.
 *
 * Why no Prettier: not installed at the repo level. If you add it
 * later, add a `**\/*.{json,md,yaml}` entry that runs `prettier --write`.
 *
 * Why `|| true` on the eslint invocation:
 *   The new strict + stylistic type-aware ESLint config surfaced ~861
 *   pre-existing errors across the codebase. Fixing them is a separate,
 *   incremental effort. Until that backlog hits 0, pre-commit
 *   auto-fixes what it can and prints remaining issues without
 *   blocking the commit. CI's `lint` job remains the strict gate.
 *
 *   Once the error count reaches 0, drop the `|| true` so pre-commit
 *   hard-fails on regressions.
 *
 *   The MUST-NEVER-REGRESS rules (silent catches, type errors, schema
 *   drift) are enforced by separate pre-commit steps that stay strict.
 */
module.exports = {
  "**/*.{ts,tsx,js,jsx}": (filenames) => {
    const files = filenames.map((f) => `"${f}"`).join(" ");
    return [`bash -c 'eslint --fix ${files} || true'`];
  },
};
