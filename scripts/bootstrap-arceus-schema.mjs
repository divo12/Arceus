import { config as loadEnv } from "dotenv";
import postgres from "postgres";

loadEnv({ path: "Q:/projects/arc2.0/.env.local", override: true });

const databaseUrl = process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Missing ARCEUS_HIPPOCAMPUS_POSTGRES_URL or DATABASE_URL.");
}

const schema = process.env.ARCEUS_DB_SCHEMA || process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA || "public";
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 15,
});

try {
  await sql.unsafe(`create schema if not exists "${schema}";`);
  await sql.unsafe(`
    create table if not exists "${schema}".workspaces (
      id text primary key,
      company_id text not null,
      local_path text,
      status text not null,
      latest_bundle_key text,
      latest_bundle_sha256 text,
      latest_bundle_bytes integer,
      current_sprint_number integer not null default 0,
      current_git_ref text,
      last_synced_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists "${schema}".sprint_snapshots (
      id text primary key,
      company_id text not null,
      sprint_number integer not null,
      git_tag text not null,
      bundle_key text,
      bundle_sha256 text,
      bundle_bytes integer,
      snapshot_data jsonb not null,
      file_manifest jsonb not null default '[]'::jsonb,
      status text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists "${schema}".artifacts (
      id text primary key,
      company_id text not null,
      sprint_id text,
      task_id text,
      agent_role text not null,
      kind text not null,
      title text not null,
      content text not null,
      file_references jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists "${schema}".company_states (
      company_id text primary key,
      snapshot_data jsonb not null,
      event_log jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now()
    );

    create table if not exists "${schema}".assets (
      id text primary key,
      company_id text not null,
      provider text not null default 'supabase',
      object_key text not null,
      content_type text not null,
      byte_size integer not null,
      sha256 text not null,
      original_filename text,
      namespace text not null,
      created_by_agent text,
      created_at timestamptz not null default now()
    );
  `);

  const rows = await sql.unsafe(`
    select table_schema, table_name
    from information_schema.tables
    where table_schema = '${schema}'
      and table_name in ('workspaces', 'sprint_snapshots', 'artifacts', 'company_states', 'assets')
    order by table_name;
  `);

  console.log(JSON.stringify({ schema, tables: rows }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}