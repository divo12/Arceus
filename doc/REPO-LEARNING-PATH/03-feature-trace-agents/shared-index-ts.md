# `packages/shared/src/index.ts`

Why it matters:

- This file is the public contract barrel for shared app types and constants.

What to focus on:

- what kinds of symbols are exported
- which exports are constants versus types
- how broad the contract surface really is

What this file teaches:

- the UI and server stay aligned by importing from one shared package
- if a symbol is exported here, it is part of cross-layer language

Connections:

- frontend API wrappers and backend routes both depend on this package
- schema, validators, and route payloads all eventually connect here

Self-check:

- Which exports describe domain vocabulary?
- Which exports describe data shape?
- Why is a barrel file useful in a monorepo contract package?

