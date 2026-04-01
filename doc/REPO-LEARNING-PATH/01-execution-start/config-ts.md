# `server/src/config.ts`

Why it matters:

- This file turns environment and config-file input into one typed runtime object.

Read focus:

- Env loading order.
- Default resolution rules.
- `Config` shape and what each field controls.

Key sections:

- dotenv/bootstrap loading
- `Config` interface
- `resolveHippocampusMode()`
- `loadConfig()`

Connections:

- `index.ts` trusts this file for startup decisions.
- Storage, auth, DB, backups, and Hippocampus all branch off this output.

Questions:

- Which values come from env versus config file versus defaults?
- Which settings affect startup branching?
- Why is it useful that the config is typed early?

