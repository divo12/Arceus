---
name: cto-llm-integration-checklist
description: Add an LLM-powered feature without the failure modes — token caps, streaming, fallbacks, cost budgeting, prompt versioning. Replaces "just call OpenAI" prototypes.
role: cto
trigger: about to add or design a feature that calls an LLM (chat, classification, summarization, RAG, etc.); reviewing an LLM integration before ship
---

# LLM Integration Checklist

LLM features fail in modes traditional services don't: silent context truncation, exponential cost growth, schema drift, rate limits at the worst possible moment. Bake the protections in from day one.

## Pre-implementation decisions

1. **Pick the model deliberately**
   - Latency requirement: <500ms TTFT → smaller model (Haiku, gpt-5-mini). Multi-second OK → Sonnet/Opus equivalents.
   - Reasoning depth: classification or extraction → small. Multi-step reasoning or code generation → large.
   - Cost ceiling per request: write it down before the first call. If a single user can trigger >$0.10 of inference, you have an abuse vector.

2. **Decide structured vs free-text**
   - If you'll parse the output with regex or `JSON.parse`, use structured outputs (Zod/JSON Schema with `response_format`). Never trust free-text shape.
   - If the response is rendered to a human, free-text + streaming is fine.

3. **Streaming or not**
   - Stream when latency >500ms and a human will see the output. Don't stream for backend-only or short responses.
   - Streaming requires connection management — cancellation on client disconnect, partial-response handling.

4. **Token budget per request**
   - Cap input tokens explicitly. Never trust user input length.
   - Cap output tokens (`max_tokens`). Truncated output is better than runaway cost.
   - Document the per-call budget in the spec.

## Required production scaffolding

- [ ] **Retry policy** — single retry on transient errors (5xx, timeout, rate limit). Exponential backoff. Never retry 4xx.
- [ ] **Fallback** — if the call fails after retries, what does the user see? A degraded response, a cached one, a clear error? Decide before shipping.
- [ ] **Timeout** — separate from retry budget. Cap the total time the user can wait.
- [ ] **Cost telemetry** — log tokens-in, tokens-out, model, latency per call. Aggregate per-feature, per-user.
- [ ] **Rate limiting** — per-user and per-feature. The model's own limits are not your only ceiling.
- [ ] **Prompt caching** — Anthropic and Azure both support cache hints. If your system prompt is >1K tokens and reused, enable it.
- [ ] **Prompt versioning** — store prompts in code, version them, log which version produced which output. When quality regresses you'll need to bisect.
- [ ] **Output validation** — schema-validate structured outputs. Reject and retry once on schema failure. After that, surface as error.
- [ ] **PII / data leakage** — what user data flows into the prompt? Is it logged by the provider? Is that acceptable?

## RAG-specific additions

- [ ] Embedding model is fixed and versioned (changing it invalidates every stored vector).
- [ ] Top-k retrieval has a clear default (5–10) and justification.
- [ ] Retrieved chunks are deduplicated before being inserted into the prompt.
- [ ] You handle "no relevant chunks" as a first-class case, not a silent empty context.

## Observability

Every LLM call logs:
- Model + prompt version
- Tokens (input, output, cached)
- Latency p50/p95
- Cost in cents
- Error class on failure (timeout, rate limit, schema invalid, content filter)

Without these you cannot diagnose regressions. With them, the ATA / pattern learner can identify which prompt versions perform best.

## Common mistakes

- Streaming free-text and then trying to parse it after the fact.
- No `max_tokens` cap → one prompt-injected user runs up a $20 bill.
- "Temperature 0 means deterministic" — it doesn't. Test repeatedly if you depend on consistency.
- Treating all 5xx errors as retryable — content-policy rejections from some providers come back as 5xx and retrying just burns money.
- Embedding model version not pinned — silent drift, retrieval quality collapses on provider update.
- Synchronous calls inside request handlers without timeouts — one slow LLM stalls the whole route.

## Document the choice

Write into the architecture spec:
- Model + version + reason
- Token budget
- Failure modes and fallbacks
- Cost ceiling per request and per day
- Logging/telemetry plan

Attach as an artifact to the claimed task.
