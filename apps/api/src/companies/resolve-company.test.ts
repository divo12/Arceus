/**
 * Tests for pickMostRecentCompanyId — the pure selection that replaces the
 * legacy global active-company pointer for the few boot/legacy paths that need
 * "a" company without a per-request tenant (boot skill/workspace seeding, the
 * unauthenticated chat path). Reads fresh DB rows each call instead of a stale
 * in-memory singleton.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMostRecentCompanyId } from "./resolve-company.js";

const row = (id: string, friendlyId: string | null, iso: string) => ({
  id,
  friendlyId,
  createdAt: new Date(iso),
});

test("returns null for an empty list", () => {
  assert.equal(pickMostRecentCompanyId([]), null);
});

test("returns the single company's friendly id", () => {
  assert.equal(
    pickMostRecentCompanyId([row("db1", "company_a", "2026-06-01T00:00:00Z")]),
    "company_a",
  );
});

test("picks the MOST-RECENT company by createdAt regardless of input order", () => {
  const rows = [
    row("db1", "company_old", "2026-06-01T00:00:00Z"),
    row("db3", "company_new", "2026-06-14T00:00:00Z"),
    row("db2", "company_mid", "2026-06-07T00:00:00Z"),
  ];
  assert.equal(pickMostRecentCompanyId(rows), "company_new");
});

test("falls back to the canonical id when friendlyId is null", () => {
  assert.equal(
    pickMostRecentCompanyId([row("db_uuid", null, "2026-06-01T00:00:00Z")]),
    "db_uuid",
  );
});
