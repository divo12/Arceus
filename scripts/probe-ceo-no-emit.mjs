// Probe: send a question that should NOT trigger chat_emit_card.
// The legacy classifier should still fire and produce a proposal card.
import { EventSource } from "eventsource";
const API = "http://localhost:4000";
const TOKEN = "arceus-dev-token";
const COMPANY = "00000000-0000-4000-a000-000000000001";

const message = "What is our current company name?";
const url = `${API}/api/chat/ceo/stream?message=${encodeURIComponent(message)}&mode=ask`;

const cardEvents = [];
const cardSse = new EventSource(`${API}/api/chat/stream`, { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}`, "X-Company-Id": COMPANY } }) });
cardSse.addEventListener("chat.card_added", (e) => { try { cardEvents.push(JSON.parse(e.data)); } catch {} });

let ceoText = "";
let legacyProposal = null;
const ceoEs = new EventSource(url, { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}`, "X-Company-Id": COMPANY } }) });
ceoEs.addEventListener("token", (e) => { try { const p = JSON.parse(e.data); if (p.content) ceoText = p.content; } catch {} });
ceoEs.addEventListener("proposal", (e) => { try { legacyProposal = JSON.parse(e.data); } catch {} });
const done = new Promise((r) => ceoEs.addEventListener("done", () => r()));
await done;
ceoEs.close();
await new Promise((r) => setTimeout(r, 1500));
cardSse.close();

console.log("CEO text:", ceoText.slice(0, 150));
console.log("Legacy proposal card_type:", legacyProposal?.card_type ?? "(none)");
console.log("chat_emit_card events:", cardEvents.length);
