---
title: System Design (2026)
audience: Engineers making cross-cutting architectural decisions
---

# 04 · System Design (2026)

Battle-tested patterns, not theory. For Arceus-shaped teams building TS/Next/Postgres products with an agent fleet.

## 1. Domain modeling first

- **Event Storming + DDD-lite.** Stickies for events ("OrderPlaced", "SprintProposed"), derive commands and aggregates, infer bounded contexts. Do this **before** schemas, definitely before UI. `[high confidence]` ([Martin Fowler — BoundedContext](https://martinfowler.com/bliki/BoundedContext.html), [DDD Europe — Event Storming](https://dddeurope.com/))
- **Ubiquitous language catches code smells.** If product says "sprint" and the table is `cycles`, every PR pays translation tax. Name tables, routes, types with the vocabulary used in standups.
- **"What's the URL shape?" as an aggregate check.** If `/api/cycles/:id/finalize` needs five query params to disambiguate meaning, the aggregate is wrong — refactor the aggregate, not the URL.
- **Data model before UI.** Write the Postgres migration + Zod schema before any Next component. UI is a projection; the model is the contract.
- **Example-driven specs.** Write 3-5 concrete example inputs + expected outputs for any new workflow. Tests fall out naturally; aggregates become obvious.

**Why it matters:** DDD without heavyweight ceremony shortens the distance between product vocabulary and production bugs — the main source of toil in AI-agent platforms where events flow between many services.

## 2. 12-factor — what still holds in 2026

- **Still canonical:** config via env + secret store, stateless processes, port binding, disposability, dev/prod parity, logs as streams. Kubernetes (ConfigMaps, HPA, Jobs) and Vercel/Lambda are the purest 12-factor runtimes today. `[high confidence]` ([12factor.net](https://12factor.net/))
- **Ephemeral FS is now assumed.** Containers + serverless guarantee disk loss on restart; anything written locally is cache. Arceus already depends on Postgres + blob — keep it that way.
- **Graceful shutdown is harder.** SIGTERM windows on Vercel/Lambda are short (seconds); long-running agent work must checkpoint to DB or queue, never memory.
- **Informal 13th factor: telemetry is not optional.** Traces/metrics/logs built in from day one.
- **Secrets rotation** is a first-class concern in 2026; every secret has a rotation plan (or a justification why not). ([ITNEXT — 12-factor 15 years later](https://itnext.io/the-12-factor-app-15-years-later-does-it-still-hold-up-in-2026-c8af494e8465))

**Why it matters:** treating every process as cattle is the precondition for queue-based agent orchestration. Arceus's CEO/sprint loop only survives restarts if state lives in Postgres.

## 3. API design — REST, tRPC, GraphQL, gRPC

- **Pick by team shape, not hype:**
  - **tRPC** for internal full-stack TS monorepos (Arceus fits).
  - **REST** for public/partner APIs and long-lived contracts.
  - **GraphQL** when many clients want different projections of shared data.
  - **gRPC** for service-to-service hot paths. `[high confidence]` ([jsgurujobs — REST vs GraphQL vs tRPC 2026](https://jsgurujobs.com/blog/rest-api-vs-graphql-vs-trpc-in-2026-and-why-your-api-layer-choice-affects-your-team-size-more-than-your-tech-stack))
- **Idempotency keys on every non-GET write.** Follow Stripe/IETF `Idempotency-Key` header (UUID v4, 24h retention, replay returns stored response). Essential when agent retries are common. `[high confidence]` ([Stripe — Idempotency](https://stripe.com/blog/idempotency), [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/))
- **Compound CAS for conflict-prone writes.** Require `If-Match` ETag or a `version` column check. Idempotency prevents double-apply; CAS prevents lost updates. Paperclip's checkout pattern (atomic token + version check) is the textbook form.
- **Cursor pagination > offset.** Offset is O(n) and drifts under writes. Use opaque cursors (`(created_at, id)` tuples, base64-encoded).
- **URL versioning for public; header versioning for internal.** Never version by breaking in place.
- **Typed request/response at the boundary.** Zod on Node; tRPC inherits this via schema. Every param/field has a type; never `any`.

**Why it matters:** agents retry aggressively; without idempotency + CAS you get silent duplication and lost-update corruption.

## 4. Scalability patterns

- **Read replicas + CQRS for read-heavy paths.** Don't reach for event sourcing until audit/rewind is a hard requirement — it's the most over-applied pattern.
- **Transactional outbox for reliable events.** Write domain change + outbox row in **one** Postgres transaction; a relay ships to the queue. Prevents the dual-write problem. `[high confidence]`
- **Sagas for multi-service workflows** with compensating actions on failure. Arceus sprint pipelines are natural sagas.
- **Circuit breakers + bulkheads.** Isolate LLM provider calls in their own thread pool / connection pool so a hung Anthropic call can't drain web worker capacity. `[high confidence]` ([Martin Fowler — CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html))
- **Queue-based load leveling + idempotent consumers.** Required for agent bursts. Consumers must tolerate double-delivery.
- **Backpressure via rate limits + `Retry-After`.** Never let a hot client loop DDoS you.

**Why it matters:** LLM APIs have multi-second tail latency + 5xx storms; without bulkheads one flaky provider takes the whole product down.

## 5. Observability + incident response

- **OpenTelemetry is the default.** One SDK, three signals (logs, metrics, traces), vendor-neutral export (Datadog/Grafana/Honeycomb). Propagate `traceparent` across **every** agent tool call. `[high confidence]` ([opentelemetry.io](https://opentelemetry.io/docs/))
- **Structured JSON logs with request/trace ID on every line.** Grep is dead; you need filterable structured queries.
- **SLIs / SLOs / error budgets.** Publish a short list of user-visible SLIs ("sprint proposal completes < 30s p95"), set SLOs, compute error budget = 1 − SLO. Use **multi-window burn-rate alerts** (Google SRE Workbook) — short window for recency + long for sustained impact. `[high confidence]` ([Google SRE Workbook — Error Budget Policy](https://sre.google/workbook/error-budget-policy/))
- **Blameless postmortems + runbooks in the repo**, not Notion. The repo is the source of truth; Notion rots.
- **Load tests with k6 before every major release.** Synthetic monitors in prod for critical user flows.
- **Log sampling for cost control.** Trace 100% of errors, sample 1-10% of successes at scale.

**Why it matters:** agent systems fail in novel ways (hallucinated tool args, infinite loops, token blowouts). Without traces you can't distinguish "model did something dumb" from "our code did something dumb."

## 6. Security

- **OWASP Top 10:2025** now has explicit SBOM + supply-chain requirements. Run `pnpm audit` + Socket.dev + Dependency-Track in CI; fail on criticals. `[high confidence]` ([OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/))
- **SSRF guards on every server-side outbound fetch.** Block RFC1918, link-local (`169.254.169.254` = cloud metadata), loopback; enforce HTTPS. Explicit in MCP security spec. ([MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices))
- **Short-lived tokens + rotation.** JWTs minutes-to-hours; refresh tokens rotated. **Never accept a token not issued *for your service*** (MCP "no token passthrough" rule).
- **CSP + CSRF + rate limits on every endpoint.** Scope auth to smallest privilege; OWASP LLM A07 is scope overreach.
- **Secrets: env + Vercel/Doppler/Infisical + pre-commit scanners** (gitleaks, trufflehog). Never commit `.env`.
- **OWASP LLM Top 10:2025** — prompt injection, insecure output, training data poisoning, supply chain, excessive agency. Agent platforms are in scope for every one. ([OWASP LLM Top 10 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/))

**Why it matters:** Arceus + MCP = attacker's dream surface (tool-metadata injection, confused-deputy OAuth, SSRF through agent URLs). Every defense above prevents a documented real-world incident.

## 7. Team process

- **Trunk-based development with feature flags** is the only regime that survives an AI-heavy team shipping 10× more diffs. Long-lived branches die in merge hell. `[high confidence]` ([LaunchDarkly — Trunk-Based Development](https://academy.launchdarkly.com/tech-talk-trunk-based-development))
- **Short-lived branches (< 24h) + small PRs (< 400 LOC).** AI generates 2000-line PRs; humans can't review them.
- **Conventional Commits.** Essential when agents + humans both commit; keeps `git log` machine-parseable for changelog + release tooling.
- **Feature flags:** GrowthBook (OSS, self-host) or LaunchDarkly (SaaS) with Vercel Edge Config sync for zero-latency eval in Next middleware. Kill switches + progressive rollouts on every new agent behavior.
- **RFC/ADR culture before any architectural change.** Single-reviewer for routine; pair-review for security or data-model changes.
- **Release trains or continuous deploy.** Weekly train is the minimum cadence; faster if your observability supports it.

**Why it matters:** the bottleneck shifts from writing code to *reviewing and de-risking* code. Flags let you decouple deploy from release.

---

## Applied to Arceus

| Arceus area | Rule from this file |
|---|---|
| Task checkout, sprint approve/reject, heartbeat claim | §3 — Idempotency-Key + compound CAS like Paperclip `issues.ts:1779` |
| LLM provider calls (Azure OpenAI) | §4 — circuit breaker + bulkhead connection pool; `Retry-After` respect |
| Agent-to-agent comms (today direct) | §4 — transactional outbox → queue for reliability; saga for sprint pipeline |
| `apps/api` observability | §5 — `@vercel/otel`; `traceparent` across orchestrator → OpenCode → tool calls; SLI: sprint completion rate |
| MCP servers we expose | §6 — no token passthrough; scoped read-only in prod; SSRF egress filter on outbound fetches |
| Git workflow | §7 — trunk + feature flags; PR size cap ~400 LOC; ADRs in `plans/adr/` |

## Key sources

- [Martin Fowler — BoundedContext / CircuitBreaker](https://martinfowler.com/bliki/)
- [12factor.net](https://12factor.net/) · [ITNEXT — 12-factor 15 years later](https://itnext.io/the-12-factor-app-15-years-later-does-it-still-hold-up-in-2026-c8af494e8465)
- [Stripe — Idempotency](https://stripe.com/blog/idempotency) · [IETF draft — Idempotency-Key](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- [Google SRE Workbook — Error Budget Policy](https://sre.google/workbook/error-budget-policy/)
- [OpenTelemetry docs](https://opentelemetry.io/docs/)
- [OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/) · [OWASP LLM Top 10 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [LaunchDarkly — Trunk-Based Development](https://academy.launchdarkly.com/tech-talk-trunk-based-development) · [GrowthBook × Vercel](https://blog.growthbook.io/vercel/)
