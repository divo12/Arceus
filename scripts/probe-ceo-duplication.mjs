// Probe Spec 35 chat duplication: send a free-form idea, capture both
// the CEO's streamed text AND the chat_emit_card output, and report
// whether they overlap (the question repeated in plaintext + in the card).
import { EventSource } from "eventsource";
const API = "http://localhost:4000";
const TOKEN = "arceus-dev-token";
const COMPANY = "00000000-0000-4000-a000-000000000001";

const message = "I want to build a tiny tool that helps remote teams capture meeting decisions in 30 seconds.";
const url = `${API}/api/chat/ceo/stream?message=${encodeURIComponent(message)}&mode=instruct`;

const cardEvents = [];
const cardSse = new EventSource(`${API}/api/chat/stream`, { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}`, "X-Company-Id": COMPANY } }) });
cardSse.addEventListener("chat.card_added", (e) => {
  try { cardEvents.push(JSON.parse(e.data)); } catch {}
});

let ceoText = "";
const ceoEs = new EventSource(url, { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}`, "X-Company-Id": COMPANY } }) });
ceoEs.addEventListener("token", (e) => {
  try { const p = JSON.parse(e.data); if (p.content) ceoText = p.content; } catch {}
});
ceoEs.addEventListener("proposal", (e) => { console.log("LEGACY PROPOSAL CARD:", e.data.slice(0, 200)); });
const done = new Promise((r) => ceoEs.addEventListener("done", () => r()));
await done;
ceoEs.close();
// Wait briefly for any chat_emit_card events to arrive on the chat stream.
await new Promise((r) => setTimeout(r, 1500));
cardSse.close();

console.log("=== CEO STREAMED TEXT ===");
console.log(ceoText);
console.log("\n=== CARDS EMITTED (chat_emit_card / chat.card_added) ===");
for (const ev of cardEvents) {
  console.log(JSON.stringify({ id: ev.message?.id, role: ev.message?.role, cardType: ev.message?.cardType, content: ev.message?.content, dataKeys: Object.keys(ev.message?.cardData ?? {}) }, null, 2));
}
console.log("\n=== OVERLAP CHECK ===");
console.log("CEO text length:", ceoText.length);
console.log("Cards emitted:", cardEvents.length);
