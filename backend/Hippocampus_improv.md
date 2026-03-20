# Hippocampus Improvement Tracker

## Previously Tracked — Now Resolved

| # | Issue | Was Phase | Resolved In | How |
|---|-------|-----------|-------------|-----|
| H6 | No LLM extraction pipeline | Phase 2 | Phase 2 | `MemoryExtractor` with 3 modes, `NoopLLMEngine` stub, prompts, action decision pipeline |
| M6 | No version chain logic | Phase 2 | Phase 2 | `StaticMemory.update()` creates version chain, `GraphStore.version_memory()` + `get_version_history()` |
| L2 | No `__all__` exports in `__init__.py` | No spec phase | Phase 2 | Both `hippocampus/__init__.py` and `backends/__init__.py` now have full `__all__` exports |
| S2 | `SimpleEmbeddingEngine` not marked test-only | No spec phase | Phase 3 | Renamed to `MockEmbeddingEngine` with clear test-only intent |
| S4 | `InMemoryGraphStoreBackend.update_node` no validation | No spec phase | Phase 3 | Added `_VALID_NODE_FIELDS` set and validates `updates` keys before `replace()` |
| S5 | `Hippocampus.__init__` has 12 parameters | No spec phase | Phase 2 | Grouped into `HippocampusBackends` dataclass |
| M2.2 | `NoopLLMEngine` keyword matching is brittle | Phase 3+ | Phase 3 | `AzureOpenAILLMEngine` added as real LLM backend; `NoopLLMEngine` remains for tests only |
| S7 | Timezone-naive `fromisoformat` in PromotionEngine | No spec phase | Phase 3 refactor | Added `parse_utc_iso()` to `utils/time.py`; PromotionEngine now uses it for all ISO parsing |
| S10 | Duplicated `_create_hippocampus` test helper | No spec phase | Phase 3 refactor | Extracted to `tests/adapters/conftest.py` as shared `hippocampus_factory` fixture |
| M4 | `memory_projections.py` accesses private `_backend` | Phase 5 | Phase 3 refactor | Added `get_neighbors()` public method on `GraphStore`; projections now use public API |
| S9 | Tests access private `_qualifies_for_static` | No spec phase | Phase 4 review | Renamed to public `qualifies_for_static()`, updated all call sites and tests |
| M2 | No Procedural tier | Phase 4 | Phase 4 | `ProceduralMemory` class with LLM trigger evaluation, EMA confidence update, habit CRUD |
| M3 | No Priming tier | Phase 4 | Phase 4 | `PrimingMemory` class with EMA state update, LLM disposition generation |
| L3 | `Pattern.formed_from` plain tuple | Phase 4 | Phase 4 | `PatternLearner` now links patterns to trajectory IDs with full metadata |
| M5 | `profile_engine.py` uses empty-string search | Phase 4 | **Open — see H4** | Tracked below as H4; still uses `search(query="")` |

---

## PR#1 Consolidated Review — 53 Items

Full review combining Claude deep review + CodeRabbit automated analysis.
Items tagged `[C]` = Claude, `[CR]` = CodeRabbit, `[BOTH]` = found by both.

### CRITICAL (9)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| C1 | `memory_scope.py:43-55` | **GraphEntity crashes `_deduplicate_by_priority`** — `Hippocampus.recall()` returns `MemoryUnit \| GraphEntity`, but `_deduplicate_by_priority()` assumes every item has `memory_type`. Any graph hit triggers `AttributeError`. Fix: Pass `include_graph=False` in all recall calls from `ArceusMemoryScope`, or filter out `GraphEntity` before dedup. | [CR] | **Resolved** — added `include_graph=False` to all 3 recall calls |
| C2 | `in_memory_vector.py` + `protocols.py:22-28` | **VectorStore.search not agent-scoped (tenant bleed)** — `search()` filters only by `container`, not `agent_id`. Shared container names leak memories across agents. `list_by_type()` enforces agent_id but `search()` doesn't. Fix: Add `agent_id: str` to `VectorStore.search` protocol and enforce in all implementations. | [CR] | Open |
| C3 | `promotion_engine.py:107-124,191-200` | **Probation demotions inverted + never measures probation usage** — `_promote_to_static()` copies dynamic `usage_count` (already >= 10). `check_probation_demotions()` demotes when `usage_count == 0`, which is impossible. The `now < probation_end` check is also backwards — demotes *before* probation expires. Fix: Track usage relative to promotion time (reset or `probation_usage_count`), change condition to `now >= probation_end`. | [CR] | **Resolved** — added `probation_usage_count: 0` on promotion, flipped to `now >= probation_end`, `_touch()` increments probation counter, test fixed |
| C4 | `memory_projections.py:get_promotion_stream` | **Side-effecting read on dashboard path** — Calls `hippocampus.run_promotions()` which fires new promotions (creates static memories, deletes dynamic ones, creates graph edges). Dashboard GET should never mutate state. Fix: Add promotion event persistence to `PromotionEngine`, add `get_recent_promotions()`, call that instead. | [BOTH] | **Resolved** — `get_promotion_stream()` now calls `hippocampus.get_recent_promotions()` (read-only), event log stored in PromotionEngine |
| C5 | `delegation_memory.py:49-67` | **Copies private memories + breaks encapsulation** — (1) Copies every recalled `MemoryUnit` regardless of `visibility` — private memories become readable by another agent. (2) Calls `to_hippocampus._vector_store.upsert()` directly, bypassing tier logic (no embedding, no graph wiring). Fix: Filter on shareable visibility before copying, use `to_hippocampus.remember()` or a public `ingest()` method. | [BOTH] | **Resolved** — delegation copies now hardcode `visibility=TASK_SCOPED` (Option B: delegation is the visibility upgrade); `_vector_store.upsert` kept to preserve delegation metadata; test added |
| C6 | `in_memory_vector.py:_touch()` | **Mutates frozen dataclass metadata on every search** — `_touch()` directly mutates the `metadata` dict of a `MemoryUnit` on every search hit (incrementing `usage_count`, setting `last_accessed`). While `frozen=True` prevents field reassignment, the dict is mutable. Reads have side effects, and `profile_engine.py` triggers this by calling `search()`. Fix: Create a new `MemoryUnit` with updated metadata, or move access tracking to a separate store. | [C] | **Resolved** — extracted `UsageTracker` class into `utils/usage_tracker.py`; removed `_touch()` from `InMemoryVectorStore`; `search()` is now pure read; usage tracking only called from `Hippocampus.recall()` |
| ~~C7~~ H22 | `neo4j_graph.py:87-103` | **`create_edge` ignores missing nodes, returns success** — If either source or target `GraphEntity` doesn't exist, Neo4j `MATCH` returns zero records and creates no relationship — but `create_edge()` always returns `rel.id`. Silently drops graph provenance edges. The test fake also masks this. Fix: Check records, raise `KeyError` if empty. **Downgraded:** Graph is observability scaffolding — no agent logic depends on it. Fix when graph becomes load-bearing (Phase 5+). | [CR] | Deferred |
| C8 | `sentence_transformers_embedding.py:55-72` | **Import outside try + infinite retry loop** — `from sentence_transformers import SentenceTransformer` is outside the try block, so `ImportError` escapes and fallback is never used. When loading fails, `_model` stays `None`, causing retry on every `embed()` call — repeated expensive failures and log spam. Fix: Move import inside try, add `_model_load_failed` flag. | [CR] | **Resolved** — moved import inside try block, added `_load_failed` flag to prevent retry after first failure |
| C9 | `procedural.py:53-71` | **`record_usage()` not atomic** — Does `get_habit()` then `update_habit()` as two separate store calls. In `sqlite_relational.py`, each acquires the lock independently, so concurrent calls both read same `usage_count` and write back `n + 1`. Drops updates, can flip `is_active` incorrectly. Fix: Wrap in a single transaction. | [CR] | **Resolved** — added `record_habit_usage()` on RelationalStore protocol; SQLite impl holds lock across read+compute+write; ProceduralMemory delegates. Postgres migration: replace lock with `BEGIN` + `SELECT FOR UPDATE` + `COMMIT` |

### HIGH — Spec Gaps (5)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| H1 | `hippocampus.py` | **Missing `process_trajectory()` orchestration method** — Spec section 7.12 defines `process_trajectory(trajectory)` chaining: `judge -> distill -> extract_pattern -> check_habit_formation -> update_state`. Without this, callers manually orchestrate 5 engine calls. This is the main orchestration method for Flow A steps 6-11. | [C] | Open |
| H2 | `hippocampus.py:get_summary()` | **Three fields always empty** — `top_patterns`, `recent_learnings`, `recent_promotions` never populated. Spec fills them from `PatternLearner.get_top_patterns()`, last 5 dynamic memories, and `PromotionEngine.get_recent_promotions()`. | [C] | Open |
| H3 | `reasoning_bank.py:consolidate()` | **Prune step can delete promotion candidates** — Prune deletes memories >30 days, <5 uses, <0.3 confidence without checking promotion eligibility. Spec guards: `if not self._is_promotion_candidate(mem)`. Fix: Add `qualifies_for_static()` guard before pruning. | [C] | **Resolved** — `ReasoningBankConfig` now carries promotion thresholds, `ReasoningBank` checks `_is_promotion_candidate()` before `stale_prune`, and `Hippocampus.create()` wires the thresholds from `HippocampusConfig` |
| H4 | `profile_engine.py:41-50` | **Uses `search(query="")` to list memories** — Embeds empty string for arbitrary cosine ranking, returns only top-k (misses memories), and triggers `_touch()` which mutates usage stats on a read path. Fix: Use `list_by_type()` or a non-mutating list/get-all method. | [BOTH] | Open |
| H5 | `graph_store.py:search()` | **Replaced spec's BM25 re-ranking with cosine** — Spec calls for `bm25_rerank(query, nodes)` after cosine retrieval. BM25 handles keyword/term frequency that cosine on embeddings misses. Document deviation or implement. | [C] | Open |

### HIGH — Correctness (12)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| H6 | `env.py:15-20` | **Process env doesn't override .env values** — Resolution prefers `_DOTENV_VALUES` first. Runtime env overrides are ineffective when `.env` exists — dangerous for deployed credential/config management. Fix: Check `os.getenv()` before `_DOTENV_VALUES`. | [CR] | Open |
| H7 | `settings.py:31-34` | **`neo4j_password` stored as plain `str`** — Credentials as plain `str` increase leakage risk via logs/debug dumps. Fix: Use `pydantic.SecretStr`, unwrap with `.get_secret_value()` only at the Neo4j driver boundary. | [CR] | Open |
| H8 | `time.py:9-13` | **`parse_utc_iso()` doesn't normalize aware timestamps to UTC** — Returns timezone-aware values without converting to UTC. Function contract says "ensure UTC" but a `+05:30` timestamp passes through unchanged. Fix: `return dt.astimezone(UTC)` for aware datetimes. | [CR] | Open |
| H9 | `similarity.py:6-15` | **Silently compares mismatched embedding dimensions** — `cosine_similarity()` uses `zip()` which only compares the shared prefix. Mixed-dimension embeddings produce arbitrary rankings in retrieval, dedup, and contradiction checks. Fix: `if len(a) != len(b): raise ValueError`. | [CR] | Open |
| H10 | `static.py:53-82` | **Superseded static version not hidden from retrieval** — `update()` writes a new `MemoryUnit` but leaves the old version live. `search()` and `list_by_type()` return both old and new content after an update. Fix: Soft-delete the prior version or add a latest-version flag. Previously tracked as M2.1. | [CR] | **Resolved** — `StaticMemory.update()` now soft-deletes the superseded version so only the latest version remains live for retrieval |
| H11 | `static.py:80-81` | **UPDATES edge has no corresponding GraphEntity nodes** — Creates an `UPDATES` edge between `MemoryUnit` ids, but `get_version_history()` walks `GraphEntity` nodes and `cypher_query()` returns `[]` when the start id isn't in `_nodes`. Version history is broken. Fix: Create corresponding `GraphEntity` nodes or use consistent id mapping. | [CR] | Open |
| H12 | `extractor.py:94-102` | **Accepts hallucinated UPDATE/DELETE target_ids from LLM** — LLM can return any `target_id`. A hallucinated or stale id can delete unrelated memory. Fix: Only honor UPDATE/DELETE when `target_id` is in the `existing` candidate set. | [CR] | Open |
| H13 | `sqlite_pattern.py:41-46` | **`update_status()` ignores agent scoping** — Updates by `pattern_id` without checking `self._agent_id`. Can cross tenant boundaries. Fix: Add agent ownership check before delegating. | [CR] | Open |
| H14 | `priming.py:19-37` | **Signal not clamped, can push state outside 0..1** — `update_state()` accepts any float. Values like `2.0` or `-3.0` drive confidence/caution/morale outside expected range. Fix: `bounded_signal = max(-1.0, min(signal, 1.0))`. | [CR] | Open |
| H15 | `profile_engine.py:52-64` | **Procedural/priming not scoped to startup_id** — Static/dynamic use scoped container `startup:{id}:emp:{agent_id}`, but `get_active()` and `get_current_state()` query only by `agent_id`. Multi-startup agents leak habits and priming state across identity boundaries. | [CR] | Open |
| H16 | `in_memory_graph.py:97-123` | **`cypher_query()` ignores query, always walks UPDATES chain** — Ignores the `query` parameter entirely and always traverses the first outgoing `UPDATES` chain. Any non-history query returns misleading data. Also ignores `ORDER BY` so in-memory and Neo4j backends return different orderings. Fix: Recognize supported query pattern or raise `NotImplementedError`. | [CR] | Open |
| H17 | `test_promotion_engine.py:240-250` | **Probation test encodes the bug as expected behavior** — Sets `probation_until` to 2 days in the future but expects immediate demotion. Locks in the backwards `now < probation_end` logic from C3. Fix: Change to `utc_now() - timedelta(days=2)` (expired probation). | [CR] | **Resolved** — fixed alongside C3 |

### HIGH — Code Quality (4)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| H18 | `factory.py` | **Return types are concrete classes instead of protocols** — `create_vector_store()` returns `InMemoryVectorStore` not `VectorStore`. Type checkers won't catch code that uses concrete-only methods. | [C] | Open |
| H19 | `tiers/static.py` + `tiers/dynamic.py` | **`source_type="remember"` for extractor path too** — `add()` hardcodes `source_type="remember"`. When called from `MemoryExtractor`, should be `"extraction"`. Fix: Accept optional `source_type` parameter. | [C] | Open |
| H20 | `sqlite_relational.py:22-30` | **`initialize()` races on first concurrent call** — Two concurrent first calls both open a connection, race schema setup, overwrite `self._connection`, leaking one handle. Fix: Acquire `self._lock` in `initialize()`, re-check `_initialized` inside. | [CR] | Open |
| H21 | `dynamic.py:13-25` | **No validation of `half_life_days`** — `0` crashes `_decay_factor()` (division by zero), negative values make older memories gain weight. Fix: `if half_life_days <= 0: raise ValueError`. | [CR] | Open |

### MEDIUM (13)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| M1 | `working.py:20-25` | **`append_conversation` race condition** — Read-modify-write not atomic. Concurrent appends to same `task_id` can lose messages. Fix: Use backend-level atomic append or locking. | [BOTH] | Open |
| M2 | `graph_store.py:close()` | **Uses `getattr` instead of protocol method** — `GraphStoreBackend` protocol doesn't define `close()`. Fix: Add `close()` to protocol. | [C] | Open |
| M3 | `Hippocampus_improv.md` | **Resolved items still listed as deferred** — M2, M3, L3, M5 implemented in Phase 3-4 but still appeared under "Deferred". | [C] | Resolved (this update) |
| M4 | `hippocampus.py` | **No module-level docstring** — Class docstring exists but no module-level explanation of the 5-tier architecture and engine relationships. | [C] | Open |
| M5 | `promotion_engine.py` | **No promotion event persistence** — Events returned from `run_promotions()` are fire-and-forget. Need storage for `get_recent_promotions()`. Blocks C4 fix. | [C] | **Resolved** — added `_event_log` list, `run_promotions()` appends events, `get_recent_promotions(limit)` returns stored events |
| M6 | `tiers/__init__.py` | **Empty file** — Inconsistent with other packages that have proper exports. | [C] | Open |
| M7 | `reasoning_bank.py:consolidate()` | **Iterates stale list, wastes LLM calls** — After dedup deletes items, contradiction loop still calls `llm_light.classify()` for deleted pairs. Fix: Filter `memories` through `deleted_ids` between loops. | [C] | Open |
| M8 | `reasoning_bank.py:_ordered_pair()` | **Confusing return semantics** — Without/with `keep_higher` returns opposite ordering conventions. Fix: Split into `pick_victim()` and `pick_primary()`. | [C] | Open |
| M9 | `in_memory_pattern.py:find_similar()` | **No agent_id filtering** — `list_all()` filters by `self._agent_id` but `find_similar()` doesn't. Cross-agent pattern leakage. Fix: Add `self._agent_id` filter. | [BOTH] | Open |
| M10 | `sqlite_relational.py:initialize()` | **`INSERT OR REPLACE` overwrites existing data** — Re-initializing resets accumulated priming state. Fix: Use `INSERT OR IGNORE`. | [C] | Open |
| M11 | `memory_projections.py:48-57` | **Edges hardcoded as "related_to" with weight 1.0** — Discards actual `RelationType` and weight. Star topology assumption also wrong for multi-hop graphs where `depth > 1`. | [CR] | Open |
| M12 | `extractor.py:121-129` | **Creates habit with empty trigger** — If no `->` found, `_split_procedural_text()` returns `("", text)` but extractor still stores as active `Habit`. Fix: Validate trigger is non-empty; fallback to dynamic memory. | [CR] | Open |
| M13 | `hippocampus.py:301-314` | **`search()` `agent_id` param accepted then deleted** — `del agent_id` on line 308. Either use it (relates to C2) or remove the parameter. | [CR] | Open |

### LOW (14)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| L1 | `neo4j_graph.py` | **Import-time try/except for neo4j driver** — Consider lazy import inside class methods or factory. | [C] | Open |
| L2 | `config.py` | **`embedding_dimensions` default 1536 vs test 32** — Worth a comment noting test override. | [C] | Open |
| L3 | `tiers/dynamic.py` | **Decay applied at search time only, no background sweep** — Acceptable; document that GC handles bulk decay. | [C] | Open |
| L4 | `env.py:resolve_env()` | **Loads `.env` on every call** — Cache parsed env dict at module level or use `functools.lru_cache`. | [C] | Open |
| L5 | `azure_openai_llm.py` | **No retry/backoff on Azure API calls** — Add tenacity or exponential backoff for production readiness. | [C] | Open |
| L6 | `simple_embedding.py:17-30` | **No dimensions > 0 validation** — `dimensions <= 0` crashes `embed()` with modulo error. Fix: Guard in `__init__`. | [CR] | Open |
| L7 | `noop_llm.py:31-33` | **`classify()` no guard against empty options** — `options[0]` raises `IndexError`. Fix: Raise `ValueError`. | [CR] | Open |
| L8 | `azure_openai_llm.py:247-252` | **`_parse_datetime` no error handling** — `fromisoformat` raises `ValueError` for non-ISO strings. Fix: Wrap in try/except, return `None`. | [CR] | Open |
| L9 | `graph_store.py:95` | **Redundant `max(top_k * 3, top_k)`** — Always equals `top_k * 3`. Simplify. | [CR] | Open |
| L10 | `engines/__init__.py` | **Only exports 2 of 6 engines, stale docstring** — Says "Phase 2". Missing PatternLearner, ReasoningBank, PromotionEngine, GC. | [C] | Open |
| L11 | `in_memory_pattern.py:50-64` | **Manual Pattern reconstruction** — Use `dataclasses.replace(existing, status=status)` instead of verbose field-by-field copy. | [CR] | Open |
| L12 | `reasoning_bank.py:40-57` | **`pattern_store` parameter unused** — `self._pattern_store` assigned but never referenced in any method. Remove or document. | [CR] | Open |
| L13 | `delegation_memory.py:42-46` | **Should pass `include_graph=False`** — Recall includes graph results that are immediately filtered out. Wastes `top_k` slots. | [CR] | Open |
| L14 | `working.py:27-35` | **Scratchpad read but no write method** — `get_current_context` returns `scratchpad` field but there's no `set_scratchpad()`. | [CR] | Open |

### TEST QUALITY (12)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| T1 | `delegation_memory.py` | **No test for quality-gated internalization rejection** — Tests cover success but not the rejection path when quality score is below threshold. | [C] | Open |
| T2 | `reasoning_bank.py` | **No test for consolidation merge step** — The merge path (0.90-0.95 similarity + same domain + LLM merge) is untested. Most complex consolidation path. | [C] | Open |
| T3 | `pattern_learner.py` | **No test for habit formation threshold** — `check_habit_formation()` threshold boundaries untested (just below -> no habit, at threshold -> habit formed). | [C] | Open |
| T4 | `memory_projections.py` | **No test for `get_graph_view()`** — Only `get_summary` tested. `get_graph_view()` has its own logic for center node, neighbors, and edges. | [C] | Open |
| T5 | `priming.py` | **No test for EMA state update math** — The EMA formula `new = old * (1 - lr) + observed * lr` with `lr=0.15` is untested. Should verify specific numeric outputs. | [C] | Open |
| T6 | GC integration | **Full GC integration test missing** — `test_gc.py` tests orchestration with mocks but no test runs: add memories -> run GC -> verify correct dedup/prune/promote/decay. | [C] | Open |
| T7 | `memory_projections.py` | **No test for `get_promotion_stream`** — Untested. Once C4 is fixed, test should verify stored promotion events. | [C] | Open |
| T8 | `test_memory_scope.py:26-72` | **Doesn't close Hippocampus (resource leak)** — Creates SQLite-backed `Hippocampus` but never calls `close()`. Leaves open handles, can cause flaky tests. Fix: Wrap in try/finally. | [CR] | Open |
| T9 | `test_hippocampus.py:16-36` | **Close in fixture/finally (4 tests)** — Cleanup happens after assertions. If assert fails, instance stays open and leaks SQLite/graph resources. Also applies to lines 47-67, 78-94, 105-124. | [CR] | Open |
| T10 | `test_tiers.py:104-110` | **Assert on `fresh.id` instead of `expired_candidate.id`** — Works because `replace()` preserves id, but assertion reads as if checking for `fresh` when actually checking `expired_candidate`. Fix: Assert on `expired_candidate.id`. | [CR] | Open |
| T11 | `test_memory_projections.py:53-59` | **Accesses private `_embedding` attribute** — Uses `hippocampus._embedding.embed()`. Couples test to internals. Fix: Use test's own `MockEmbeddingEngine` instance. | [CR] | Open |
| T12 | `test_phase2_graph_and_extractor.py:75-90` | **FakeHippocampus drops `procedural_memory` attr** — Real object exposes `procedural_memory` even when `None`; fake conditionally sets it. Exercises different branch than production. Fix: Always assign `self.procedural_memory = procedural_memory`. | [CR] | Open |

---

## Standalone Improvements (carried forward)

Issues not tied to any specific review finding but would improve code quality.

| # | Issue | Description | Severity | Status |
|---|-------|-------------|----------|--------|
| S1 | `memory_scope.py` O(n^2) dedup | Nested loop with set tracking. Acceptable at current scale. | MEDIUM | Open |
| S3 | `_soft_delete` in extractor uses `getattr` | `extractor.py:148` accesses `self._hippocampus._vector_store` via `getattr`. Fragile. | MEDIUM | Open — related to C5 |
| S6 | Test coverage gaps (general) | No tests for: SQLite habit/pattern CRUD, `DynamicMemory.find_decayed()` math, MMR lambda sensitivity, `find_expired()`, graph `get_neighbors` BFS. | MEDIUM | Open |
| S8 | Mixed datetime imports | Some files import `datetime` from stdlib, others use `utils/time.py`. Inconsistent timezone handling risk. | LOW | Open |
| S11 | O(E) edge scan in `InMemoryGraphStoreBackend` | `get_edges()` does linear scan over all edges. Fine for tests but won't scale. | LOW | Open |

---

## Phase 2 New Issues (carried forward)

| # | Issue | Description | Status |
|---|-------|-------------|--------|
| L2.1 | `ExtractionMode.CONVERSATION` maps to `AGENT_EXTRACTION_PROMPT` | Uses same prompt as AGENT mode. Spec implies distinct extraction behavior. | Open |
| L2.2 | No integration test for `extract_from_conversation` on real `Hippocampus` | All extraction tests use `FakeHippocampus`. | Open |

---

## Summary

| Severity | Count | Open | Resolved |
|----------|-------|------|----------|
| Critical | 8 | 0 | 8 (C1, C3, C4, C5, C6, C8, C9, M5) |
| High | 22 | 21 | 1 (H17) |
| Medium | 13 | 11 | 2 (M3, M5) |
| Low | 14 | 14 | 0 |
| Test Quality | 12 | 12 | 0 |
| Standalone | 5 | 5 | 0 |
| Phase 2 Carry | 2 | 2 | 0 |
| **Total** | **76** | **65** | **11** |

**Recommended fix order:**
1. C1-C3 (crashes + tenant bleed + inverted logic)
2. C4-C9 (remaining criticals)
3. H6-H12 (correctness — env precedence, timestamps, dimensions, superseded versions, hallucinated ids)
4. H1-H5 (spec gaps)
5. H13-H21 (remaining highs)
6. MEDIUMs -> LOWs -> Tests

---

## Future Improvements

Architectural improvements that require broader API changes. Not bugs — the current code works correctly, but these would improve encapsulation and maintainability.

### F1: `DelegationMemoryManager` bypasses Hippocampus public API

**Current state:** `prepare_delegation_context()` calls `to_hippocampus._vector_store.upsert(copy)` directly, accessing a private attribute. This works but skips:
- Embedding generation (relies on source embedding being compatible)
- Graph wiring (delegation copies are orphan nodes)
- Tier routing logic

**Why not fixed now:** The public `remember()` API only accepts `(content, container, memory_type)`. Switching to it loses delegation metadata (`source_type="delegation"`, `source_id`, `provenance`, `metadata.delegated_from`). The audit trail matters more than encapsulation purity.

**How to fix:**
1. Add an `ingest()` method on `Hippocampus` that accepts a full `MemoryUnit` (or a builder/kwargs):
   ```python
   async def ingest(
       self,
       content: str,
       container: str,
       memory_type: MemoryType = MemoryType.DYNAMIC,
       source_type: str = "",
       source_id: str = "",
       provenance: str = "",
       visibility: MemoryVisibility = MemoryVisibility.PRIVATE,
       metadata: dict | None = None,
   ) -> MemoryUnit:
   ```
2. Route through the appropriate tier `add()` (extend tier methods to accept optional fields)
3. Replace `_vector_store.upsert()` in `delegation_memory.py` with `to_hippocampus.ingest(...)`
4. This also benefits `internalize_delegation_result()` which currently loses source tracking too

**When:** Phase 5+ when building the startup-shared write path (same API gap applies there)

### F2: Soft-delete compaction and historical version retention

**Current state:** `StaticMemory.update()` now soft-deletes superseded versions so only the latest fact stays live for retrieval. This fixes correctness, but historical versions still remain in storage.

**Why not fixed now:** Hiding outdated facts from retrieval is the immediate bug fix. Storage optimization is a separate retention-policy problem and would add more moving parts than we want in the MVP path.

**How to optimize later:**
1. Keep soft-delete on the write path so live retrieval remains correct
2. Add a compaction job that archives or purges soft-deleted records older than a retention window
3. Optionally keep only the latest `K` versions per version chain in hot storage
4. Move older versions to cold storage when audit/provenance still matters

**When:** Post-MVP, once memory history volume starts affecting storage cost or scan performance

### F3: Centralize promotion and pruning policy into a shared lifecycle module

**Current state:** `ReasoningBank` now mirrors promotion thresholds from `HippocampusConfig` so prune decisions do not conflict with promotion eligibility. This is robust enough for the MVP because both systems stay aligned through config.

**Why not fixed now:** Extracting a dedicated lifecycle-policy abstraction would touch `ReasoningBank`, `PromotionEngine`, `GC`, config, and tests. The config-driven alignment solves the correctness issue with minimal surface area today.

**How to improve later:**
1. Introduce a shared `MemoryLifecyclePolicy` module
2. Move promotion-candidate evaluation into that single policy
3. Have both `ReasoningBank` and `PromotionEngine` call the same policy instead of carrying parallel logic
4. Add one cross-engine lifecycle test suite that verifies prune, promote, and demote decisions together

**When:** Post-MVP, once lifecycle decisions become more complex than simple threshold checks or when additional tiers/promotion paths are added
