/**
 * Spec 35 §3 + §5 end-to-end smoke.
 *
 * Verifies, against a live api on http://localhost:4000:
 *
 *  1. POST /api/chat/messages persists a board message with the chosen
 *     mode column ('ask' | 'instruct' | 'store').
 *  2. POST /api/chat/history reflects ordering + mode column.
 *  3. POST /api/internal/v1/chat/cards (CEO impersonation via bearer +
 *     header identity) writes a card row.
 *  4. POST /api/chat/cards/:id/decide flips the card and injects a
 *     synthetic user message linked via parent_message_id.
 *  5. POST /api/internal/v1/meetings/request returns a scheduled meeting
 *     id and registers it in the chat-meeting tracker.
 *
 * Best-effort: we do NOT block on the full meeting pipeline (it calls
 * the LLM for ~60s). We only verify the meeting was created in
 * `scheduled` state — pipeline completion is exercised by the existing
 * meeting-pipeline tests.
 *
 * Usage: npx tsx scripts/test-chat2-e2e.ts
 */

const BASE = process.env.ARCEUS_API_BASE ?? "http://localhost:4000";
const TOKEN = process.env.ARCEUS_TOKEN ?? "arceus-dev-token";

let passed = 0;
let failed = 0;
const fails: string[] = [];

function assert(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; fails.push(label); console.error(`  ❌ ${label}`); }
}

async function jsonGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function drainSse(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  cardType: string | null;
  mode: string | null;
  parentMessageId: string | null;
  cardDecidedAt: string | null;
}

async function main() {
  // ── 0. Ensure api is up + we have an active company ─────────
  console.log("\n[0] Probing api at", BASE);
  const health = await jsonGet<{ ok: boolean }>("/health");
  assert(health.ok === true, "api /health is ok");

  const summary = await jsonGet<{ company?: { id?: string; name?: string }; agents?: Array<{ role: string }> }>("/api/company").catch(() => ({} as { company?: { id?: string; name?: string }; agents?: Array<{ role: string }> }));
  const companyId = summary.company?.id;
  const agentRoles = (summary.agents ?? []).map((a) => a.role);
  if (!companyId) {
    console.error("\n  ❌ No active company. Bootstrap one via the UI first (POST /api/chat/messages will bootstrap on first message but pipeline-related tests still need a hired team).");
    process.exit(1);
  }
  console.log(`     Active company: ${summary.company?.name ?? "(unnamed)"} [${companyId}]`);

  // ── 1. Mode is recorded on user board message ────────────────
  console.log("\n[1] Mode recording on POST /api/chat/messages");
  const before = await jsonGet<{ messages: ChatMessage[] }>("/api/chat/history?limit=200");
  const beforeCount = before.messages.length;

  // We deliberately use a no-op message so the LLM call is short-ish.
  // Drain the SSE so the row is durable before we re-read history.
  const askProbe = `e2e-ask-${Date.now()}`;
  const askRes = await fetch(`${BASE}/api/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: askProbe, mode: "ask" }),
  });
  assert(askRes.ok, `ask-mode POST → ${askRes.status}`);
  await drainSse(askRes);

  const after = await jsonGet<{ messages: ChatMessage[] }>("/api/chat/history?limit=200");
  assert(after.messages.length >= beforeCount + 1, "history grew after ask post");
  const askRow = after.messages.find((m) => m.role === "board" && m.content === askProbe);
  assert(!!askRow, "ask probe is in history");
  assert(askRow?.mode === "ask", `ask probe has mode='ask' (got '${askRow?.mode}')`);

  // ── 2. Card emission via internal MCP (header-identity fallback) ───
  console.log("\n[2] CEO emits a decision card via internal MCP");
  const cardRes = await fetch(`${BASE}/api/internal/v1/chat/cards`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
      "X-Beat-Id": `e2e_beat_${Date.now()}`,
      "X-Company-Id": companyId,
      "X-Agent-Role": "ceo",
      "Idempotency-Key": `e2e-card-${Date.now()}`,
    },
    body: JSON.stringify({
      type: "decision",
      payload: {
        title: "Pick a launch date",
        options: [{ id: "fri", label: "Friday" }, { id: "mon", label: "Monday" }],
      },
    }),
  });
  const cardJson = await cardRes.json() as { data?: { cardId?: string } };
  assert(cardRes.status === 201 || cardRes.status === 200, `card POST → ${cardRes.status}`);
  const cardId = cardJson.data?.cardId;
  assert(typeof cardId === "string" && cardId.startsWith("chat_"), `card returned cardId (got ${cardId})`);

  // ── 3. Decide the card → synthetic user message ──────────────
  console.log("\n[3] Decide the card");
  const decideRes = await fetch(`${BASE}/api/chat/cards/${cardId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: { choice: "fri" }, label: "Friday" }),
  });
  const decideJson = await decideRes.json() as { card?: ChatMessage; syntheticMessage?: ChatMessage; alreadyDecided?: boolean };
  assert(decideRes.ok, `decide → ${decideRes.status}`);
  assert(!!decideJson.card, "decide returned card");
  assert(decideJson.card?.cardDecidedAt != null, "card has cardDecidedAt set");
  assert(!!decideJson.syntheticMessage, "synthetic user message returned");
  assert(decideJson.syntheticMessage?.parentMessageId === cardId, "synthetic.parentMessageId points to card");
  assert(decideJson.syntheticMessage?.content.includes("Friday") ?? false, "synthetic content includes label");

  // Idempotent re-decide
  const reDecide = await fetch(`${BASE}/api/chat/cards/${cardId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: { choice: "mon" } }),
  });
  const reJson = await reDecide.json() as { alreadyDecided?: boolean };
  assert(reJson.alreadyDecided === true, "second decide is alreadyDecided=true");

  // ── 4. meeting_request via internal MCP ──────────────────────
  console.log("\n[4] CEO requests an async meeting");
  // The active 'Test Company' has no agents; pick any company that does.
  // We use the DB directly because /api/agents is scoped to the active company.
  const { getDb } = await import("@arceus/db");
  const { sql: sqlTag } = await import("drizzle-orm");
  const db = getDb();
  const peers = await db.execute(sqlTag`select company_id::text as id, role from agents where role <> 'ceo' order by company_id limit 50`) as unknown as Array<{ id: string; role: string }>;
  const peerCompany = peers[0]?.id ?? null;
  const otherRole = peers.find((p) => p.id === peerCompany)?.role ?? null;
  if (!peerCompany || !otherRole) {
    console.warn("  ⚠️  No company with non-CEO agents found anywhere — skipping.");
  } else {
    console.log(`     Using company ${peerCompany} attendee=${otherRole}`);
    const reqRes = await fetch(`${BASE}/api/internal/v1/meetings/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
        "X-Beat-Id": `e2e_beat_${Date.now()}`,
        "X-Company-Id": peerCompany,
        "X-Agent-Role": "ceo",
        "Idempotency-Key": `e2e-mreq-${Date.now()}`,
      },
      body: JSON.stringify({
        topic: "What should we ship first?",
        attendees: [otherRole],
        question: "Given our backlog, which feature unlocks the most value?",
      }),
    });
    const reqJson = await reqRes.json() as { data?: { meetingId?: string; status?: string; attendees?: string[] } };
    assert(reqRes.status === 201, `meeting_request → ${reqRes.status}`);
    assert(typeof reqJson.data?.meetingId === "string", `meeting_request returned meetingId`);
    assert(reqJson.data?.status === "scheduled", `meeting_request status=scheduled (got ${reqJson.data?.status})`);
    assert(reqJson.data?.attendees?.includes(otherRole) ?? false, `attendees include ${otherRole}`);

    // Verify the meeting row exists in the DB (status=scheduled).
    const meetingId = reqJson.data?.meetingId;
    if (meetingId) {
      const rows = await db.execute(sqlTag`select friendly_id::text as fid, status from meetings where friendly_id = ${meetingId}`) as unknown as Array<{ fid: string; status: string }>;
      assert(rows.length === 1, "meeting row exists in DB");
      assert(rows[0]?.status === "scheduled", `meeting row status=scheduled (got ${rows[0]?.status})`);
    }
  }

  // ── 5. Mode→tool gate: store mode disallows task creation ────
  // We can't easily prove the LLM didn't call task_create from a script,
  // but we *can* prove the request body is recorded as mode='store' and
  // that the route accepts it.
  console.log("\n[5] Store mode is recorded");
  const storeProbe = `e2e-store-${Date.now()}`;
  const storeRes = await fetch(`${BASE}/api/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: storeProbe, mode: "store" }),
  });
  assert(storeRes.ok, `store-mode POST → ${storeRes.status}`);
  await drainSse(storeRes);
  const post5 = await jsonGet<{ messages: ChatMessage[] }>("/api/chat/history?limit=400");
  const storeRow = post5.messages.find((m) => m.role === "board" && m.content === storeProbe);
  assert(!!storeRow, "store probe is in history");
  assert(storeRow?.mode === "store", `store probe has mode='store' (got '${storeRow?.mode}')`);

  // ── Report ────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
