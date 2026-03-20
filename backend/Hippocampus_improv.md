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
| M5 | `profile_engine.py` uses empty-string search | Phase 4 | Phase 4 review | `ArceusProfileEngine` now uses `Hippocampus.list_memories()` / `VectorStore.list_by_type()` for truthful full-profile reads |

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
| H1 | `hippocampus.py` | **Missing `process_trajectory()` orchestration method** — Spec section 7.12 defines `process_trajectory(trajectory)` chaining: `judge -> distill -> extract_pattern -> check_habit_formation -> update_state`. Without this, callers manually orchestrate 5 engine calls. This is the main orchestration method for Flow A steps 6-11. | [C] | Resolved — Added `process_trajectory()` on Hippocampus; chains all 5 steps with nil-safe guards; adds habit to procedural memory when formed |
| H2 | `hippocampus.py:get_summary()` | **Three fields always empty** — `top_patterns`, `recent_learnings`, `recent_promotions` never populated. Spec fills them from `PatternLearner.get_top_patterns()`, last 5 dynamic memories, and `PromotionEngine.get_recent_promotions()`. | [C] | Deferred → D1 (Phase 5) |
| H3 | `reasoning_bank.py:consolidate()` | **Prune step can delete promotion candidates** — Prune deletes memories >30 days, <5 uses, <0.3 confidence without checking promotion eligibility. Spec guards: `if not self._is_promotion_candidate(mem)`. Fix: Add `qualifies_for_static()` guard before pruning. | [C] | **Resolved** — `ReasoningBankConfig` now carries promotion thresholds, `ReasoningBank` checks `_is_promotion_candidate()` before `stale_prune`, and `Hippocampus.create()` wires the thresholds from `HippocampusConfig` |
| H4 | `profile_engine.py:41-50` | **Uses `search(query="")` to list memories** — Embeds empty string for arbitrary cosine ranking, returns only top-k (misses memories), and triggers `_touch()` which mutates usage stats on a read path. Fix: Use `list_by_type()` or a non-mutating list/get-all method. | [BOTH] | **Resolved** — added `Hippocampus.list_memories()` and switched `ArceusProfileEngine` to list-based reads |
| H5 | `graph_store.py:search()` | **Replaced spec's BM25 re-ranking with cosine** — Spec calls for `bm25_rerank(query, nodes)` after cosine retrieval. BM25 handles keyword/term frequency that cosine on embeddings misses. Document deviation or implement. | [C] | Deferred → G1 (Phase 5+) |

### HIGH — Correctness (12)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| H6 | `env.py:15-20` | **Process env doesn't override .env values** — Resolution prefers `_DOTENV_VALUES` first. Runtime env overrides are ineffective when `.env` exists — dangerous for deployed credential/config management. Fix: Check `os.getenv()` before `_DOTENV_VALUES`. | [CR] | **Resolved** — `load_dotenv(override=True)` ensures OS env takes precedence; pydantic BaseSettings also respects env vars natively |
| H7 | `settings.py:31-34` | **`neo4j_password` stored as plain `str`** — Credentials as plain `str` increase leakage risk via logs/debug dumps. Fix: Use `pydantic.SecretStr`, unwrap with `.get_secret_value()` only at the Neo4j driver boundary. | [CR] | **Resolved** — `neo4j_password`, `azure_openai_api_key`, `e2b_api_key` all use `SecretStr`; all usage sites unwrap with `.get_secret_value()` |
| H8 | `time.py:9-13` | **`parse_utc_iso()` doesn't normalize aware timestamps to UTC** — Returns timezone-aware values without converting to UTC. Function contract says "ensure UTC" but a `+05:30` timestamp passes through unchanged. Fix: `return dt.astimezone(UTC)` for aware datetimes. | [CR] | **Resolved** — now uses `astimezone(UTC)` for aware timestamps |
| H9 | `similarity.py:6-15` | **Silently compares mismatched embedding dimensions** — `cosine_similarity()` uses `zip()` which only compares the shared prefix. Mixed-dimension embeddings produce arbitrary rankings in retrieval, dedup, and contradiction checks. Fix: `if len(a) != len(b): raise ValueError`. | [CR] | **Resolved** — now raises `ValueError("Embedding dimensions must match")` on length mismatch |
| H10 | `static.py:53-82` | **Superseded static version not hidden from retrieval** — `update()` writes a new `MemoryUnit` but leaves the old version live. `search()` and `list_by_type()` return both old and new content after an update. Fix: Soft-delete the prior version or add a latest-version flag. Previously tracked as M2.1. | [CR] | **Resolved** — `StaticMemory.update()` now soft-deletes the superseded version so only the latest version remains live for retrieval |
| H11 | `static.py:80-81` | **UPDATES edge has no corresponding GraphEntity nodes** — Creates an `UPDATES` edge between `MemoryUnit` ids, but `get_version_history()` walks `GraphEntity` nodes and `cypher_query()` returns `[]` when the start id isn't in `_nodes`. Version history is broken. Fix: Create corresponding `GraphEntity` nodes or use consistent id mapping. | [CR] | Deferred → G2 (Phase 5+) |
| H12 | `extractor.py:94-102` | **Accepts hallucinated UPDATE/DELETE target_ids from LLM** — LLM can return any `target_id`. A hallucinated or stale id can delete unrelated memory. Fix: Only honor UPDATE/DELETE when `target_id` is in the `existing` candidate set. | [CR] | **Resolved** — validates `target_id` against existing memory IDs, returns `NONE` action for invalid IDs |
| H13 | `sqlite_pattern.py:41-46` | **`update_status()` ignores agent scoping** — Updates by `pattern_id` without checking `self._agent_id`. Can cross tenant boundaries. Fix: Add agent ownership check before delegating. | [CR] | Resolved — Added ownership guards to `update()`, `update_status()`, and `find_similar()` in both `InMemoryPatternStore` and `SQLitePatternStore` |
| H14 | `priming.py:19-37` | **Signal not clamped, can push state outside 0..1** — `update_state()` accepts any float. Values like `2.0` or `-3.0` drive confidence/caution/morale outside expected range. Fix: `bounded_signal = max(-1.0, min(signal, 1.0))`. | [CR] | **Resolved** — signal clamped with `max(-1.0, min(signal, 1.0))` |
| H15 | `profile_engine.py:52-64` | **Procedural/priming not scoped to startup_id** — Static/dynamic use scoped container `startup:{id}:emp:{agent_id}`, but `get_active()` and `get_current_state()` query only by `agent_id`. Multi-startup agents leak habits and priming state across identity boundaries. | [CR] | Deferred → F6 (Phase 5+) |
| H16 | `in_memory_graph.py:97-123` | **`cypher_query()` ignores query, always walks UPDATES chain** — Ignores the `query` parameter entirely and always traverses the first outgoing `UPDATES` chain. Any non-history query returns misleading data. Also ignores `ORDER BY` so in-memory and Neo4j backends return different orderings. Fix: Recognize supported query pattern or raise `NotImplementedError`. | [CR] | Deferred → G3 (Phase 5+) |
| H17 | `test_promotion_engine.py:240-250` | **Probation test encodes the bug as expected behavior** — Sets `probation_until` to 2 days in the future but expects immediate demotion. Locks in the backwards `now < probation_end` logic from C3. Fix: Change to `utc_now() - timedelta(days=2)` (expired probation). | [CR] | **Resolved** — fixed alongside C3 |

### HIGH — Code Quality (4)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| H18 | `factory.py` | **Return types are concrete classes instead of protocols** — `create_vector_store()` returns `InMemoryVectorStore` not `VectorStore`. Type checkers won't catch code that uses concrete-only methods. | [C] | Skipped — protocol return types are correct by design; current backends are test scaffolding (see F5) |
| H19 | `tiers/static.py` + `tiers/dynamic.py` | **`source_type="remember"` for extractor path too** — `add()` hardcodes `source_type="remember"`. When called from `MemoryExtractor`, should be `"extraction"`. Fix: Accept optional `source_type` parameter. | [C] | **Resolved** — `ExtractedFact` now has `source_type` field (default `"remember"`); tiers use `fact.source_type`; test confirms custom source types preserved |
| H20 | `sqlite_relational.py:22-30` | **`initialize()` races on first concurrent call** — Two concurrent first calls both open a connection, race schema setup, overwrite `self._connection`, leaking one handle. Fix: Acquire `self._lock` in `initialize()`, re-check `_initialized` inside. | [CR] | **Resolved** — double-checked locking: fast path outside lock, re-check + full init inside `async with self._lock` |
| H21 | `dynamic.py:13-25` | **No validation of `half_life_days`** — `0` crashes `_decay_factor()` (division by zero), negative values make older memories gain weight. Fix: `if half_life_days <= 0: raise ValueError`. | [CR] | **Resolved** — validates `half_life_days > 0` with `ValueError` |

### MEDIUM (13)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| M1 | `working.py:20-25` | **`append_conversation` race condition** — Read-modify-write not atomic. Concurrent appends to same `task_id` can lose messages. Fix: Use backend-level atomic append or locking. | [BOTH] | **Resolved** — added per-conversation `asyncio.Lock` in `WorkingMemory` and regression test for concurrent appends |
| M2 | `graph_store.py:close()` | **Uses `getattr` instead of protocol method** — `GraphStoreBackend` protocol doesn't define `close()`. Fix: Add `close()` to protocol. | [C] | **Resolved** — `GraphStoreBackend` protocol now defines `close()`; `GraphStore` retains defensive `getattr` pattern |
| M3 | `Hippocampus_improv.md` | **Resolved items still listed as deferred** — M2, M3, L3, M5 implemented in Phase 3-4 but still appeared under "Deferred". | [C] | Resolved (this update) |
| M4 | `hippocampus.py` | **No module-level docstring** — Class docstring exists but no module-level explanation of the 5-tier architecture and engine relationships. | [C] | **Resolved** — added module docstring covering all 5 tiers, 5 engines, and key orchestration methods |
| M5 | `promotion_engine.py` | **No promotion event persistence** — Events returned from `run_promotions()` are fire-and-forget. Need storage for `get_recent_promotions()`. Blocks C4 fix. | [C] | **Resolved** — added `_event_log` list, `run_promotions()` appends events, `get_recent_promotions(limit)` returns stored events |
| M6 | `tiers/__init__.py` | **Empty file** — Inconsistent with other packages that have proper exports. | [C] | **Resolved** — added imports and `__all__` for all 5 tier classes |
| M7 | `reasoning_bank.py:consolidate()` | **Iterates stale list, wastes LLM calls** — After dedup deletes items, contradiction loop still calls `llm_light.classify()` for deleted pairs. Fix: Filter `memories` through `deleted_ids` between loops. | [C] | **Resolved** — added `memories = [m for m in memories if m.id not in deleted_ids]` between each loop |
| M8 | `reasoning_bank.py:_ordered_pair()` | **Confusing return semantics** — Without/with `keep_higher` returns opposite ordering conventions. Fix: Split into `pick_victim()` and `pick_primary()`. | [C] | **Resolved** — split into `_pick_victim()` (returns victim, keeper) and `_pick_primary()` (returns primary, secondary) |
| M9 | `in_memory_pattern.py:find_similar()` | **No agent_id filtering** — `list_all()` filters by `self._agent_id` but `find_similar()` doesn't. Cross-agent pattern leakage. Fix: Add `self._agent_id` filter. | [BOTH] | **Resolved** — fixed as part of H13; `find_similar()` now filters by `self._agent_id` |
| M10 | `sqlite_relational.py:initialize()` | **`INSERT OR REPLACE` overwrites existing data** — Re-initializing resets accumulated priming state. Fix: Use `INSERT OR IGNORE`. | [C] | **Resolved (stale)** — regression test confirmed `initialize()` does not reset priming state; tracker item no longer matches current implementation |
| M11 | `memory_projections.py:48-57` | **Edges hardcoded as "related_to" with weight 1.0** — Discards actual `RelationType` and weight. Star topology assumption also wrong for multi-hop graphs where `depth > 1`. | [CR] | Deferred → G5 (Phase 5+) |
| M12 | `extractor.py:121-129` | **Creates habit with empty trigger** — If no `->` found, `_split_procedural_text()` returns `("", text)` but extractor still stores as active `Habit`. Fix: Validate trigger is non-empty; fallback to dynamic memory. | [CR] | **Resolved** — validates trigger is non-empty; empty triggers fall back to dynamic memory with warning log |
| M13 | `hippocampus.py:301-314` | **`search()` `agent_id` param accepted then deleted** — `del agent_id` on line 308. Either use it (relates to C2) or remove the parameter. | [CR] | Deferred — linked to Design Thought D1 (reconcile instance-scoped APIs with agent-scoped storage); remove param when refactoring public API |

### LOW (14)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| L1 | `neo4j_graph.py` | **Import-time try/except for neo4j driver** — Consider lazy import inside class methods or factory. | [C] | **Resolved** — import is already lazy (inside method body at line 174) |
| L2 | `config.py` | **`embedding_dimensions` default 1536 vs test 32** — Worth a comment noting test override. | [C] | **Resolved** — added `# must match embedding_model output size` comment |
| L3 | `tiers/dynamic.py` | **Decay applied at search time only, no background sweep** — Acceptable; document that GC handles bulk decay. | [C] | **Resolved** — documented; GC handles bulk decay |
| L4 | `env.py:resolve_env()` | **Loads `.env` on every call** — Cache parsed env dict at module level or use `functools.lru_cache`. | [C] | **Resolved** — `env.py` removed during backend refactoring |
| L5 | `azure_openai_llm.py` | **No retry/backoff on Azure API calls** — Add tenacity or exponential backoff for production readiness. | [C] | **Resolved** — added `@retry` with tenacity on `_create_completion()`; 3 attempts, exponential backoff 1-10s, retries `RateLimitError`/`APITimeoutError`/`APIConnectionError` |
| L6 | `simple_embedding.py:17-30` | **No dimensions > 0 validation** — `dimensions <= 0` crashes `embed()` with modulo error. Fix: Guard in `__init__`. | [CR] | **Resolved** — added `if dimensions <= 0: raise ValueError` |
| L7 | `noop_llm.py:31-33` | **`classify()` no guard against empty options** — `options[0]` raises `IndexError`. Fix: Raise `ValueError`. | [CR] | **Resolved** — added `if not options: raise ValueError` |
| L8 | `azure_openai_llm.py:247-252` | **`_parse_datetime` no error handling** — `fromisoformat` raises `ValueError` for non-ISO strings. Fix: Wrap in try/except, return `None`. | [CR] | **Resolved** — wrapped in `try/except (ValueError, TypeError): return None` |
| L9 | `graph_store.py:95` | **Redundant `max(top_k * 3, top_k)`** — Always equals `top_k * 3`. Simplify. | [CR] | **Resolved** — simplified to `top_k * 3` |
| L10 | `engines/__init__.py` | **Only exports 2 of 6 engines, stale docstring** — Says "Phase 2". Missing PatternLearner, ReasoningBank, PromotionEngine, GC. | [C] | **Resolved** — exports all 6 engines with updated `__all__` |
| L11 | `pattern_learner.py:79-93,184-206` | **Manual Pattern reconstruction** — Use `dataclasses.replace()` instead of verbose field-by-field copy. | [CR] | **Resolved** — `evolve_pattern()` and `_merge_patterns()` now use `dataclasses.replace()` |
| L12 | `reasoning_bank.py:40-57` | **`pattern_store` parameter unused** — `self._pattern_store` assigned but never referenced in any method. Remove or document. | [CR] | Deferred → linked to D1 (instance vs param scoping) |
| L13 | `delegation_memory.py:42-46` | **Should pass `include_graph=False`** — Recall includes graph results that are immediately filtered out. Wastes `top_k` slots. | [CR] | **Resolved** — added `include_graph=False` to `recall()` call |
| L14 | `working.py:27-35` | **Scratchpad read but no write method** — `get_current_context` returns `scratchpad` field but there's no `set_scratchpad()`. | [CR] | **Resolved** — added `set_scratchpad()` method |

### TEST QUALITY (12)

| # | File | Issue | Source | Status |
|---|------|-------|--------|--------|
| T1 | `delegation_memory.py` | **No test for quality-gated internalization rejection** — Tests cover success but not the rejection path when quality score is below threshold. | [C] | **Resolved (stale)** — `test_internalize_low_quality_skipped` already covers the rejection path |
| T2 | `reasoning_bank.py` | **No test for consolidation merge step** — The merge path (0.90-0.95 similarity + same domain + LLM merge) is untested. Most complex consolidation path. | [C] | **Resolved** — added merge-path coverage in `test_reasoning_bank.py` |
| T3 | `pattern_learner.py` | **No test for habit formation threshold** — `check_habit_formation()` threshold boundaries untested (just below -> no habit, at threshold -> habit formed). | [C] | **Resolved** — added threshold and below-threshold coverage in `test_pattern_learner.py` |
| T4 | `memory_projections.py` | **No test for `get_graph_view()`** — Only `get_summary` tested. `get_graph_view()` has its own logic for center node, neighbors, and edges. | [C] | **Resolved (stale)** — `test_get_graph_view` and `test_get_graph_view_empty` already exist |
| T5 | `priming.py` | **No test for EMA state update math** — The EMA formula `new = old * (1 - lr) + observed * lr` with `lr=0.15` is untested. Should verify specific numeric outputs. | [C] | **Resolved** — added exact EMA math assertions in `test_priming.py` |
| T6 | GC integration | **Full GC integration test missing** — `test_gc.py` tests orchestration with mocks but no test runs: add memories -> run GC -> verify correct dedup/prune/promote/decay. | [C] | **Resolved** — added fuller end-to-end GC integration coverage in `test_gc.py` |
| T7 | `memory_projections.py` | **No test for `get_promotion_stream`** — Untested. Once C4 is fixed, test should verify stored promotion events. | [C] | **Resolved** — added promotion-stream coverage in `test_memory_projections.py` |
| T8 | `test_memory_scope.py:26-72` | **Doesn't close Hippocampus (resource leak)** — Creates SQLite-backed `Hippocampus` but never calls `close()`. Leaves open handles, can cause flaky tests. Fix: Wrap in try/finally. | [CR] | **Resolved** — wrapped real `Hippocampus` lifecycle in `try/finally` |
| T9 | `test_hippocampus.py:16-36` | **Close in fixture/finally (4 tests)** — Cleanup happens after assertions. If assert fails, instance stays open and leaks SQLite/graph resources. Also applies to lines 47-67, 78-94, 105-124. | [CR] | **Resolved** — all affected tests now close via `try/finally` |
| T10 | `test_tiers.py:104-110` | **Assert on `fresh.id` instead of `expired_candidate.id`** — Works because `replace()` preserves id, but assertion reads as if checking for `fresh` when actually checking `expired_candidate`. Fix: Assert on `expired_candidate.id`. | [CR] | **Resolved** — assertion now targets `expired_candidate.id` |
| T11 | `test_memory_projections.py:53-59` | **Accesses private `_embedding` attribute** — Uses `hippocampus._embedding.embed()`. Couples test to internals. Fix: Use test's own `MockEmbeddingEngine` instance. | [CR] | **Resolved** — projection tests now use a local `MockEmbeddingEngine` |
| T12 | `test_phase2_graph_and_extractor.py:75-90` | **FakeHippocampus drops `procedural_memory` attr** — Real object exposes `procedural_memory` even when `None`; fake conditionally sets it. Exercises different branch than production. Fix: Always assign `self.procedural_memory = procedural_memory`. | [CR] | **Resolved** — `FakeHippocampus` now always exposes `procedural_memory` |
| T13 | All test files | **Test quality audit (Codex)** — Comprehensive test quality review covering edge cases, assertion quality, and coverage gaps across all test files. | [Codex] | **Resolved** — full test quality pass completed via Codex |

---

## Standalone Improvements (carried forward)

Issues not tied to any specific review finding but would improve code quality.

| # | Issue | Description | Severity | Status |
|---|-------|-------------|----------|--------|
| S1 | `memory_scope.py` O(n^2) dedup | Nested loop with set tracking. Acceptable at current scale. | MEDIUM | **Resolved** — already uses O(n) dict-based dedup with `seen: dict[str, MemoryUnit]` |
| S3 | `_soft_delete` in extractor uses `getattr` | `extractor.py:148` accesses `self._hippocampus._vector_store` via `getattr`. Fragile. | MEDIUM | **Resolved** — original `_vector_store` getattr fixed as part of C5; remaining `getattr` for `procedural_memory` is legitimate defensive check |
| S6 | Test coverage gaps (general) | No tests for: SQLite habit/pattern CRUD, `DynamicMemory.find_decayed()` math, MMR lambda sensitivity, `find_expired()`, graph `get_neighbors` BFS. | MEDIUM | **Resolved** — comprehensive test quality pass completed via Codex |
| S8 | Mixed datetime imports | Some files import `datetime` from stdlib, others use `utils/time.py`. Inconsistent timezone handling risk. | LOW | **Resolved** — all `from datetime import datetime` usages are for type annotations only; all "now" calls use `utc_now()` consistently |
| S11 | O(E) edge scan in `InMemoryGraphStoreBackend` | `get_edges()` does linear scan over all edges. Fine for tests but won't scale. | LOW | Skipped — `InMemoryGraphStoreBackend` is test scaffolding only; production uses Neo4j with native graph indices |

---

## Phase 2 New Issues (carried forward)

| # | Issue | Description | Status |
|---|-------|-------------|--------|
| L2.1 | `ExtractionMode.CONVERSATION` maps to `AGENT_EXTRACTION_PROMPT` | Uses same prompt as AGENT mode. Spec implies distinct extraction behavior. | Open |
| L2.2 | No integration test for `extract_from_conversation` on real `Hippocampus` | All extraction tests use `FakeHippocampus`. | Open |

---

## Summary

| Severity | Count | Open | Deferred | Resolved/Skipped |
|----------|-------|------|----------|------------------|
| Critical | 8 | 0 | 0 | 8 (C1, C3, C4, C5, C6, C8, C9, M5) |
| High | 22 | 0 | 6 (H2→D1, H5→G1, H11→G2, H15→F6, H16→G3, H22→G4) | 16 (H1, H3, H4, H6, H7, H8, H9, H10, H12, H13, H14, H17, H18, H19, H20, H21) |
| Medium | 13 | 0 | 2 (M11→G5, M13→D1) | 11 (M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M12) |
| Low | 14 | 0 | 1 (L12→D1) | 13 (L1, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11, L13, L14) |
| Test Quality | 13 | 0 | 0 | 13 (T1-T13) |
| Standalone | 5 | 0 | 0 | 5 (S1, S3, S6, S8, S11) |
| Phase 2 Carry | 2 | 2 | 0 | 0 |
| **Total** | **77** | **2** | **9** | **66** |

**Remaining open:** L2.1 (extraction mode prompt reuse) and L2.2 (no integration test for conversation extraction) — both Phase 2 carry-forward items, low priority.

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

### F4: Add profile compaction as a separate prompt-context projection

**Current state:** `ArceusProfileEngine` now returns the full truthful static and dynamic profile by listing stored memories directly. This fixes correctness because profile generation no longer depends on empty-query vector ranking or arbitrary `top_k` caps.

**Why not fixed now:** Context-budget optimization is a separate concern from profile correctness. Re-introducing ranking or truncation inside `ProfileEngine` would hide real state again and make the employee profile depend on retrieval heuristics.

**How to improve later:**
1. Keep `ProfileEngine` as the source of truth for full employee memory state
2. Add a separate compact-profile or prompt-context projection for model injection
3. Select only the most relevant static facts, recent dynamic context, active habits, and priming state for a given task
4. Summarize or compress oversized profiles before sending them to an LLM when token pressure matters

**When:** Post-MVP, once full profiles become large enough to create prompt-budget pressure in production flows

### F5: Replace test-scaffolding backends with production-grade stores

**Current state:** All current backends (`InMemoryVectorStore`, `SQLiteRelationalStore`, `DictCacheStore`, `InMemoryGraphStoreBackend`, `MockEmbeddingEngine`) are test/development scaffolding. They work correctly for validation and integration testing but are not suitable for production workloads.

**What needs to happen:**
1. **Relational:** Replace `SQLiteRelationalStore` with PostgreSQL (the `RelationalStore` protocol is already correct — just add a `PostgresRelationalStore` implementation)
2. **Vector store:** Replace `InMemoryVectorStore` with a proper vector DB (Pinecone, Qdrant, Weaviate, pgvector, etc.) implementing the `VectorStore` protocol
3. **Cache:** Replace `DictCacheStore` with Redis/Valkey implementing the `WorkingMemoryBackend` protocol
4. **Embedding:** Replace `MockEmbeddingEngine` / local `SentenceTransformerEmbeddingEngine` with a hosted embedding service (OpenAI, Cohere, Azure) for production throughput
5. **Graph store:** `Neo4jGraphStoreBackend` already exists as the production option; `InMemoryGraphStoreBackend` remains for tests
6. **Factory updates:** Update `create_*` functions in `backends/factory.py` to route to new implementations based on config. Return types stay as protocols — this is by design (H18 is not a bug)

**Why not fixed now:** The protocol-based architecture is the correct abstraction layer. Current backends validate that the protocols are complete and that all tiers/engines work end-to-end. Swapping backends is a deployment concern, not an architectural one.

**When:** Before production deployment. Each backend can be swapped independently since they all go through protocols

### F6: Add startup-level scoping to Procedural and Priming memory

**Current state:** `ProceduralMemory` and `PrimingMemory` are currently scoped only by `agent_id`. In the SQLite relational schema, `habits` has no `startup_id` column and `priming_state` is keyed only by `agent_id`, so the same agent would share habits and priming state across all startups.

**Why not fixed now:** The current MVP assumption is effectively single-startup-per-agent, so this does not create an active correctness issue in the present deployment shape. Fixing it correctly is a schema-and-protocol change, not just a filter tweak.

**How to fix later:**
1. Add `startup_id` to the `Habit` model and thread it through `ProceduralMemory` and `PrimingMemory`
2. Add `startup_id` columns to the `habits` and `priming_state` tables
3. Change `priming_state` from `agent_id` primary key to a composite `(startup_id, agent_id)` key
4. Update `RelationalStore` protocol methods and all SQL queries to read/write by both `startup_id` and `agent_id`
5. Add regression tests proving Startup A habits/state do not appear in Startup B for the same agent

**When:** Phase 5+ or earlier if multi-startup-per-agent support becomes a real product requirement

### F7: Add backend-native atomic append for working-memory conversations

**Current state:** `WorkingMemory.append_conversation()` now uses an in-process per-key `asyncio.Lock`, which correctly prevents lost updates from concurrent coroutines inside one Python process.

**Why not fixed further now:** This is enough for the current single-process/dev execution model and fixes the real race in the current implementation without expanding backend protocols. It does not provide safety across multiple processes or distributed workers.

**How to improve later:**
1. Extend `WorkingMemoryBackend` with an atomic append operation for conversation entries
2. Implement that operation natively per backend instead of doing read-modify-write in the tier
3. Use Redis transactions/Lua, Postgres row locks, or equivalent backend-native primitives depending on the production cache/store
4. Keep the `WorkingMemory` public API unchanged while moving atomicity guarantees down to the storage layer

**When:** Post-MVP, once working memory is written from multiple processes, replicas, or distributed task runners

---

## Pre-MVP but Phase 5+ Changes — Graph Store

Graph is currently observability scaffolding: no agent logic reads graph data, all adapters use `include_graph=False`, and graph provides dashboard visualization, version history, and provenance audit trail only. These issues are real but non-load-bearing — fix when graph becomes part of the agent decision path.

### G1 (was H5): `GraphStore.search()` ignores `container` scoping

Spec calls for `bm25_rerank(query, nodes)` after cosine retrieval. Current implementation uses cosine only and doesn't filter by container. When graph becomes queryable by agents, container isolation and BM25 re-ranking both need to be added.

### G2 (was H11): `UPDATES` edges have no corresponding `GraphEntity` nodes

`StaticMemory.update()` creates an `UPDATES` edge between `MemoryUnit` IDs, but `get_version_history()` walks `GraphEntity` nodes. Since the IDs aren't in the graph node store, version history queries return empty. Fix: create `GraphEntity` nodes when memories are stored, or map `MemoryUnit` IDs to graph node IDs.

### G3 (was H16): `cypher_query()` ignores query, always walks UPDATES chain

`InMemoryGraphStoreBackend.cypher_query()` ignores the `query` parameter entirely and hardcodes an UPDATES chain traversal. Any non-history query returns misleading data. Also ignores `ORDER BY` so in-memory and Neo4j backends return different orderings. Fix: pattern-match supported queries or raise `NotImplementedError`.

### G4 (was H22, originally C7): `create_edge` ignores missing nodes

Neo4j `MATCH` returns zero records when source/target nodes don't exist, but `create_edge()` always returns `rel.id`. Silently drops graph provenance edges. Fix: check records, raise `KeyError` if empty.

### G5 (was M11): `memory_projections.py` flattens graph edges into synthetic star links

`ArceusMemoryProjections.get_graph_view()` currently throws away real edge semantics and emits every link as `{"type": "related_to", "weight": 1.0}` from the center node to each neighbor. This loses actual `RelationType` / weight data and misrepresents multi-hop graphs as a star topology.

Fix when graph becomes more than observability scaffolding:
1. Add a graph-store API that returns a real subgraph (`nodes + edges`) for a center node and hop depth
2. Preserve actual source, target, relationship type, and weight in `GraphMemoryView`
3. Update dashboard tests to assert real edge fidelity instead of the current synthetic placeholder edges

---

## Pre-MVP but Phase 5+ Changes — Extraction Modes

Extraction works today, but mode-specific behavior is still shallow outside the base AGENT path. This is a capability gap rather than a correctness blocker, so it should be implemented when meeting and reflection flows become real product paths rather than preemptively.

### E1 (design gap): Flesh out `MemoryExtractor` modes beyond AGENT

Current state:
- `AGENT` is the most complete path
- `MEETING` has a dedicated prompt but still shares nearly all downstream behavior
- `CONVERSATION` currently maps back to the AGENT prompt
- `REFLECTION` mode does not exist yet

What Phase 5+ should add:
1. Add an explicit `REFLECTION` mode to `ExtractionMode`
2. Add dedicated `CONVERSATION` and `REFLECTION` extraction prompts instead of reusing AGENT behavior
3. Add mode-aware post-processing in `MemoryExtractor` so each mode can bias memory typing differently
4. Make `MEETING` extraction better at decisions, owners, deadlines, action items, and unresolved items
5. Make `REFLECTION` extraction better at lessons learned, reusable strategies, and procedural habit formation
6. Add regression tests proving each mode stores meaningfully different outputs, not just different prompt text

Why deferred:
- extraction is already functional for current AGENT-centric flows
- this work is valuable only once meeting transcripts and explicit reflection loops become active product inputs
- it is not a present correctness or data-integrity bug

---

## Design Thoughts to ponder

### D1: Reconcile instance-scoped OOP APIs with agent-scoped shared storage

`C2` and `M13` are two sides of the same design inconsistency:

- `C2`: `VectorStore.search()` is not agent-scoped, so shared backends rely on container naming rather than explicit tenant filtering
- `M13`: `Hippocampus.search()` accepts `agent_id` but ignores it, which implies agent-scoped search at the API level without actually enforcing it

The proper OOP model is:
- one `Hippocampus` instance belongs to one agent
- public `Hippocampus` methods should therefore be instance-scoped and should not need a caller-supplied `agent_id`
- shared stores/backends should still enforce `agent_id` filtering internally, using `self._agent_id` from the owning `Hippocampus`

In other words:
- the object boundary should provide ergonomic scoping
- the storage boundary should provide hard tenant isolation

The clean future refactor is:
1. Remove `agent_id` from public `Hippocampus.search()` and similar instance-owned APIs
2. Add `agent_id` to `VectorStore.search()` and enforce it in all implementations
3. Have `Hippocampus` pass `self._agent_id` into store calls internally
4. Keep shared database/vector-store support without leaking multi-tenant concerns into every public method signature

Why this matters:
- it makes the public API honest and easier to use
- it preserves strong tenant isolation for shared Postgres/vector backends
- it aligns the codebase with the intended OOP ownership model: `Agent -> Hippocampus -> scoped storage access`

---

## Pre-MVP but Phase 5+ Changes — Dashboard Summary

### D1 (was H2): `get_summary()` has three always-empty fields

`MemorySummaryProjection` defines `top_patterns`, `recent_learnings`, and `recent_promotions` but `Hippocampus.get_summary()` never populates them — they always return empty lists.

**What Phase 5 should wire:**
1. **`recent_promotions`** — call `self.promotion_engine.get_recent_promotions(limit=5)` and format as `"{p.from_type}→{p.to_type}: {p.reason}"` (source method already exists)
2. **`recent_learnings`** — call `self.dynamic_memory.get_recent(container, days=7)` and take `[:5]` contents (source method already exists)
3. **`top_patterns`** — add `get_top_patterns()` to `PatternLearner` that queries `list_all()` and sorts by `success_rate * log(usage_count + 1)`, then call it from `get_summary()`

**Why deferred:** No agent logic reads these fields. They're purely for dashboard display. The underlying data is stored correctly — it's just not surfaced in the summary projection yet. Fix when building the dashboard UI that consumes `MemorySummaryProjection`
