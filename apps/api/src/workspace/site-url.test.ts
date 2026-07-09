import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildSitePublicUrl,
  companyHash,
  siteHostLabel,
  siteSubdomainOf,
  slugifySiteName,
} from "./site-url.js";

describe("site-url", () => {
  it("slugifies brand to first two tokens", () => {
    assert.equal(slugifySiteName("AquaGrid B2B Marketplace for Water"), "aquagrid-b2b");
    assert.equal(slugifySiteName("Quill"), "quill");
    assert.equal(slugifySiteName(""), "site");
  });

  it("companyHash is stable 8-char hex", () => {
    const h = companyHash("company_abc-123");
    assert.equal(h.length, 8);
    assert.match(h, /^[a-f0-9]{8}$/);
    assert.equal(companyHash("company_abc-123"), h);
  });

  it("builds <name>-<hash>.arceus.sh (single DNS label)", () => {
    const id = "company_test_id";
    const hash = companyHash(id);
    assert.equal(
      buildSitePublicUrl("Quill Notes", id, "arceus.sh"),
      `https://quill-notes-${hash}.arceus.sh`,
    );
    assert.equal(siteHostLabel("Quill Notes", id), `quill-notes-${hash}`);
  });

  it("parses canonical, legacy nested, and legacy short hosts", () => {
    const hash = companyHash("company_x");
    assert.equal(
      siteSubdomainOf(`quill-${hash}.arceus.sh`, "arceus.sh"),
      `quill-${hash}`,
    );
    // Legacy nested form normalizes to the single-label key
    assert.equal(
      siteSubdomainOf(`quill.${hash}.arceus.sh`, "arceus.sh"),
      `quill-${hash}`,
    );
    assert.equal(siteSubdomainOf("quill.arceus.sh", "arceus.sh"), "quill");
    assert.equal(siteSubdomainOf("app.arceus.sh", "arceus.sh"), null);
    assert.equal(siteSubdomainOf("api.arceus.sh", "arceus.sh"), null);
    assert.equal(siteSubdomainOf("evil.example.com", "arceus.sh"), null);
  });
});
