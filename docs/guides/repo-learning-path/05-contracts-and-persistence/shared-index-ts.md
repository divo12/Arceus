# `packages/shared/src/index.ts`

This guide explains `[packages/shared/src/index.ts](/Users/divyansh/Arceus/packages/shared/src/index.ts)` as the public contract barrel for the monorepo.

If you want one sentence first:

`packages/shared/src/index.ts` is the file that decides which concepts become part of the repo’s shared language across UI, server, adapters, and supporting packages.

## 1. Why This File Exists

The repo has many layers that need to agree on meaning:

- React pages
- frontend API wrappers
- Express routes
- backend services
- adapter packages
- runtime helpers

If each layer imported deep internal files in its own way, the contract surface would become messy quickly.

This file exists to provide one stable shared import entrypoint:

`@paperclipai/shared`

That is more than convenience.

It is a way of declaring:

"These are the concepts the whole system is allowed to rely on."

## 2. The Main Job Of A Barrel File Here

Not all barrel files are important.

This one is important because it is also a promotion boundary.

If something is exported here, it is effectively being promoted to:

- cross-layer vocabulary
- public internal API
- system-level contract

That means this file is a good answer to the question:

"Which concepts are first-class in the architecture?"

## 3. How To Read It

Do not read it as normal code flow.

Read it as a contract inventory.

The file has two big sections:

1. exports from `constants.js`
2. exports from `types/*`

That split already tells you something:

- constants define value universes
- types define object shapes

## 4. The Constants Export Section

The top half of the file re-exports a huge amount from `constants.js`.

That includes:

- statuses
- roles
- adapter types
- deployment/auth enums
- hierarchy enums
- budget enums
- heartbeat enums
- plugin enums

This is the shared vocabulary layer.

What matters is not memorizing every constant.

What matters is recognizing that the product has many domains, and each one has a controlled set of legal values.

This file is where all those value universes are surfaced to the rest of the repo.

## 5. The Type Export Section

The second half re-exports many domain record types:

- company
- agent
- role and hierarchy
- project and issue
- execution workspace
- heartbeat
- costs and budgets
- meetings and chat
- plugins
- portability/import-export

This tells you something important about Paperclip:

it is not only a CRUD app for a few tables.

It is a control plane with:

- business entities
- runtime entities
- governance entities
- plugin host entities
- portability entities

The shared barrel makes those domains visible in one place.

## 6. What This File Tells You About The System

If you only skim this file, you can still learn a lot.

For example:

- `Agent`, `Issue`, and `HeartbeatRun` are obvious first-class domains
- workspace/runtime types are exported broadly, so execution infrastructure is part of the core system model
- plugin types are not isolated in a side package; they are part of the shared contract surface
- budgets, approvals, access control, and portability are all treated as system-level concerns

That is architectural information, not just export trivia.

## 7. Why This File Matters During Refactors

When changing a feature, this file helps answer:

- is this concept already part of the shared contract surface?
- if I add a new shared type or constant, should it be exported here?
- if I remove something here, which packages will feel it?

That makes it a high-signal “blast radius” file.

## 8. What This File Does Not Do

This file does not define most of the concepts it exports.

So if you want the actual meaning of a type, you still need to open:

- `constants.ts`
- `types/*.ts`
- sometimes `validators/*.ts`

This barrel is the map, not the territory.

## 9. What To Remember

- this file is the public contract surface of `@paperclipai/shared`
- exporting something here promotes it into cross-layer vocabulary
- it is one of the fastest architecture overview files in the monorepo
- it is especially useful for understanding which concepts are globally shared versus locally internal

## Self-Check

- Why is this barrel more than just import convenience?
- What does it mean architecturally when a concept is exported from here?
- Which domains in the repo become obvious just by scanning this export surface?

