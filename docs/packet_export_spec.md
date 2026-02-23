# Packet export spec

Spec for the **shareable packet** as a portable, audit-ready artifact: bundle contents, manifest (`sources.json`), and versioning.

## Bundle contents

| File | Required | Description |
|------|----------|-------------|
| **packet.md** | Yes | Human-readable packet: problem, evidence, options, decision, owner, date. All sections cite Decision Log entry IDs. |
| **packet.pdf** | No (MVP: optional) | PDF export of packet.md for stakeholders who prefer PDF. |
| **sources.json** | Yes | Manifest of evidence items, hashes, scopes, links; version and export metadata. |

Contract: **every packet section must cite Decision Log entries** (traceability).

---

## sources.json manifest schema

```json
{
  "$schema": "https://arceus.dev/schemas/sources_manifest_v1.json",
  "version": 1,
  "packetVersion": "2026-02-23T12:00:00Z",
  "packetId": "dec-abc123",
  "exportedAt": "2026-02-23T12:00:00Z",
  "exportedBy": "user@example.com",
  "exportScope": "team",
  "exportReason": "stakeholder_review",
  "sources": [
    {
      "id": "ev-1",
      "type": "evidence",
      "uri": "https://...",
      "title": "Optional title",
      "scope": "team",
      "hash": "sha256:...",
      "citedInDecisions": ["dec-abc123"]
    }
  ],
  "decisions": [
    {
      "id": "dec-abc123",
      "title": "Decision title",
      "decidedAt": "2026-02-22T10:00:00Z",
      "owner": "pm@example.com",
      "evidenceIds": ["ev-1", "ev-2"]
    }
  ]
}
```

### Field definitions

- **packetVersion** — ISO8601; version of this packet export.
- **packetId** — Id of the decision (or primary decision) this packet represents.
- **exportedAt / exportedBy / exportScope / exportReason** — Audit: who exported, when, scope, reason.
- **sources** — All evidence items referenced in the packet; each has id, type, uri, optional title, scope, hash, and which decisions cite it.
- **decisions** — Decision records included in the packet; link back to evidence.

---

## Versioning

- **Stable URL:** One canonical URL per packet (e.g. `/packets/{packetId}`).
- **Versions:** Each export has a version; history is retained (e.g. `/packets/{packetId}/v/1`, `v/2`).
- **Supersede vs edit:** Supersede = new decision id (new packet). Edit = new version of same packet (new version id, same packetId).

---

## Integration: publish + reference

- Integrations (Jira, Linear, Notion) **post a stable link + minimal metadata** (e.g. title, packetId, version).
- Avoid attachment limits: link to Arceus-hosted bundle; optional “attach PDF” for one-off share.
- Store **destination URL/ID** back on the Decision Log entry (e.g. `jiraCommentUrl`, `linearIssueId`).

---

## References

- `docs/packet_integration_plan.md` — Phased implementation plan.
- `docs/pm_mvp_plan.md` — 2-week MVP scope.
- `new_ideas.md` — Agent ideas (integrations, PRD outline, manifest).
