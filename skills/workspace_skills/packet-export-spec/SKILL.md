---
name: packet-export-spec
description: Define and use the shareable packet export bundle (packet.md, packet.pdf, sources.json), manifest schema, versioning, and traceability to Decision Log entries. Use when specifying or implementing the packet product, audit-ready exports, or integrations that publish packet links.
type: component
---

## Purpose

Define the **shareable packet** as a portable, audit-ready artifact that can be shared across stakeholders. Use this skill when you need to specify or implement:

- Packet bundle contents and format
- The `sources.json` manifest (evidence + decisions, hashes, scopes)
- Versioning and stable URLs
- Contract that every packet section cites Decision Log entries

## Key concepts

### Bundle contents

| File | Required | Description |
|------|----------|-------------|
| **packet.md** | Yes | Human-readable packet: problem, evidence, options, decision, owner, date. Sections cite Decision Log IDs. |
| **packet.pdf** | No (MVP optional) | PDF export of packet.md. |
| **sources.json** | Yes | Manifest: evidence items, hashes, scopes, links; version and export metadata. |

### Contract

- **Decision Log** = internal system of record.
- **Shareable Packet** = external artifact.
- Every packet section must **cite Decision Log entries** (traceability).

### Versioning

- Stable URL per packet (e.g. `/packets/{packetId}`).
- New version = new version id; history retained.
- **Supersede** = new decision id (new packet). **Edit** = new version of same packet.

### Integration (publish + reference)

- Integrations post **stable link + minimal metadata** (e.g. Jira comment + link).
- Store destination URL/ID back on Decision Log entry.
- No bi-directional sync in MVP.

## References

- **Spec:** `docs/packet_export_spec.md` — full bundle and manifest spec.
- **Schema:** `docs/schemas/sources_manifest_v1.json` — JSON schema for `sources.json`.
- **Plan:** `docs/packet_integration_plan.md` — phased implementation (packet bundle → one connector → reversal + instrumentation → permissions).

## When to use

- Specifying or implementing packet export.
- Designing manifest (sources.json) or versioning.
- Defining integration behavior (publish + reference, link-only).
- Reviewing traceability (evidence → decision → packet section).

## When not to use

- General PRD or roadmap (use prd-development, roadmap-planning).
- Full permissions/SSO (use governance/permissions skills when added).
