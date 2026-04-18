---
title: AI-Tooling Leverage (2026) — The Crown File
audience: Teams using Claude Code + Cursor + Codex + MCP heavily
---

# 06 · AI-Tooling Leverage (2026) — The Crown File

How to use Claude Code, Cursor, Codex, Aider, agentic harnesses, MCP, and eval-driven development in the 2026 best-practice way. With an Arceus-specific synthesis at the end.

## 1. Claude Code

- **Layer your context:** **CLAUDE.md** for durable policy (always loaded, ~80% compliance), **Skills** for on-demand workflows (loaded when relevant), **Hooks for deterministic enforcement (100%)**. If it *must* happen every time — lint, type-check, secret-scan — make it a **PostToolUse hook**, not a prompt rule. `[high confidence]` ([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))
- **Subagents for exploration-heavy work.** Keep the main context clean; subagents return summaries, not transcripts. Use for "find all usages", security reviews, test discovery. ([Claude Code — Subagents](https://code.claude.com/docs/en/sub-agents))
- **Skills follow progressive disclosure.** `skills/{name}/SKILL.md` + `references/`, `scripts/`, `examples/`. Include a "Gotchas" section for what pushes Claude off its defaults.
- **Slash commands encode repeatable workflows** (`/verify`, `/review`, `/deploy-preview`). **Plan mode** for non-trivial edits. **Extended thinking** for architectural or debugging work.
- **Compact hierarchy:** subagent → `/compact` (summarize + keep decisions/bugs/recent files) → `/clear` (clean break) → restart. Match the lever to the problem.
- **`CLAUDE.local.md`** for personal overrides not checked in. Useful for engineers with strong style preferences.

**Why it matters:** agent output quality is constrained by context quality. Mastering what goes where is the highest-ROI skill.

## 2. Cursor

- **`.cursor/rules/*.mdc` replaces the legacy `.cursorrules`** (deprecated). One rule per file, scoped by globs. Keep each rule narrow. `[high confidence]` ([Cursor — Rules](https://cursor.com/docs/rules))
- **Modes:**
  - **Agent** (multi-file autonomous) — leaf tasks with tests.
  - **Composer** (multi-file interactive) — steer each step.
  - **Chat** (ask/explain) — questions, not changes.
- **Background Agents** clone your repo on a branch, run builds + tests, open PRs. Good for shaped tickets.
- **MCP is first-class** — expose Postgres, Sentry, Arceus internals as MCP servers once, use from every client.
- **Model routing** — Cursor Auto picks per task; override to Opus for architecture, Sonnet for general coding, Haiku for bulk edits.
- **Bugbot** in 2026 learns from PR feedback and auto-promotes rules. Review what it adds weekly.

**Why it matters:** Cursor is where day-to-day editing happens for most teams; the rules file is where your conventions bite.

## 3. Codex / OpenAI Codex CLI

- **GPT-5.3-Codex + GPT-5.4** are the recommended Codex models (Nov 2025 → Q1 2026). **Codex-Spark** targets > 1000 tok/s for real-time coding. `[speculation on exact model lineup in late 2026]` ([OpenAI Codex CLI](https://developers.openai.com/codex/cli))
- **`codex exec`** scripts repeatable workflows; subagents parallelize.
- **Strong CI/PR-review posture** via GitHub Action.
- Good default for teams already on OpenAI infra; **weaker skills/MCP ecosystem** than Claude Code as of 2026.

## 4. Aider

- **Architect/Editor split.** Strong reasoning model proposes the change; cheaper format-reliable model emits the diff. SOTA on Aider's own bench; lower cost than single-model. `[high confidence]` ([Aider — Architect blog](https://aider.chat/2024/09/26/architect.html))
- **Repo map** via tree-sitter — sends compressed class/func signatures each turn; survives large repos. ([Aider — Repo map](https://aider.chat/docs/repomap.html))
- **Git-native** — one commit per turn with a message; easy to revert.
- Best for: terminal-first engineers, Python/Go projects, test-first flows.

## 5. Agentic harnesses (Devin, OpenHands, Cline, Roo Code)

- **Devin** — most autonomous; sandboxed cloud VM; best on well-scoped tickets. Still brittle on fuzzy requirements. `[high confidence for scoped; speculation for open-ended]`
- **OpenHands** (née OpenDevin) — OSS self-hosted Devin analog; viable for regulated envs that can't send code to SaaS agents.
- **Cline / Roo Code** — VS Code extensions with Plan/Act separation, zero markup on model cost, strong MCP support. Best hybrid of "editor copilot" and "autonomous agent."
- **SWE-bench Verified 2026** — top ~80% (Claude Opus 4.5/4.6, GPT-5.2). Benchmarks overstate real-world reliability on unfamiliar codebases. `[speculation on exact numbers]`
- **Still brittle:** multi-repo changes, infra work, UI polish, anything requiring product taste.

**Why it matters:** harnesses are good for shaped, well-scoped tickets; they are not a replacement for an engineer making judgment calls on ambiguous work.

## 6. MCP (Model Context Protocol)

- **Design** — JSON-RPC over stdio or HTTP+SSE; servers expose **tools**, **resources**, **prompts**. Clients (Claude Code, Cursor, Codex) speak it uniformly. Donated to the Agentic AI Foundation (Linux Foundation) in Dec 2025. `[high confidence]` ([modelcontextprotocol.io](https://modelcontextprotocol.io))
- **Expose your infra once, reuse everywhere.** Wrap Postgres (read-only), feature flags, Sentry, your internal sprint API as MCP servers. Every agent inherits them.
- **Security is the sharp edge** ([MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)):
  - **Tool poisoning** — malicious tool descriptions inject instructions; validate server-provided metadata client-side.
  - **Prompt injection via tool results** (Supabase/Cursor 2025 incident: SQL from a support ticket exfiltrated service-role keys). **Treat tool results as untrusted user content.**
  - **Confused deputy** in OAuth proxies — require per-client consent, exact `redirect_uri` match, `state` binding.
  - **No token passthrough** — MCP servers MUST NOT accept tokens not issued to them.
  - **SSRF** — block RFC1918, link-local; enforce HTTPS; egress proxy (e.g. Stripe Smokescreen).
  - **Least-privilege scopes**, incremental elevation, not omnibus `admin:*`.
- **Naming + versioning.** MCP tools accumulate; namespace by service (`arceus.db.query` not `query`) and version the schema.

**Why it matters:** MCP is the universal bus between your infra and every agent client. If you get security right once, the whole toolchain benefits.

## 7. Eval-driven development

- **Evals are the new tests for LLM-dependent code paths.** Unit tests cover pure functions; evals cover prompts, agents, and RAG chains. `[high confidence]` ([Braintrust — best eval tools 2025](https://www.braintrust.dev/articles/best-prompt-evaluation-tools-2025))
- **Tool choice:**
  - **Promptfoo** — declarative YAML, CLI, CI-friendly, red-teaming for injection/PII/jailbreaks. Best default for in-repo evals.
  - **Braintrust** — SaaS with deep GitHub Actions integration (PR comments with experiment diffs). Managed loop.
  - **Langfuse** — OSS, MIT, strong observability + prompt mgmt. Best for self-host.
  - **Anthropic Evaluation API / OpenAI Evals** — model-native rubric evals.
- **Rule:** every prompt change ships with an eval diff; every new agent tool ships with a red-team eval.
- **Golden examples + rubric scoring.** A regression catcher + a quality grader, both in CI.

**Why it matters:** without evals, prompt changes are dark-matter diffs — the model behaves differently and nobody knows.

## 8. Agent safety + human review

- **Non-negotiables (human approval required):**
  - Production DB writes
  - Secret rotation
  - Customer comms
  - Deploys
- **Staging/review envs are AI-accessible; production is not.** Prod MCP = read-only + scoped. Destructive ops need human-in-the-loop.
- **Diff-review automation.** Graphite Agent / Copilot Review / `claude-code review` triage; humans own merge. Shopify: +33% PRs/dev with Graphite.
- **Cost guardrails.** Per-session token budgets, per-day spend alerts, kill switches. Anthropic + OpenAI expose usage APIs — poll them.
- **Secret scanning pre-commit** (gitleaks) + server-side (GitHub secret scanning + Socket.dev for deps).
- **Model provenance on every commit.** `Co-Authored-By: Claude` or `Co-Authored-By: Codex` — audit which commits came from which tool.

**Why it matters:** one unauthorized prod write corrupts trust. Gates + guardrails mean AI speed doesn't come with AI surprises.

## 9. Context engineering

- **Anthropic's mental model:** *compaction* compresses the window; *clearing* drops stale fetched data; *memory* moves info out of the window across sessions. Use the right lever. ([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))
- **Where things live:**
  - **System prompt** — role, invariants, output contract
  - **CLAUDE.md / AGENTS.md** — durable project policy
  - **Cursor rules (`.mdc`)** — editor-side ergonomic rules
  - **Skills** — procedures loaded on demand
  - **RAG / tool results** — ephemeral facts, not policy
  - **Structured notes (files)** — long-lived task state
- **Progressive disclosure.** Load file paths first, expand only what you need. Don't paste the whole repo.
- **Session hygiene.** `/compact` near limits; `/clear` when switching tasks; restart when the agent loops or drifts.
- **"Smallest set of high-signal tokens"** — Anthropic's single best heuristic.

**Why it matters:** context is the budget. The difference between a good and bad agent session is which tokens made the cut.

## 10. How AI changes code review

- **AI-first PR review runs before humans.** Graphite Agent, Copilot Review, `claude-code review`, Cursor Bugbot. Humans focus on architecture, security, product intent.
- **Write code AI reviews well** — small PRs, descriptive names, colocated tests, ADRs for non-obvious decisions. "AI-reviewable" ≈ "human-reviewable, more so."
- **AI-generated smells humans catch:**
  - Plausible but wrong APIs (hallucinated imports)
  - Silent error-swallowing
  - Tests that assert on the code they just wrote
  - "Generic" abstractions with one caller
  - Copy-paste of a pattern that was wrong once
- **Humans still own:** merge, deploy, secrets, customer-facing copy, licenses, final trade-off calls.

---

## The synthesis — the 2026 best-practice stack for Arceus

For a small team on TS/Next/Postgres with heavy AI tooling:

**Base layer (deterministic, boring, correct):**
- Postgres 17 with `timestamptz`, identity / UUID v7 PKs, RLS with `FORCE`, partial indexes for soft-deletes.
- TypeScript strict suite + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; Zod/Valibot at every boundary; `Result` for fallible paths; `assertNever` everywhere; no `any`.
- Next 15 App Router with `defineAction` wrapper for every Server Action, typed cache tags, explicit route segment config, `lib/data/*.ts` for all data fetches.
- Drizzle ORM with shared column helpers; `pgroll` for zero-downtime migrations.

**Reliability layer:**
- Idempotency-Key + compound CAS (like Paperclip's `issues.ts:1779`) on every mutation.
- Transactional outbox for cross-service events; idempotent consumers with `SELECT FOR UPDATE SKIP LOCKED`.
- Circuit breakers around every LLM provider; bulkheads for hot paths.
- OpenTelemetry with `traceparent` propagation; SLIs on user outcomes not infra; multi-window burn-rate alerts.
- OWASP Top 10:2025 + LLM Top 10 covered; SSRF egress block on all server fetches.

**Team layer:**
- Trunk + feature flags (GrowthBook + Vercel Edge Config). PR cap ~400 LOC. Progressive rollout + kill switches.
- ADRs in `plans/adr/NNNN-*.md`; C4 overview; Diátaxis-split docs; reference auto-generated.
- Shape Up appetite + scope hammering. Measurement before launch.

**AI layer:**
- Claude Code: CLAUDE.md (policy) + Skills (procedures) + Hooks (laws). PostToolUse hooks for `tsc --noEmit`, `biome check --write`, `gitleaks`, `knip`. Subagents for exploration. `claude-code review` in PR.
- Cursor: `.cursor/rules/*.mdc` per concern, MCP-exposed infra, Agent mode for shaped tickets.
- MCP servers for every internal system (Postgres RO in prod, full-write in staging, Sentry, feature flags, Arceus sprint API). Tool metadata validated client-side; results treated as untrusted.
- Evals: Promptfoo YAML in-repo + Braintrust in CI. Every prompt change ships with eval diff. Red-team eval per new tool.
- AI-first review (Graphite Agent + `claude-code review`) before human; humans own merge, deploy, secrets.

**Compounding pairs:**
- Trunk + flags + AI-generated small PRs → continuous deployment with low blast radius.
- MCP + evals + OTel → same tool calls can be tested, traced, guarded.
- Shape Up + AI velocity → fixed appetite holds scope while AI multiplies throughput inside it.

**Tensions to resolve:**
- AI prefers long diffs; best practice demands small ones → CI size caps + require tests.
- AI loves premature abstraction → enforce one-caller rule before abstracting.
- Agents over-consume context → compact aggressively; progressive disclosure default.
- Agents want privileged creds → staging-only + read-only prod + human-in-the-loop for destructive ops.

---

## Top 12 non-obvious rules for an AI-heavy team in 2026

1. **CLAUDE.md is policy, Skills are procedures, Hooks are laws.** If it must happen every time, it's a hook, not a prompt rule.
2. **Idempotency-Key on every POST, `If-Match` ETag on every mutation.** Agents retry more than humans.
3. **Expose infra via MCP once; read-only in prod; scoped least-privilege tokens.** Never pass tokens through.
4. **Evals ship with every prompt change.** Promptfoo YAML + CI gate. Prompt diffs are dark matter without evals.
5. **PR size cap ≈ 400 lines.** AI happily writes 2000; review degrades.
6. **Subagents → `/compact` → `/clear` → restart.** Match the context lever to the problem.
7. **Feature-flag every new agent behavior with a kill switch.** Agents regress in ways unit tests miss.
8. **Tool descriptions are attack surface.** Validate MCP metadata client-side; treat tool results as untrusted.
9. **Staging is AI-accessible; production is not** except via read-only MCP and human-approved deploys.
10. **SSRF-block RFC1918 + `169.254.0.0/16`** on every server-side fetch. Cloud-metadata exfil is the default agent payload.
11. **Shape Up your AI scope.** Fixed appetite, variable scope, hammer aggressively.
12. **Docs are agent context.** Every ADR, README, Diátaxis page is input for the next Claude session.

---

## Applied to Arceus — concrete changes

| Change | Source § | Effort |
|---|---|---|
| PostToolUse hook: `biome check --write` + `tsc --noEmit` + `gitleaks protect --staged` | §1 | 2 hours |
| CLAUDE.md for Arceus root: policy + project structure + coding rules | §1, §9 | 1 day (mostly thinking) |
| `.cursor/rules/*.mdc` per-subsystem (orchestrator, skills, runtime, web) | §2 | 1 day |
| MCP server for Arceus: `arceus_emit_artifact`, `arceus_post_to_ceo`, `arceus_submit_review_verdict`, `arceus_skill_used` | §6 | 3-5 days |
| MCP server: Postgres read-only via `pg_read_only_role` | §6, §8 | 1 day |
| Promptfoo suite for orchestrator prompts (CEO, Engineer, Skills Lead) | §7 | 2-3 days |
| Red-team eval: prompt-injection tests on every tool we expose | §6, §7 | 1 day |
| `claude-code review` as PR check + Graphite Agent in CI | §8, §10 | 1 day |
| ADR scaffold + first 5 ADRs covering adapter layer, checkout CAS, skill lifecycle, MCP contract, spec-14 evolution | §5 | 1 week |
| Feature flags + kill switches on pattern-learner + skill-mutator + new sprint review | §3 | 2 days |
| SLI/SLO published on sprint completion rate + p95 time-to-done + error budget alerts | §5 (Part A §5) | 3 days |

Sequencing: hooks + CLAUDE.md (week 1) → Cursor rules + Arceus MCP server (week 2) → evals + `claude-code review` (week 3) → flags + SLIs (week 4) → ADRs written throughout.

## Key sources

- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Claude Code — Subagents](https://code.claude.com/docs/en/sub-agents) · [Session mgmt + 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [Cursor — Rules](https://cursor.com/docs/rules) · [Cursor Product/Agent](https://cursor.com/product)
- [Model Context Protocol — Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [Simon Willison — MCP prompt injection (2025)](https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/)
- [Practical DevSecOps — MCP Vulnerabilities 2026](https://www.practical-devsecops.com/mcp-security-vulnerabilities/)
- [OpenAI Codex CLI](https://developers.openai.com/codex/cli) · [Codex models](https://developers.openai.com/codex/models)
- [Aider — Chat modes](https://aider.chat/docs/usage/modes.html) · [Architect blog](https://aider.chat/2024/09/26/architect.html)
- [Braintrust — best prompt eval tools 2025](https://www.braintrust.dev/articles/best-prompt-evaluation-tools-2025) · [CI/CD evals 2025](https://www.braintrust.dev/articles/best-ai-evals-tools-cicd-2025)
- [Graphite — AI code review best practices](https://graphite.com/guides/ai-code-review-implementation-best-practices) · [Reviewing AI-generated code](https://graphite.com/guides/ai-review-ai-generated-code-guide)
- [morphllm — Best AI Coding Agents 2026](https://www.morphllm.com/best-ai-coding-agents-2026)
