# Decision OS Implementation (New Ideas MVP)

Implementation of agent-surfaced ideas from `pm_ideas/new_ideas.md` and `new_ideas.md`: Evidence/Traceability, Decision Record, Options Set, Evidence Brief, and artifact generation.

## Implemented (MVP)

### 1. Evidence store + schema

- **Schema:** `docs/schemas/evidence_item_v1.json` — evidence item structure
- **Store:** `evidence/store.py` — `upsert_evidence()`, `get_evidence()`, `list_evidence()`
- **Persistence:** `data/state/evidence_store.json`
- **Idempotency:** `(source_system, source_id, source_version)` prevents duplicates
- **Fields:** uri, title, type, hash, parser_version, chunker_version, chunk_ids, scope

### 2. Claims ledger (provenance)

- **Ledger:** `data/state/claims.json` — `{claim, evidence_chunk_ids, confidence, decision_id}`
- **API:** `add_claim()`, `list_claims()`

### 3. Workspace skills

| Skill | Path | Purpose |
|-------|------|---------|
| **decision-record** | `skills/workspace_skills/decision-record/` | DR/ADR with revisit triggers |
| **options-set-generator** | `skills/workspace_skills/options-set-generator/` | ≥3 options + tradeoffs |
| **evidence-brief** | `skills/workspace_skills/evidence-brief/` | Confidence, coverage, gaps |

### 4. Artifact generator CLI

- **Script:** `scripts/arceus_artifacts.py`
- **Kinds:** `decision_record`, `evidence_brief`, `options_set`
- **Usage:** `uv run python scripts/arceus_artifacts.py --kind decision_record --input input.json --output docs/`
- **Renderer:** `artifacts/renderer.py` — programmatic generation

### 5. Traceability

- Evidence items have `chunk_ids` and `hash` for provenance
- Claims link to `evidence_chunk_ids` and `decision_id`
- Packet export (`packets/`) cites decisions and sources; `sources.json` manifest

### 6. PM continuous loop mode

- **Core runtime:** `execution/agent_loop.py` (`run_pm_loop`, `run_pm_loop_sync`)
- **Controller integration:** `execution/controller.py` (`run_pm_problem`, cron dispatch kind `pm_loop`)
- **Cron support:** `cron/types.py` + `scripts/run_gateway.py --pm-loop`
- **Feedback loop:** synthetic feedback generation + next-problem derivation
- **State persistence:** `data/state/workflows/<loop_id>.json`
- **Report:** `data/state/workflows/<loop_id>_report.json`

## Not yet implemented

- Change propagation engine (impacted artifacts + diffs)
- Decision hygiene check (bias, missing alternatives)
- Evidence quality rubric, evidence-dedup-and-tagging
- Tradeoff-matrix skill (standalone)
- Rollout-and-risk-plan, metrics-instrumentation-plan
- Data control boundary UI (redaction/retention)

## References

- `pm_ideas/new_ideas.md` — full New Ideas sweep
- `docs/packet_integration_plan.md` — packet + integrations
- `docs/packet_export_spec.md` — packet bundle spec
