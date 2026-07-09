import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTursoCredentials } from "./turso-provision.js";

describe("readTursoCredentials", () => {
  it("returns null when file missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "turso-miss-"));
    try {
      assert.equal(readTursoCredentials(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads valid credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "turso-ok-"));
    try {
      mkdirSync(join(dir, ".arceus"), { recursive: true });
      writeFileSync(
        join(dir, ".arceus", "turso.json"),
        JSON.stringify({
          databaseName: "arceus-abc",
          databaseUrl: "libsql://arceus-abc-org.turso.io",
          authToken: "jwt-token",
        }),
      );
      const creds = readTursoCredentials(dir);
      assert.ok(creds);
      assert.equal(creds!.databaseName, "arceus-abc");
      assert.equal(creds!.databaseUrl, "libsql://arceus-abc-org.turso.io");
      assert.equal(creds!.authToken, "jwt-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
