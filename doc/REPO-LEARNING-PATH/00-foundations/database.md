# `doc/DATABASE.md`

Why it matters:

- This is the persistence map in English.
- Read it before opening schema files if you want the tables to feel meaningful.

Read focus:

- Main stored entities.
- How state is partitioned by company.
- Which systems are persisted in Postgres versus elsewhere.

Connections:

- Later you will map these concepts into `packages/db/src/schema/*`.
- It also helps when reading services that orchestrate multiple tables.

Questions:

- Which domain objects are central enough to persist?
- How does the DB reinforce company scoping?
- What runtime state is persisted versus reconstructed?

