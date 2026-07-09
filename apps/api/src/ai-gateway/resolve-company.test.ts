import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { siteSubdomainOf } from "../workspace/site-url.js";
import { companyHash, siteHostLabel } from "../workspace/site-url.js";

describe("AI gateway host resolution helpers", () => {
  it("extracts product host label from Origin-style hosts", () => {
    const id = "company_abc";
    const label = siteHostLabel("Quill Notes", id);
    const hash = companyHash(id);
    assert.equal(label, `quill-notes-${hash}`);
    assert.equal(
      siteSubdomainOf(`${label}.arceus.sh`, "arceus.sh"),
      label,
    );
  });

  it("does not treat api.arceus.sh as a product host", () => {
    assert.equal(siteSubdomainOf("api.arceus.sh", "arceus.sh"), null);
  });
});
