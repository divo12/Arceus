import { randomUUID } from "node:crypto";
const API = "http://localhost:4000";
const COMPANY = "00000000-0000-4000-a000-000000000001";
const TOKEN = process.env.ARCEUS_TOKEN ?? "arceus-dev-token";
const r = await fetch(`${API}/api/internal/v1/chat/cards`, {
  method: "POST",
  headers: { "Content-Type":"application/json", Authorization:`Bearer ${TOKEN}`, "X-Company-Id":COMPANY, "X-Agent-Role":"ceo", "X-Beat-Id":`beat_${randomUUID()}`, "Idempotency-Key":`key_${randomUUID()}` },
  body: JSON.stringify({
    type: "hiring_slate",
    payload: { roles: [
      { role: "cto", displayName: "Lin", title: "CTO", rationale: "Owns architecture" },
      { role: "designer", displayName: "Mira", title: "Designer", rationale: "Owns UX" },
      { role: "developer", displayName: "Sam", title: "Developer", rationale: "Ships features" },
    ] },
  }),
});
const j = await r.json();
console.log(j.data?.cardId);
