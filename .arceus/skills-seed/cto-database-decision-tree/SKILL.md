---
name: cto-database-decision-tree
description: Pick the right storage layer — SQL, NoSQL, KV, vector, or browser-local — based on access patterns. Replaces "let's just use Postgres" reflex picks.
role: cto
trigger: choosing the storage layer for a new feature or service; reviewing a data model before code starts
---

# Database Decision Tree

The wrong storage choice is paid every day in latency, query complexity, and migration cost. Make the decision deliberately, not by default.

## Step 1: Answer the access pattern question first

Before naming any database, write down:

- **Reads per second** (estimated): orders of magnitude — 10, 100, 1k, 10k+.
- **Writes per second**: same scale.
- **Read shape**: by id, by relationship, by full-text, by similarity (vector), by aggregation (analytics).
- **Write shape**: single row, batch, append-only event stream.
- **Consistency requirement**: read-your-write within ms, strong cross-row, eventual is fine, single-user (no consistency problem).
- **Data size at 1 year**: MB, GB, TB.

If you cannot answer these, you are not ready to pick a database yet — go back to the spec.

## Step 2: Match access pattern to storage

| Access pattern | Storage |
|---|---|
| Single-user app, no sync, browser-only | `localStorage` (≤5 MB) or `IndexedDB` (larger, structured). Zero ops cost. |
| Multi-user with relational data (users, orgs, joins) | Postgres. Default. |
| Multi-user, schema-flexible documents | Postgres `jsonb` first. Mongo only if you've outgrown jsonb (rare for first releases). |
| Cache, session, rate-limit counters, ephemeral state | Redis or Postgres + TTL column. |
| Append-only event stream / audit log | Postgres table with `created_at` index, partitioned by month. Kafka only at >10k writes/sec. |
| Vector similarity search (RAG, recommendations) | pgvector inside Postgres (one less system). Pinecone/Weaviate when scale is proven. |
| Analytics across millions of rows with aggregation | Postgres + materialized views first; ClickHouse/BigQuery if reporting is the product. |
| Files / binary blobs | S3-compatible object storage. Never the database. |

## Step 3: The "default to Postgres" rule

If you can't articulate why a different store is required, use Postgres. Reasons it works:
- Transactions, foreign keys, constraints — correctness is free.
- jsonb covers schema-flexible cases.
- pgvector covers vector search.
- Materialized views cover most analytics.
- One operational surface to monitor, back up, and migrate.

## Step 4: When to use a second store

Only when ALL of these are true:
- The query pattern is fundamentally a poor fit for SQL.
- You've measured Postgres failing the requirement at realistic load.
- The team has the ops bandwidth to monitor a second system.

If any of those is false, stay on Postgres and revisit when the constraint actually bites.

## Common mistakes

- Picking Mongo because "schemas are too rigid" before writing a single migration.
- Adding Redis as a cache when the slow query was actually a missing index.
- Using a vector DB for ten thousand rows — Postgres can scan that in milliseconds.
- Storing files as bytea columns — kills the database, costs more than S3.
- Designing for "we might need to scale to a million users" instead of the first thousand. Migration is cheap, premature complexity is not.

## Output of this decision

Write the choice + reasoning into the architecture spec, attached to your claimed task as an artifact. Include:
- The pattern numbers from Step 1.
- The store you picked and the row in the table that matches.
- The next migration trigger ("if writes exceed X/sec, evaluate Y").
