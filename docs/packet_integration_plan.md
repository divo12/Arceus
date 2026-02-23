# Packet + integrations implementation plan

Implementation plan derived from agent ideas in `new_ideas.md`: Decision Log ↔ Shareable Packet, integrations (publish + reference), audit-ready bundle + manifest.

## Vision (from agent)

- **Decision Log** = internal system of record; **Shareable Packet** = external, portable artifact.
- Contract: every packet section cites Decision Log entries (traceability).
- Integrations: two outcomes only for MVP — (1) Decision Log entry created/linked to work, (2) Packet exported and attached/linked back.
- Packet = portable bundle: `packet.md` + `packet.pdf` (optional) + `sources.json` (manifest with hashes, scopes, versioning).

---

## Phase 1: Packet export bundle (thin vertical)

**Goal:** Implement the packet as a product — portable, versioned, audit-ready.

| Deliverable | Description |
|-------------|-------------|
| **Packet bundle schema** | Define and implement: `packet.md`, optional `packet.pdf`, `sources.json` manifest. |
| **sources.json manifest** | List all evidence items, hashes, scopes, links; versioned with packet. |
| **Stable URL + versioning** | Packet has stable link; new version = new version id, history retained. |
| **Renderer** | Generate packet from Decision Log entries (markdown first; PDF optional). |

**Out of scope for Phase 1:** Jira/Linear/Notion connectors, bi-directional sync, full permissions model.

### Current implementation (in repo)

- **Generator**: `packets/service.py` writes versioned bundles to `data/packets/<packetId>/v<N>/`
  - Outputs: `packet.md`, `sources.json`
  - Stable reference: `data/packets/<packetId>/latest.json` (and `LATEST`)
- **CLI**: `scripts/generate_packet.py`
- **Telemetry**: `observability/events.py` writes JSONL to `.arceus/events/events.jsonl` (event: `generate_packet`)

---

## Phase 2: Publish + reference (one connector)

**Goal:** One integration path: “publish packet and post link + minimal metadata.”

| Deliverable | Description |
|-------------|-------------|
| **Pick one tool** | Jira (recommended) or Linear or Notion. |
| **Single write path** | e.g. Jira: issue comment + remote link (and/or attachment). |
| **Store destination back** | Save destination URL/ID on Decision Log entry. |
| **No bi-directional sync** | Integrations only post link/metadata; no full issue creation or rich editing. |

### Current implementation (in repo)

- **Jira connector (MVP)**:
  - `integrations/jira.py`: formats the packet reference comment; posts a comment via Jira REST API v3
  - `integrations/publish.py`: reads `data/packets/<packetId>/latest.json` and publishes a reference to Jira
  - `scripts/publish_packet_jira.py`: CLI wrapper
  - Env vars required: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- **Telemetry**: event `publish_packet_reference` (destination: `jira`)

---

## Phase 3: Reversal handling + instrumentation

**Goal:** Supersede vs edit semantics; measure time-to-verify and adoption.

| Deliverable | Description |
|-------------|-------------|
| **Reversal handling** | Supersede decision (new DEC id) vs edit (new version); preserve trust. |
| **Event taxonomy** | e.g. `create_decision`, `link_evidence`, `generate_packet`, `open_packet`, `forward_packet`, `comment_packet`, `request_change`. |
| **time-to-verify** | Define start/end events; instrument. |
| **Fake-door (optional)** | “Connect Jira / Linear / Notion” + track clicks, OAuth completion, export rate. |

---

## Phase 4: Permissions + manifest (audit-ready)

**Goal:** Scopes, labels, audit trail so packet is governance-ready.

| Deliverable | Description |
|-------------|-------------|
| **Visibility scopes** | e.g. team \| org \| legal \| external. |
| **Redaction / watermark** | Manifest and packet respect scopes; export metadata (exported_by, exported_at, scope). |
| **Manifest enhancement** | `sources.json` includes hashes, scopes, and optional approval/audit fields. |

---

## New workspace skills to add (from agent)

- **packet-export-spec** — Export bundle schema, versioning, manifest. *(Spec in `docs/packet_export_spec.md`; skill in `skills/workspace_skills/packet-export-spec/`.)*
- **integration-fake-door-design** — Fake-door metrics + success thresholds for connectors.
- **event-taxonomy-designer** — Events for time-to-verify + stakeholder pull.
- **reversal-handling** — Supersede vs edit history patterns.

---

## Success criteria (from agent)

**Fake-door / validation**

- [ ] Track: % click connect, % complete OAuth, % export at least once, destination split, artifact preference (link vs MD vs PDF), repeat exports/week.

**Build (thin vertical)**

- [ ] Packet export bundle (`packet.md`, optional `packet.pdf`, `sources.json`) with versioning.
- [ ] Publish + reference for one tool (e.g. Jira comment + link).
- [ ] Store destination URL/ID back into Decision Log entry.
- [ ] Reversal handling: supersede (new DEC id) vs edit (new version).

**6-week wedge**

- [ ] `sources.json` manifest with hashes + scopes.
- [ ] Packet versioning and stable links.

---

## References

- `docs/pm_mvp_plan.md` — 2-week MVP (Decision OS, shareable packet).
- `docs/packet_export_spec.md` — Packet bundle and manifest spec.
- `new_ideas.md` — Agent-surfaced ideas (integrations, PRD outline, 6-week wedge).
