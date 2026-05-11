# @arceus/workspace-template

Canonical scaffold copied into every new company's product workspace at provision time.

## What it is

`./template/` contains a minimal Vite + React 18 + TypeScript + Tailwind 3 scaffold. When `workspaceManager.provision(companyId)` runs (during `POST /api/company/bootstrap`), every file under `./template/` is copied verbatim into `<productWorkspace>/<companyId>/` BEFORE `git init` so the initial commit captures the scaffold as the starting point.

## What's intentionally NOT here

- **shadcn/ui components.** Install on demand via `npx shadcn add <component>` from inside the workspace. Only the `cn()` helper at `src/lib/utils.ts` (which every shadcn component depends on) is pre-installed.
- **A router.** Most first-release products are single-page. The developer adds `react-router-dom` if/when the strategy needs it.
- **State libraries.** Same reason.

## Why this exists

The developer agent's soul prompt promises a "pre-configured Vite + React 18 + TypeScript + Tailwind 3" workspace. Before this template existed, `provision()` only created an empty directory + git init — the developer would arrive at an empty workspace, contradict the soul, and either stall trying to scaffold or `task_block` with "missing_workspace". This template makes the soul's promise true.

## Editing

Files under `./template/` are NOT part of the monorepo build. They are static assets copied into customer workspaces. Editing them changes what every new company starts from. Existing companies are not affected by template changes — they stay at the version of the template that was current when they were provisioned.

## Versioning

No version metadata yet. A future enhancement could stamp `template-version` into `package.json` or a `.arceus-template-version` file at copy time so we can track which template version each tenant booted on.
