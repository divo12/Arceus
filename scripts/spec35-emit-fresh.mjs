import { randomUUID } from "node:crypto";
const API = "http://localhost:4000";
const COMPANY = "00000000-0000-4000-a000-000000000001";
const TOKEN = process.env.ARCEUS_TOKEN ?? "arceus-dev-token";
function H() { return { "Content-Type":"application/json", Authorization:`Bearer ${TOKEN}`, "X-Company-Id":COMPANY, "X-Agent-Role":"ceo", "X-Beat-Id":`beat_${randomUUID()}`, "Idempotency-Key":`key_${randomUUID()}` }; }
async function emit(type, payload, marker) {
  const r = await fetch(`${API}/api/internal/v1/chat/cards`, { method:"POST", headers:H(), body:JSON.stringify({type, payload}) });
  const j = await r.json();
  console.log(marker, type, "→", j.data?.cardId);
  return j.data?.cardId;
}
const t = Date.now();
const ns = await emit("name_suggest", { suggestions:[{name:`NS-${t}-Alpha`,rationale:"alpha"},{name:`NS-${t}-Beta`,rationale:"beta"}], allowWriteIn:true }, "[fresh]");
const hs = await emit("hiring_slate", { roles:[{role:"cto",displayName:`CTO-${t}`,title:"CTO",rationale:"r"}] }, "[fresh]");
const sp = await emit("sprint_plan", { sprintNumber:99, goal:`SPRINT-GOAL-${t}`, tasks:[{title:"T1",assignedRole:"developer"}] }, "[fresh]");
const ms = await emit("meeting_summary", { meetingId:`mtg_${t}`, topic:`Daily sync ${t}`, decisions:["d1"], actionItems:[] }, "[fresh]");
const dc = await emit("decision", { question:`DECISION-${t}?`, options:[{id:"y",label:"yes"},{id:"n",label:"no"}] }, "[fresh]");
const mc = await emit("memory_capture", { content:`MEM-${t}: regression check`, tier:"dynamic", scope:"team" }, "[fresh]");
console.log(JSON.stringify({ns,hs,sp,ms,dc,mc}));
