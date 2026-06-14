/**
 * Tests for the live-company registry — the fail-safe that stops MCP tenant
 * resolution from ever resolving a request to a deleted company.
 *
 * Reliability contract (2026-06-14): a stale in-memory session context (left by
 * a raw DB wipe that bypassed DELETE /api/company + clearAllSessionContexts)
 * must not poison a request's companyId with a company that no longer exists →
 * buildSnapshotView 500. The registry is refreshed by the heartbeat tick
 * (authoritative DB list) and on bootstrap (new company), and the MCP
 * middleware rejects any resolved company that isn't known-live.
 *
 * Fail-OPEN before the first refresh: at boot, before any tick has populated
 * the set, we don't know the truth, so we must not reject (that would break
 * every request until the first tick).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markCompaniesLive,
  markCompanyLive,
  forgetCompany,
  isCompanyKnownLive,
  isRegistryPopulated,
  __resetLiveCompanies,
} from "./live-companies.js";

test("fails OPEN before the registry is populated (boot — unknown truth, don't reject)", () => {
  __resetLiveCompanies();
  assert.equal(isRegistryPopulated(), false);
  assert.equal(isCompanyKnownLive("company_anything"), true, "must not reject before first refresh");
});

test("after refresh, only listed companies are known-live", () => {
  __resetLiveCompanies();
  markCompaniesLive(["company_a", "company_b"]);
  assert.equal(isRegistryPopulated(), true);
  assert.equal(isCompanyKnownLive("company_a"), true);
  assert.equal(isCompanyKnownLive("company_b"), true);
  assert.equal(isCompanyKnownLive("company_deleted"), false, "a company absent from the DB list is not live");
});

test("a refresh REPLACES the set — a since-deleted company drops out", () => {
  __resetLiveCompanies();
  markCompaniesLive(["company_a", "company_gone"]);
  assert.equal(isCompanyKnownLive("company_gone"), true);
  markCompaniesLive(["company_a"]); // next tick: company_gone no longer in DB
  assert.equal(isCompanyKnownLive("company_gone"), false, "deleted company drops out on next tick");
  assert.equal(isCompanyKnownLive("company_a"), true);
});

test("markCompanyLive covers the new-company window before the next tick", () => {
  __resetLiveCompanies();
  markCompaniesLive(["company_a"]);
  assert.equal(isCompanyKnownLive("company_new"), false);
  markCompanyLive("company_new"); // bootstrap just created it
  assert.equal(isCompanyKnownLive("company_new"), true, "freshly bootstrapped company is live immediately");
});

test("markCompanyLive before any refresh populates the registry", () => {
  __resetLiveCompanies();
  assert.equal(isRegistryPopulated(), false);
  markCompanyLive("company_first");
  assert.equal(isRegistryPopulated(), true);
  assert.equal(isCompanyKnownLive("company_first"), true);
  assert.equal(isCompanyKnownLive("company_other"), false);
});

test("forgetCompany removes a company immediately (explicit delete path)", () => {
  __resetLiveCompanies();
  markCompaniesLive(["company_a", "company_b"]);
  forgetCompany("company_a");
  assert.equal(isCompanyKnownLive("company_a"), false);
  assert.equal(isCompanyKnownLive("company_b"), true);
});
