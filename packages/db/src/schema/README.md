# `src/schema/` — normalized table definitions

One file per table. Populated in Phase 1 of spec 31.

Conventions:
- Each file exports one `pgTable` definition.
- Indexes declared in the second arg to `pgTable(...)`.
- Foreign keys use `.references(() => other.id, { onDelete: "..." })`.
- `uuid("id").primaryKey().defaultRandom()` for PKs.
- `timestamptz` (`timestamp({ withTimezone: true })`) for all timestamps.
- `CHECK` constraints appended to migration manually when drizzle-kit cannot generate them.

See [plans/specs/31-db-redesign.md](../../../../plans/specs/31-db-redesign.md) for the full schema spec
and [plans/specs/31-db-redesign-plan.md](../../../../plans/specs/31-db-redesign-plan.md) for the
implementation plan.
