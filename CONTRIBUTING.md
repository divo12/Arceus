# Contributing to Arceus

First off — thank you. Arceus is an ambitious project (an autonomous AI software company), and it gets better with every thoughtful contribution. This guide gets you from clone to merged PR.

- 🐛 **Found a bug?** [Open an issue](https://github.com/divo12/Arceus/issues/new) with steps to reproduce.
- 💡 **Have an idea?** Start a [discussion](https://github.com/divo12/Arceus/discussions) or an issue before large work, so we can align on direction.
- 📝 **Docs, tests, small fixes?** Jump straight to a PR.

By participating, you agree to keep this a respectful, harassment-free space for everyone.

---

## Getting started

You'll need **Node.js ≥ 22.12**, **npm ≥ 9**, **PostgreSQL 16+ with `pgvector`**, and an **Azure OpenAI** deployment. Full setup lives in the [README Quickstart](README.md#-quickstart).

```bash
git clone https://github.com/divo12/Arceus.git
cd Arceus
npm install
cp .env.example .env.local     # fill in Azure OpenAI + Postgres
npm run db:generate && npm run db:migrate
npm run dev                    # API :4000 + web :3000
```

Recommended (used by scripts, tests, and the pre-commit hook):

```bash
# bun — runs scripts & tests
curl -fsSL https://bun.sh/install | bash
# gitleaks — local secret scan on commit
brew install gitleaks          # or see github.com/gitleaks/gitleaks
```

New to the codebase? Skim the [Architecture](README.md#-architecture) section and `docs/core-design-principles.md` — the repo-wide principles that shape schema, orchestration, and runtime decisions.

---

## Development workflow

1. **Branch off `main`.** Use a descriptive name: `feat/sprint-retry`, `fix/heartbeat-stall`, `docs/deploy-guide`.
2. **Make focused changes.** One logical change per PR — small diffs get reviewed and merged faster.
3. **Keep it green locally** before pushing:

   ```bash
   npm run typecheck     # tsc --noEmit across every workspace
   npm run lint          # ESLint (incl. no-silent-catch rules)
   npm run build         # optional but catches integration breaks
   ```

4. **Commit** (the pre-commit gate runs automatically — see below).
5. **Open a PR** against `main` and fill out the checklist.

### The pre-commit gate

Every commit runs, via Husky, in this order:

| Step | Check |
|------|-------|
| 1 | `lint-staged` → ESLint `--fix` on staged TS/JS |
| 2 | **gitleaks** → secret scan of staged changes |
| 3 | silent-catch lint → no bare error swallows |
| 4 | `tsc --noEmit` → typecheck all workspaces |
| 5 | schema-drift test → contracts ↔ repo agreement |

CI mirrors these and adds migration linting + a full-history secret scan. Please don't `--no-verify` except for genuine emergencies.

---

## Coding standards

Arceus is **strict TypeScript**. In short:

- **No `any`** in application code — use `unknown` at boundaries and narrow it. Prefer generics when a type depends on the caller.
- **Explicit types on public APIs** — exported functions, shared utilities, React props. Let obvious locals infer.
- **Immutability** — return new objects; don't mutate inputs. Use spreads/`Readonly<T>`.
- **Validate at boundaries** — parse external input with Zod (`packages/contracts` is the source of truth for shapes).
- **Handle errors explicitly** — never silently swallow. Empty catches and `.catch(() => {})` are blocked by ESLint *and* a dedicated lint step. Log context, then rethrow or handle.
- **Small, focused files** — high cohesion, low coupling. Extract utilities rather than growing god-files.
- **No `console.log`** in shipped code — use the structured logging / observability helpers.

Match the style of the code around you — naming, comment density, and idioms.

---

## Testing

- Add or update tests for any behavior change. Bug fix? Add the failing test first, then fix it.
- Unit/integration tests run with `bun test` (e.g. `bun test packages/db/tests/drift.test.ts`).
- If you touch the DB schema, update the Drizzle schema **and** regenerate migrations (`npm run db:generate`) — the drift test will otherwise fail.
- Keep the full typecheck green; a PR that doesn't compile can't be reviewed.

---

## Commit & PR conventions

We follow **[Conventional Commits](https://www.conventionalcommits.org/)**:

```
<type>: <short imperative summary>

<optional body — the "why", not just the "what">
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Examples:

```
feat(sprints): retry a failed beat before blocking the task
fix(auth): reject expired invite tokens with 401, not 500
docs: document the heartbeat loop in the README
```

### Pull request checklist

- [ ] Scoped to one logical change with a clear description of **what** and **why**
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] Tests added/updated and passing
- [ ] No secrets, keys, or `.env` files committed (gitleaks clean)
- [ ] Docs/comments updated if behavior or config changed
- [ ] Linked to the issue it closes (if any)

Maintainers may ask for changes — that's normal and collaborative. Address **CRITICAL/HIGH** review comments before merge.

---

## Working with the architecture

A few pointers for common contributions:

- **Adding/changing an agent role** — the role "soul" (system prompt) lives in `packages/prompts/src/roles/`; shared behavior in `shared-rules.ts`. Wire it into the runtime in `packages/company-runtime`.
- **Adding an agent tool** — agent-facing tools are defined in `packages/arceus-mcp` and served over the internal MCP surface (`apps/api/src/routes/internal-mcp`).
- **Domain shapes** — change types in `packages/contracts` first; everything else derives from there.
- **Database** — schema in `packages/db/src/schema`, repos in `packages/db/src/repos`. Regenerate migrations after schema edits.
- **Orchestration / the beat loop** — lives in `apps/api/src/orchestration`.

---

## Security

Please **do not** open public issues for security vulnerabilities. Instead, report them privately via a [GitHub security advisory](https://github.com/divo12/Arceus/security/advisories/new). See the README's [Configuration](README.md#-configuration) notes for how secrets and auth are handled.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
