# Spec 25 — Agent Auth & Request Integrity

**Status:** Plan · **Owner:** Platform · **Last Updated:** 2026-04-22
**Depends on:** Spec 12 (Heartbeat), Spec 13 (Governance Gateway)
**Unlocks:** Trustworthy agent identity · retry-safe state mutations · governance enforcement that can't be bypassed via header spoofing
**Scope:** Two concerns in one spec, because they share the middleware stack and both ride the same request:

1. **Agent Auth** — "how does the server know *which* agent is calling?" The bearer-token check answers "is this request from the trusted MCP subprocess?", which is not the same question.
2. **Idempotency** — "if the agent retries (or the network retries), how do we avoid double-writing state?"

> **Replaces** the earlier spec 25 draft on "Service Subagents" which was merged into spec 24.

---

## 0. TL;DR

The current Arceus API trusts whatever the caller claims about itself via HTTP headers (`x-agent-role`, `x-beat-id`, `x-company-id`). The bearer token only proves "the MCP server talks to me"; it doesn't prove "the CEO agent is calling" vs "the developer agent pretending to be CEO." The governance gateway (spec 13) is only as strong as the identity signal feeding it, so header-trust is the weakest link.

This spec lands three things:

1. **Authoritative identity via session-context.** Server-minted `sessionId` is the *only* trusted source for `{role, beatId, companyId, trustBand, allowedTools}`. Headers become advisory hints; if they disagree with session-context they're rejected.
2. **Idempotency keys that actually dedup.** Fix the regex (rejects the content-hash key scheme today), make `packages/arceus-mcp/src/tools/*` use stable `deriveIdempotencyKey` instead of per-request `randomUUID()`, and tighten the key-derivation contract so retries collapse correctly.
3. **Transport-token hardening.** Remove the `"arceus-dev-token"` literal default; fail-loud at boot in production; gate the dev-convenience default behind `NODE_ENV === "development"`.

Four problems the recent commits introduced (detailed in §3) all land at the same middleware stack. Fixing them in one pass is cheaper than three separate PRs.

---

## 1. Concepts

### 1.1 What "Agent Auth" means in Arceus

**Not** web-style user authentication — there are no human users hitting `/api/internal/v1/*`. Agent Auth in this system answers:

> *When a tool call arrives at the Arceus API, can the server prove which beat, which role, and which company it belongs to, without trusting what the caller says about itself?*

This matters because everything downstream — governance filtering (spec 13), trust-score evolution, memory handoffs, audit ledger — keys on agent identity. A wrong identity signal silently corrupts all of it.

### 1.2 Transport Auth vs Identity Auth (they are different)

| Layer | Question | Artifact | Forgeable by a compromised agent? |
|---|---|---|---|
| **Transport Auth** | "Is this caller allowed to hit the internal API at all?" | `Authorization: Bearer <ARCEUS_TOKEN>` | Anyone with the shared secret |
| **Identity Auth** | "Which specific agent session is making this call?" | Server-minted `sessionId` + session-context map | No — session IDs are opaque and never leave the server's trust boundary |

The bearer token protects the perimeter. The session-context map protects *which* agent identity applies to each request *inside* the perimeter.

Current code conflates these: once a caller passes the bearer check, the server accepts whatever `x-role` / `x-beat-id` / `x-company-id` headers they send. That's the hole.

### 1.3 Idempotency (why it matters here)

Arceus mutations are non-trivially expensive:

- `task_complete` triggers verdict scoring, skill-success updates, memory writes
- `artifact_create` writes to the artifact table + emits SSE events to the frontend
- `sprint_create` provisions N tasks + activates execution

If an agent retries any of these (network blip, SDK retry, tool-call double-emit) and the server processes both, state diverges. **Idempotency keys** let the server detect "we've already processed this exact request" and return the cached first response. The key has to be:

- **Stable** under retry — same logical request produces the same key
- **Scoped** to the beat — so two different agents calling the same op with the same body don't collide
- **Unforgeable semantically** — an agent can't craft a key that impersonates a different agent's cached entry

Today's server-side auto-mint (`?? randomUUID()`) produces fresh keys per retry, so dedup never fires. That's a broken-by-design default, not a bug.

---

## 2. Current state

### 2.1 The middleware stack (as of HEAD `4ee1677`)

```
┌─────────────────────────────────────────────────────────────────┐
│  Incoming HTTP request to /api/internal/v1/*                    │
│       │                                                         │
│       ▼                                                         │
│  ┌──────────────┐                                               │
│  │  mcpAuth     │  checks Authorization: Bearer <token>         │
│  │ middleware.ts│  falls back to "arceus-dev-token" if env unset│
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────┐                                           │
│  │ mcpRequestContext│  reads x-beat-id / x-company-id / x-role  │
│  │   middleware.ts  │  falls back to findSoleActiveSession…     │
│  └──────┬───────────┘  auto-mints idempotency-key if missing    │
│         │                                                       │
│         ▼                                                       │
│  ┌────────────────────┐                                         │
│  │ mcpIdempotencyCheck│  lookupIdempotency(companyId, beatId,   │
│  │   middleware.ts    │                    key, body)           │
│  └──────┬─────────────┘                                         │
│         │                                                       │
│         ▼                                                       │
│  Route handler → state mutation → response                      │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────┐                                           │
│  │ cacheAndSend /   │  rememberIdempotency(..., response)       │
│  │ cacheSuccessful… │                                           │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 What's already there and works

- Per-beat session-context map at `apps/api/src/orchestration/session-context.ts` (registered by `runBeat`, unregistered on beat end).
- Idempotency cache at `apps/api/src/routes/internal-mcp/idempotency.ts` with TTL enforced on lookup.
- Response caching via `cacheAndSend` / `cacheSuccessfulResponse` helpers.
- `ArceusHttpClient` in `packages/arceus-mcp/src/http-client.ts` forwards an optional `idempotencyKey` header.
- Client-side content-hash derivation at `.opencode/tool/_lib/envelope.ts` — `deriveIdempotencyKey(beatId, op, body)`.

### 2.3 What's broken (the four problems)

| # | Problem | Symptom | File |
|---|---|---|---|
| **P1** | `UUID_RE = /^[0-9a-fA-F-]{8,}$/` rejects the content-hash key format (`beat_abc:task_append_command:task_42:9f3e5a7c8d1b2456` contains `:` and `_`) | `task_append_command` + `task_append_plan_step` fail with HTTP 422 `"Idempotency-Key must be a UUID or opaque token"` on every call | [middleware.ts:23](apps/api/src/routes/internal-mcp/middleware.ts:23) |
| **P2** | Server-side auto-mint `?? randomUUID()` means clients don't have to supply a stable key | Idempotency cache never hits from any caller that doesn't explicitly pass a key | [middleware.ts:89](apps/api/src/routes/internal-mcp/middleware.ts:89) |
| **P3** | All 25+ MCP tool wrappers use `idempotencyKey: randomUUID()` — fresh per request | Retries from MCP tools can double-process; the entire MCP mutation surface is non-idempotent in practice | [packages/arceus-mcp/src/tools/*.ts](packages/arceus-mcp/src/tools) |
| **P4** | Bearer token defaults to the literal string `"arceus-dev-token"` when env unset | In prod where env var is forgotten, the server silently accepts the public-repo string as valid auth | [middleware.ts:43](apps/api/src/routes/internal-mcp/middleware.ts:43), [context.ts:35](packages/arceus-mcp/src/context.ts:35) |
| **P5** *(new)* | Headers (`x-role`, `x-beat-id`, `x-company-id`) override session-context when both are present | Agent can claim any role by setting headers that contradict the session's registered role | [middleware.ts:58-74](apps/api/src/routes/internal-mcp/middleware.ts:58) |

P5 is the deeper Agent-Auth concern. P1–P4 are mechanical fixes. This spec addresses all five.

---

## 3. Target design

### 3.1 Four-layer trust model

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 0: Process isolation                                  │
│   MCP server = child of OpenCode = child of Arceus API      │
│   (OS-level trust boundary — not controlled in code)        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Transport auth  (§4.1)                             │
│   Authorization: Bearer <ARCEUS_TOKEN>                      │
│   Fail-loud when env unset in production.                   │
│   "Am I talking to the legitimate MCP subprocess?"          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Identity auth   (§4.2)                             │
│   sessionId (server-minted, opaque) → BeatContext           │
│   "Which agent does this sessionId belong to, right now?"   │
│   Headers are ADVISORY; they must agree or we reject.       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Authorization   (spec 13, unaffected)              │
│   BeatContext.allowedTools ∋ requested-tool                 │
│   Plus trust-band policy, blast-radius checks, etc.         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: Request integrity  (§4.3)                          │
│   idempotency-key + companyId + beatId → cached response    │
│   Client-supplied stable key, derived from                  │
│   (beatId, op, body-hash). Rejected if malformed.           │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Agent Auth: session-context as authoritative source

**Principle.** The server knows who's calling *only* because it minted the `sessionId` when it created the beat, registered the `{sessionId → BeatContext}` binding in-process, and refuses to serve any state-mutating request that can't resolve to a current binding.

**Canonical resolution order for middleware:**

```ts
// Pseudocode for the target mcpRequestContext middleware
function resolveIdentity(req): BeatContext | AuthError {
  // 1. Extract the sessionId from the request.
  //    Preferred: MCP _meta.sessionId injected by the plugin.
  //    Fallback (temporary): x-session-id header.
  const sessionId = req.meta?.sessionId ?? getHeader(req, "x-session-id");

  if (!sessionId) {
    // 2. No session hint. Use the single-in-flight-beat invariant
    //    (v1 serial beats). If more than one beat is registered,
    //    the caller MUST supply sessionId — no ambiguous resolution.
    const sole = findSoleActiveSessionContext();
    if (!sole) return AuthError("session_required");
    return sole;
  }

  const ctx = getSessionContext(sessionId);
  if (!ctx) return AuthError("session_not_found");

  // 3. Headers are checked as advisory hints. If present, they MUST
  //    match the resolved context. Mismatch = reject (possible spoof).
  const claimedRole    = getHeader(req, "x-agent-role") ?? getHeader(req, "x-role");
  const claimedBeat    = getHeader(req, "x-beat-id");
  const claimedCompany = getHeader(req, "x-company-id");

  if (claimedRole    && claimedRole    !== ctx.role)      return AuthError("identity_mismatch");
  if (claimedBeat    && claimedBeat    !== ctx.beatId)    return AuthError("identity_mismatch");
  if (claimedCompany && claimedCompany !== ctx.companyId) return AuthError("identity_mismatch");

  return ctx;
}
```

**Three important properties:**

1. **Session-context wins on conflict.** An agent that tries `x-role: ceo` when its session is registered as `developer` gets 403 `identity_mismatch`.
2. **sessionId never flows outside the server.** Agents can see their own sessionId only insofar as the MCP plugin passes it to tool calls. They can't mint their own; they can't hand one to another agent; and evicted sessions cease to be valid immediately.
3. **Headers are a migration shim, not a primitive.** Today some clients still rely on sending headers. Target end-state: only `x-session-id` (or MCP `_meta.sessionId`) is read; the other three headers are ignored. Phase 3 of this spec deletes the header path.

### 3.3 Where sessionId comes from (client side)

Three propagation paths, listed by preference:

| Path | Source | Status | Preferred? |
|---|---|---|---|
| **A — MCP `_meta.sessionId`** | OpenCode plugin injects it via `tool.execute.before` hook into the MCP call's `_meta`. MCP server reads it from `extra._meta` in the tool handler and passes to `ArceusHttpClient.request({ sessionId })`. | Plugin hook exists; wiring not complete | ✅ target |
| **B — `x-session-id` header** | `ArceusHttpClient` sets header when `init.sessionId` present. MCP tools pass it through. | Partially wired (http-client accepts `sessionId`, tools don't populate it) | Interim |
| **C — `findSoleActiveSessionContext` fallback** | Server resolves the only active beat in memory. | Live today (cofounder added it) | Migration-only |

Path C only works because v1 beats serialize. It's a correctness liability once parallel beats ship. Spec 25 deprecates C by end of Phase 3.

### 3.4 Idempotency key scheme

**Derivation** (client-side, in `.opencode/tool/_lib/envelope.ts` and `packages/arceus-mcp/src/tools/*`):

```ts
export function deriveIdempotencyKey(
  beatId: string,
  op: string,
  body: unknown,
): string {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex")
    .slice(0, 16);
  return `${beatId}:${op}:${bodyHash}`;
}
```

**Properties:**

- **Stable** — same `(beatId, op, body)` always produces the same key. A retried request collapses to the cached response.
- **Beat-scoped** — two different beats calling the same op with the same body get different keys (beatId is in the prefix).
- **Collision-resistant in practice** — SHA-256 of JSON-canonicalized body; 16 hex chars of prefix = 2⁶⁴ space, vastly larger than the ~10² distinct ops a beat performs.
- **Informative in logs** — the key tells you the beat, op, and body hash at a glance. `randomUUID()` tells you nothing.

**Validation regex (server-side):**

```ts
// Old — rejects valid derived keys
const UUID_RE = /^[0-9a-fA-F-]{8,}$/;

// Target — accepts UUIDs AND derived keys AND arbitrary opaque tokens
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_.\-]{8,128}$/;
```

- Matches UUID v4: 36 chars, hex + dashes — ✅
- Matches derived key: `beat_a1b2c3:task_append_command:task_42:9f3e5a7c8d1b2456` — ✅
- Rejects garbage (spaces, quotes, HTML, SQL fragments) — ✅
- Bounded length 8–128 — prevents DOS via enormous keys

**Cache key on server:** `(companyId, beatId, idempotencyKey)` tuple — so idempotency is globally unique per logical op + beat + tenant.

**Retry semantics:**
- Same key, same body → cached response
- Same key, different body → `409 body_mismatch` (prevents accidentally replaying with mutated payload)
- No key supplied on non-GET → **reject** `400 client_supplies_key` (no more auto-mint; clients MUST supply stable keys)

### 3.5 Transport token hardening

**Current** (broken):
```ts
const expected = process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN ?? "arceus-dev-token";
```

**Target:**
```ts
const expected = resolveBearerToken();

function resolveBearerToken(): string {
  const token = process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN;
  if (token && token.length >= 16) return token;
  if (process.env.NODE_ENV !== "production") {
    logger.warn("Using development default ARCEUS_TOKEN. Set ARCEUS_TOKEN before deploying.");
    return "arceus-dev-token";
  }
  throw new Error(
    "ARCEUS_TOKEN (or ARCEUS_INTERNAL_TOKEN) must be set in production. " +
    "Refusing to start with a known-public default."
  );
}
```

- Prod: throws at boot if no token. Fail loud, fail obvious.
- Dev: warns and falls back (keeps local iteration cheap).
- Client side (`packages/arceus-mcp/src/context.ts`) mirrors the same logic.
- Bonus: requires tokens to be ≥16 chars — blocks accidental empty-string bypasses.

---

## 4. Implementation

### 4.1 Where each piece lives

```
apps/api/src/routes/internal-mcp/
├── middleware.ts            ← mcpAuth, mcpRequestContext, mcpIdempotencyCheck
├── idempotency.ts           ← lookupIdempotency, rememberIdempotency (unchanged body, API stable)
└── envelope.ts              ← success/failure response builders (unchanged)

apps/api/src/orchestration/
├── session-context.ts       ← get/register/unregister + findSole/findByRole (unchanged body,
│                              but becomes PRIMARY identity source — no header override)
└── run-beat.ts              ← registers & unregisters on beat lifecycle (unchanged)

apps/api/src/auth/            ← NEW module
├── bearer.ts                ← resolveBearerToken, verifyBearer
└── identity.ts              ← resolveAgentIdentity (the middleware's Layer-2 work, extracted)

packages/arceus-mcp/src/
├── context.ts               ← optionalEnv for BEAT_ID/COMPANY_ID/ROLE (unchanged)
│                              requireBearerToken for ARCEUS_TOKEN (tightened — no default in prod)
├── http-client.ts           ← passes sessionId; no change needed after Phase 2
└── tools/*.ts               ← replace randomUUID() with deriveIdempotencyKey (mechanical)

.opencode/tool/_lib/
└── envelope.ts              ← deriveIdempotencyKey (already exists, no change)

.opencode/plugin/arceus.ts    ← inject _meta.sessionId into outbound MCP calls (NEW wiring)
```

### 4.2 Fixes, in order

Each fix is a small, independently reviewable change. Order matters because later phases depend on earlier ones.

---

#### **Phase 0 — Regex + cleanup (1 PR, ~30 min)**

- [ ] `middleware.ts` — replace `UUID_RE` with `IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_.\-]{8,128}$/`. Rename the constant.
- [ ] Remove the `?? randomUUID()` auto-mint on line 89. Non-GET without a key → `400 client_supplies_key` (the previous behavior before commit `80de168`).
- [ ] Tighten the mismatch error message: `"Idempotency-Key must be 8-128 chars matching [A-Za-z0-9:_.\\-]"`.

**Why.** Restores client-supplied-stable-key invariant. Unbreaks `.opencode/tool/task_append_command.ts` and `task_append_plan_step.ts` (which currently return 422 on every call — see P1 in §2.3). Immediately fixes the hot-loop path.

**Test.** Snapshot the regex against 10 inputs (5 valid, 5 invalid). Integration test: fire `task_append_command` with a derived key, expect 200 not 422.

---

#### **Phase 1 — Stable keys on the MCP mutation surface (1 PR, ~2h)**

- [ ] Export `deriveIdempotencyKey` from `packages/arceus-mcp/src/envelope.ts` (mirroring the `.opencode/tool/_lib` version).
- [ ] For every `client.request({ idempotencyKey: randomUUID() })` call site in `packages/arceus-mcp/src/tools/*.ts` (25+ sites):
  - [ ] Replace with `idempotencyKey: deriveIdempotencyKey(ctx.beatId, "<tool_name>:<business_key>", body)`.
  - [ ] `ctx.beatId` falls back to `"shared"` if empty (for the pre-Phase-3 period when env-based ctx isn't set). Flagged with a `TODO: remove once sessionId propagation lands`.
- [ ] Add unit test: call the same tool twice with the same args → both requests produce the same idempotency-key.

**Why.** MCP mutations become genuinely retry-safe. Fixes P3 from §2.3. Enables the 5-minute idempotency cache to actually hit.

**Test.** Integration: call `sprint_create({goal:"X", tasks:[...]})` twice rapidly. Second call returns the cached response (same sprintId), not a new sprint. Assert `svc_jobs` count stays at 1.

---

#### **Phase 2 — Transport token hardening (1 PR, ~1h)**

- [ ] Create `apps/api/src/auth/bearer.ts` exporting `resolveBearerToken()` with the fail-loud-in-prod logic from §3.5.
- [ ] Replace the `?? "arceus-dev-token"` literals in `middleware.ts:43` and `packages/arceus-mcp/src/context.ts:35` with calls to `resolveBearerToken()`.
- [ ] Require token length ≥16 chars.
- [ ] Log a loud warning in dev when falling back; throw at boot in prod.
- [ ] Update `.env.example` to include a strong random `ARCEUS_TOKEN` placeholder.
- [ ] **Rotate any deployed instance that ever ran with the literal.** (Ops task — track in deployment runbook, not this PR.)

**Why.** Closes the public-repo-token hole. Fixes P4 from §2.3.

**Test.** Snapshot: with `NODE_ENV=production` and no token env, boot throws. With `NODE_ENV=development` and no env, boot warns and accepts the default. With a valid env, boot is silent.

---

#### **Phase 3 — Authoritative session-context identity (1 PR, ~4h)**

This is the big one — the actual **Agent Auth** change.

- [ ] Create `apps/api/src/auth/identity.ts` exporting `resolveAgentIdentity(req): BeatContext | AuthError` implementing the logic in §3.2.
- [ ] Replace the body of `mcpRequestContext` with a call to `resolveAgentIdentity`.
- [ ] Treat header values as advisory:
  - If all three headers are present and all agree with the resolved context → proceed.
  - If any header disagrees with the resolved context → `403 identity_mismatch`.
  - If no headers present but session resolution succeeds → proceed with resolved context.
- [ ] Prefer `req.meta?.sessionId` over `x-session-id` header (forward-compat for MCP `_meta` wiring in Phase 4).
- [ ] New error cause `identity_mismatch` in `envelope.ts` error-cause enum.
- [ ] Audit-ledger emission on every `identity_mismatch` — this is a security-sensitive event.

**Why.** Closes P5 from §2.3. Makes the governance gateway (spec 13) actually sound. Fixes Agent Auth: the server stops trusting what the caller says about its own role.

**Test.**
- Integration: agent calls `task_complete` with `x-role: developer` when session is registered as `ceo`. Expect 403 `identity_mismatch` + audit entry.
- Integration: no headers, sole active beat is ceo. Expect 200 with identity resolved to ceo.
- Integration: two parallel beats, no headers, no `sessionId`. Expect 400 `session_required`.

---

#### **Phase 4 — sessionId propagation via MCP `_meta` (1 PR, ~3h)**

End-to-end wiring so the MCP server gets the sessionId from the plugin instead of falling back to `findSoleActiveSessionContext`.

- [ ] `.opencode/plugin/arceus.ts` — on `tool.execute.before`, inject `sessionID` into the MCP tool call's `_meta` (MCP SDK supports this).
- [ ] `packages/arceus-mcp/src/server.ts` — in every `server.registerTool` handler, read `extra._meta?.sessionId` and pass to `client.request({ sessionId })`.
- [ ] `packages/arceus-mcp/src/http-client.ts` — set `x-session-id` header from `init.sessionId` (already accepts the field).
- [ ] `apps/api/src/auth/identity.ts` — prefer `x-session-id` header over `findSoleActiveSessionContext` fallback.
- [ ] Remove the `findSoleActiveSessionContext` path, leaving only `findActiveSessionContextByRole` as a residual fallback (used in error messages to disambiguate). *Or* mark it deprecated and remove in a later cleanup.

**Why.** Eliminates the "beats must serialize" correctness assumption. Unblocks parallel beats (v2). Completes Agent Auth by making the authoritative identity signal end-to-end unforgeable.

**Test.**
- Unit: plugin test — `tool.execute.before` receives sessionID and puts it in `_meta`.
- Integration: MCP server tool handler receives sessionID via `extra._meta`.
- End-to-end: spawn two parallel beats (same company, different roles); fire simultaneous tool calls; assert each gets routed to the correct identity based solely on `sessionId`.

---

### 4.3 Reasoning summary — why each fix matters

| Phase | Fix | Before → After | Closes |
|---|---|---|---|
| 0 | Regex + auto-mint removal | Derived keys rejected → accepted; no-key requests silently autoidemp → rejected with clear error | P1, P2 |
| 1 | MCP tools use `deriveIdempotencyKey` | Every MCP call had a fresh UUID → stable content-hash | P3 |
| 2 | Bearer token hardening | Public-repo literal default → fail-loud in prod | P4 |
| 3 | Session-context authoritative | `x-role` header wins over session registration → session wins, headers must agree | P5 |
| 4 | sessionId via MCP `_meta` | `findSoleActiveSession` fallback (single-beat invariant) → end-to-end session binding, parallel-beat safe | (completes §3.2) |

---

## 5. Error-cause enum additions

The `ErrorCause` type in `apps/api/src/routes/internal-mcp/envelope.ts` should include:

| Cause | HTTP | When | Next action |
|---|---|---|---|
| `session_required` | 400 | No `sessionId`, multiple active beats, can't disambiguate | Client should send `x-session-id` header or MCP `_meta.sessionId` |
| `session_not_found` | 401 | `sessionId` present but no matching BeatContext (beat ended or evicted) | Agent's beat is over; this tool call is orphaned |
| `identity_mismatch` | 403 | Headers disagree with session-context resolution | Possible spoofing attempt — audit-log emits, client should stop retrying |
| `client_supplies_key` | 400 | Non-GET without idempotency-key | Client must send a stable key |
| `body_mismatch` | 409 | Same key replayed with different body | Client is retrying with mutated payload — stop |

---

## 6. Testing

### 6.1 Unit

- `deriveIdempotencyKey` produces stable output for equal inputs and different output for any varied input.
- `resolveBearerToken` behaves correctly across `NODE_ENV` × env presence × token length matrix.
- `IDEMPOTENCY_KEY_RE` regex fixture set (20+ cases).

### 6.2 Integration

- **Idempotent replay**: fire `sprint_create` twice with same args; second call returns cached response; DB shows one sprint.
- **Body-mismatch detection**: fire twice with same key but different body; second call returns 409 `body_mismatch`.
- **Header-spoof rejection**: register beat as `developer`, call `task_complete` with `x-role: ceo`; expect 403 `identity_mismatch` + audit entry.
- **Session-required discipline**: no headers, two active beats → 400 `session_required`.
- **Session-not-found path**: submit request after beat has been unregistered → 401 `session_not_found`.

### 6.3 End-to-end

- Full OpenCode → plugin → MCP → Arceus flow, asserting `_meta.sessionId` round-trips and is the sole identity signal used on the server.
- Parallel-beats scenario (Phase 4 only): two concurrent beats, no header spoofing possible.

### 6.4 Security

- Attempt header-only spoof: sending `x-role: ceo` without a session → 400.
- Attempt session replay: capture a sessionId from beat A, send it after the beat ends → 401 `session_not_found`.
- Attempt bearer-replay with the public string → rejected in prod (even if env unset, since prod throws at boot).

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Existing clients depend on `?? randomUUID()` auto-mint | Phase 0 breaks them | Audit: grep for any client that doesn't set `idempotencyKey`. Currently: none in the repo. External clients (if any) get a clear error message. |
| Pre-Phase-3 calls rely on header override | Changing semantics of `x-role` header mid-flight breaks something | Phase 3 keeps headers as advisory — they still work **if they agree with session-context**. The only semantic change is rejecting disagreement. |
| `_meta.sessionId` not supported by the MCP SDK version we use | Phase 4 blocked | Check MCP SDK version at start of Phase 4. If unsupported, fall back to `x-session-id` header (Path B in §3.3) — functionally equivalent. |
| Boot-time throw in prod breaks existing deployments that forgot to set the env | Prod outage on next deploy | Announce 2 weeks ahead. Verify all prod env configs before landing Phase 2. Add CI check that staging deploy passes with the new resolver. |
| Idempotency cache leak across tenants | Cross-company replay attack | Cache key is `(companyId, beatId, idempotencyKey)` — tenant isolation already enforced. Add test. |

---

## 8. Migration

### 8.1 Backward compatibility during rollout

Each phase is independently deployable and the transitions are compatible:

- **Phase 0 → 1**: clients sending `randomUUID()` continue to work (UUIDs pass the new regex). Only callers that derive non-UUID keys get un-broken.
- **Phase 2**: existing deployments with env set continue unchanged. Deployments without env fail loud — fix the env, redeploy.
- **Phase 3**: clients not sending headers continue to work (resolution via session-context fallback). Clients sending *correct* headers continue to work. Only clients sending *wrong* headers (which shouldn't exist anyway) get 403.
- **Phase 4**: clients not sending `sessionId` continue to work via fallback until the fallback is removed (separate PR, post-Phase-4).

### 8.2 Rollback plan

Each phase has an independent rollback: revert the PR. The identity-mismatch and key-mismatch paths only *add* rejections — they don't break requests that would have succeeded before.

---

## 9. Success criteria

- [ ] `task_append_command` and `task_append_plan_step` succeed end-to-end (P1 resolved)
- [ ] Any MCP tool called twice rapidly with the same args hits the idempotency cache on the second call (P2, P3 resolved)
- [ ] Production boot fails without `ARCEUS_TOKEN` set; dev boot warns (P4 resolved)
- [ ] Agent cannot spoof another role via `x-role` header — 403 + audit entry (P5 resolved)
- [ ] Single source of agent-identity truth is the session-context map
- [ ] All MCP tools use `deriveIdempotencyKey`
- [ ] `IDEMPOTENCY_KEY_RE` covers the UUID + derived-key union
- [ ] `ErrorCause` enum includes `session_required`, `session_not_found`, `identity_mismatch`, `body_mismatch`
- [ ] Integration tests for all five failure modes in §6.2 pass
- [ ] Phase 4 end-to-end test passes with two parallel beats (unblocks v2 parallelism)

---

## 10. Out of scope

- Governance policy evaluation (spec 13) — this spec fixes the identity *signal*; spec 13 consumes it.
- Per-tool rate limiting — separate concern.
- Token rotation mechanism / secret-store integration — could land later; current `.env` + `ARCEUS_TOKEN` is sufficient.
- A2A protocol for cross-tenant agent calls (future) — when multi-tenant hits, auth design extends; not urgent.
- User-facing auth (there is no user-facing API at `/api/internal/v1/*`).
- Replay protection via nonce + timestamp — idempotency-key already covers the "same request twice" case; cryptographic replay is an over-engineer for an internal RPC boundary.

---

## 11. References

### In-repo files this spec touches

- [apps/api/src/routes/internal-mcp/middleware.ts](apps/api/src/routes/internal-mcp/middleware.ts) — main middleware stack
- [apps/api/src/routes/internal-mcp/idempotency.ts](apps/api/src/routes/internal-mcp/idempotency.ts) — cache implementation
- [apps/api/src/orchestration/session-context.ts](apps/api/src/orchestration/session-context.ts) — the identity map
- [packages/arceus-mcp/src/context.ts](packages/arceus-mcp/src/context.ts) — MCP server context loader
- [packages/arceus-mcp/src/http-client.ts](packages/arceus-mcp/src/http-client.ts) — HTTP client used by MCP tools
- [packages/arceus-mcp/src/tools/*.ts](packages/arceus-mcp/src/tools) — 25+ tool handlers using `randomUUID()`
- [.opencode/tool/_lib/envelope.ts](.opencode/tool/_lib/envelope.ts) — client-side `deriveIdempotencyKey`
- [.opencode/plugin/arceus.ts](.opencode/plugin/arceus.ts) — plugin for `_meta.sessionId` injection (Phase 4)

### Related specs

- [Spec 12 — Heartbeat & Scheduling](./12-heartbeat-scheduling.md) — beat lifecycle that creates + evicts sessions
- [Spec 13 — Policy & Governance Gateway](./13-policy-governance-gateway.md) — consumer of the identity signal
- [Spec 24 — Agent Conversations (Service Subagents)](./24-agent-philosophy-refactor.md) — operates on top of the authenticated identity

### External references

- OWASP Idempotency Keys guidance: https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
- MCP SDK `_meta` field: https://modelcontextprotocol.io/docs/concepts/tools
- Stripe's idempotency-key pattern (prior art): https://stripe.com/docs/api/idempotent_requests
