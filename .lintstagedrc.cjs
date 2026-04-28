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
 */
module.exports = {
  "**/*.{ts,tsx,js,jsx}": (filenames) => [
    `eslint --fix ${filenames.map((f) => `"${f}"`).join(" ")}`,
  ],
};
