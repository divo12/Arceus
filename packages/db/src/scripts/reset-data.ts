/**
 * reset-data — wipe all user/company data so you can start fresh.
 *
 * Cascade chain:
 *   DELETE users → companies (cascade) → agents, sprints, tasks, artifacts,
 *   meetings, heartbeat_runs, memory_units, skill_artifacts, ... (all cascade)
 *
 * Only idempotency_keys has no FK to users/companies, so it's deleted separately.
 *
 * Safe to re-run (idempotent). Does NOT touch schema or migrations.
 */
import "../load-env.js";
import postgres from "postgres";

const url =
  process.env.SUPABASE_DB_URL ??
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL ??
  process.env.DATABASE_URL ??
  "postgresql://localhost:5432/arceus_dev";

const sql = postgres(url, { max: 1, prepare: false });

async function run() {
  console.log("Connecting to:", url.replace(/:[^:@]+@/, ":***@"));

  // Count before
  const [{ users }] = await sql`SELECT count(*)::int AS users FROM users`;
  const [{ companies }] = await sql`SELECT count(*)::int AS companies FROM companies`;
  console.log(`Before: ${users} user(s), ${companies} company(ies)`);

  if (users === 0 && companies === 0) {
    console.log("Nothing to delete — already clean.");
    await sql.end();
    return;
  }

  await sql.begin(async (tx) => {
    // Delete companies first (cascades to agents, sprints, tasks, meetings, etc.)
    // Must come before users because some companies have nullable userId and
    // won't be reached by the users cascade.
    const deletedCompanies = await tx`DELETE FROM companies RETURNING id`;
    console.log(`Deleted ${deletedCompanies.length} company row(s) (and all cascaded children)`);

    // Delete users (any remaining after company cascade)
    const deletedUsers = await tx`DELETE FROM users RETURNING id`;
    console.log(`Deleted ${deletedUsers.length} user row(s)`);

    // No-cascade table
    const keys = await tx`DELETE FROM idempotency_keys RETURNING key`;
    console.log(`Deleted ${keys.length} idempotency_key row(s)`);
  });

  // Verify
  const [{ usersAfter }] = await sql`SELECT count(*)::int AS "usersAfter" FROM users`;
  const [{ companiesAfter }] = await sql`SELECT count(*)::int AS "companiesAfter" FROM companies`;
  console.log(`After: ${usersAfter} user(s), ${companiesAfter} company(ies)`);
  console.log("Done — database is clean.");

  await sql.end();
}

run().catch((err) => {
  console.error("reset-data failed:", err);
  process.exit(1);
});
