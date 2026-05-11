# Arceus product workspace

This workspace was scaffolded by Arceus at company bootstrap. The stack:

- **Vite 5** — dev server + bundler. `pnpm dev` to start.
- **React 18** — UI library.
- **TypeScript 5** — strict mode on.
- **Tailwind 3** — utility-first CSS. Config in `tailwind.config.js`.
- **`cn()` helper** at `src/lib/utils.ts` — the merge utility every shadcn/ui component depends on.

## Conventions

- Components live in `src/components/`. One component per file.
- The path alias `@/` resolves to `src/`.
- Add shadcn/ui components on demand: `npx shadcn add button`. Don't pre-install components you don't need.
- The `server.allowedHosts: "all"` rule in `vite.config.ts` is required for Arceus's preview proxy — don't remove it.

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start the dev server on port 5173 |
| `pnpm build` | Type-check + production bundle into `dist/` |
| `pnpm preview` | Serve the production bundle locally |
