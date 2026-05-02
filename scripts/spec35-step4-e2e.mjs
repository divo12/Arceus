// Spec 35 Step 4 — emit each new bootstrap card type via internal MCP,
// verify they appear in /api/chat/history, decide each one, verify
// synthetic user messages are appended.
import { randomUUID } from "node:crypto";

const API = "http://localhost:4000";
const COMPANY = "00000000-0000-4000-a000-000000000001";
const TOKEN = process.env.ARCEUS_TOKEN ?? "arceus-dev-token";

function emitHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
    "X-Company-Id": COMPANY,
    "X-Agent-Role": "ceo",
    "X-Beat-Id": `beat_${randomUUID()}`,
    "Idempotency-Key": `key_${randomUUID()}`,
  };
}

async function emitCard(type, payload) {
  const r = await fetch(`${API}/api/internal/v1/chat/cards`, {
    method: "POST",
    headers: emitHeaders(),
    body: JSON.stringify({ type, payload }),
  });
  const j = await r.json();
  if (!r.ok || j.status !== "success") throw new Error(`emit ${type} failed: ${r.status} ${JSON.stringify(j)}`);
  console.log(`  ✓ emit ${type} → ${j.data.cardId}`);
  return j.data.cardId;
}

async function decide(cardId, decision, label) {
  const r = await fetch(`${API}/api/chat/cards/${cardId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, decidedBy: "user", label }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`decide ${cardId} failed: ${r.status} ${JSON.stringify(j)}`);
  console.log(`  ✓ decide ${cardId} → ${JSON.stringify(decision)}`);
  return j;
}

async function history() {
  const r = await fetch(`${API}/api/chat/history?limit=50`);
  const j = await r.json();
  return j.messages ?? j;
}

console.log("=== Spec 35 Step 4 e2e: bootstrap cards ===");

const ideaId = await emitCard("idea_refine", {
  originalIdea: "I want to build a markdown notes app",
  reframings: [
    { id: "a", title: "Local-first vault", summary: "Plain .md files in a folder" },
    { id: "b", title: "Cloud-sync notes", summary: "Encrypted sync across devices" },
    { id: "c", title: "Collab notes", summary: "Real-time multi-cursor editing" },
  ],
});

const nameId = await emitCard("name_suggest", {
  suggestions: [
    { name: "Inkwell", rationale: "Writerly, clean" },
    { name: "Marrow", rationale: "Core of your thinking" },
    { name: "Loomy", rationale: "Weaves notes together" },
  ],
  allowWriteIn: true,
});

const hireId = await emitCard("hiring_slate", {
  roles: [
    { role: "cto", displayName: "Lin", title: "CTO", rationale: "Owns architecture" },
    { role: "designer", displayName: "Mira", title: "Designer", rationale: "Owns UX" },
    { role: "developer", displayName: "Sam", title: "Developer", rationale: "Ships features" },
  ],
});

const sprintId = await emitCard("sprint_plan", {
  sprintNumber: 1,
  goal: "Ship a usable single-vault markdown editor in week 1",
  tasks: [
    { title: "Scaffold Next.js project", assignedRole: "developer" },
    { title: "Wire local-storage persistence", assignedRole: "developer" },
    { title: "Style editor canvas", assignedRole: "designer" },
  ],
});

console.log("\n--- waiting 1s, then verifying via /api/chat/history ---");
await new Promise((r) => setTimeout(r, 1000));
const before = await history();
const ids = new Set([ideaId, nameId, hireId, sprintId]);
const found = before.filter((m) => ids.has(m.id));
console.log(`  found ${found.length}/4 emitted cards in history`);
for (const m of found) {
  console.log(`    - ${m.id}  cardType=${m.cardType}  decision=${JSON.stringify(m.cardDecision)}`);
}
if (found.length !== 4) throw new Error("not all cards present in history");

console.log("\n--- deciding each card ---");
await decide(ideaId, { kind: "reframing_picked", reframingId: "a" }, "picked reframing: Local-first vault");
await decide(nameId, { kind: "name_picked", name: "Inkwell" }, "picked name: Inkwell");
await decide(hireId, { kind: "hiring_approved" }, "approved hiring slate");
await decide(sprintId, { kind: "sprint_kickoff" }, "kicked off Sprint 1");

await new Promise((r) => setTimeout(r, 500));
const after = await history();
console.log("\n--- verifying decisions + synthetic user messages ---");
let pass = 0;
for (const [cardId, expectedLabel] of [
  [ideaId, "picked reframing: Local-first vault"],
  [nameId, "picked name: Inkwell"],
  [hireId, "approved hiring slate"],
  [sprintId, "kicked off Sprint 1"],
]) {
  const card = after.find((m) => m.id === cardId);
  const synth = after.find((m) => m.role === "board" && m.content?.includes(expectedLabel));
  const ok = card?.cardDecision != null && card?.cardDecidedAt != null && synth != null;
  console.log(
    `  ${ok ? "✓" : "✗"} ${card?.cardType?.padEnd(14)} decided=${!!card?.cardDecision}  synthetic=${synth ? `"${synth.content.slice(0, 70)}..."` : "MISSING"}`,
  );
  if (ok) pass++;
}
console.log(`\n=== ${pass}/4 cards passed full lifecycle ===`);
process.exit(pass === 4 ? 0 : 1);
