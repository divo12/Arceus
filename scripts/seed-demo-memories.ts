/**
 * Seed fake demo memories for the LeftoverLink food-sharing app.
 * Run: npx tsx scripts/seed-demo-memories.ts
 */
import { getDb } from "../packages/db/src/client.js";
import { createMemoryUnit } from "../packages/db/src/repos/memory_units.js";
import { upsertSummary } from "../packages/db/src/repos/memory_summaries.js";
import { friendlyToUuid } from "../packages/db/src/repos/_uuid.js";
import { randomUUID } from "node:crypto";

const COMPANY_FRIENDLY = "company_5c1885c1-a643-41c0-b093-1f6422df7dc1";
const COMPANY_ID = friendlyToUuid(COMPANY_FRIENDLY);

// Agent IDs from the strategy_apply result
const AGENTS = {
  ceo:         "1cbddb48-7d0a-5b66-90e1-d611cbfed892",
  cto:         "d16e81d4-e710-55c7-b9cc-7c789b8e3745",
  pm:          "eb8f0790-24d1-58ae-ac4a-e0e88d1cabc4",
  developer:   "f7c7f4cf-330e-57c6-bbb5-93939f580cb9",
  tester:      "97b87c82-1447-5e14-8e19-b9ac4a7f23f2",
  ui_designer: "5b993b73-a148-5bcd-b3f2-4d20db49f14f",
  skills_lead: "498fc4ea-f9f0-507a-a2b5-c6f3a1ef4b43",
};

// ── Memory units (granular facts) ──────────────────────────
const memoryFacts = [
  // CEO
  { agentId: AGENTS.ceo, type: "static", kind: "lesson", content: "The board approved the zero-waste food sharing concept because it has strong neighborhood network effects — once 10 households join, viral growth kicks in.", tags: ["strategy", "growth"] },
  { agentId: AGENTS.ceo, type: "dynamic", kind: "observation", content: "Sprint 1 velocity was higher than expected. The team shipped photo posting, claiming, and notifications in 5 days. We should maintain this pace for Sprint 2.", tags: ["velocity", "sprint-review"] },
  { agentId: AGENTS.ceo, type: "static", kind: "decision", content: "Decided to launch as a mobile-first web app (no native app yet) to reduce time-to-market. PWA support will be added in Sprint 3.", tags: ["architecture", "launch-strategy"] },

  // CTO
  { agentId: AGENTS.cto, type: "static", kind: "architecture", content: "Chose Vite + React for the frontend — fast dev loop, small bundle. Image handling uses client-side compression before upload to keep bandwidth low on mobile.", tags: ["architecture", "frontend"] },
  { agentId: AGENTS.cto, type: "procedural", kind: "best-practice", content: "Always compress food photos client-side to < 200KB before upload. Neighborhood users are often on mobile data.", tags: ["performance", "images"] },
  { agentId: AGENTS.cto, type: "dynamic", kind: "observation", content: "The claim flow needs optimistic UI — when a user claims food, update the card immediately and reconcile on server response. Reduces perceived latency.", tags: ["ux", "performance"] },

  // PM
  { agentId: AGENTS.pm, type: "static", kind: "user-research", content: "User interviews: top 3 pain points are (1) food going to waste before anyone sees it, (2) no way to coordinate pickup time, (3) allergy/dietary info is missing from posts.", tags: ["research", "user-needs"] },
  { agentId: AGENTS.pm, type: "static", kind: "decision", content: "Prioritized allergen tags in Sprint 1 based on user feedback. Every food post must show dietary tags prominently — this is a safety feature, not a nice-to-have.", tags: ["prioritization", "safety"] },
  { agentId: AGENTS.pm, type: "dynamic", kind: "metric", content: "Key metrics: posts/day, claim rate (% of posts claimed within 4 hours), time-to-claim (median), food waste reduction ratio. Target claim rate: > 60%.", tags: ["metrics", "kpi"] },

  // Developer
  { agentId: AGENTS.developer, type: "procedural", kind: "pattern", content: "Used React state with seed data for the MVP to avoid backend complexity. Food posts are modeled as { id, title, description, image, tags, author, distance, postedAt, claimedBy }.", tags: ["implementation", "data-model"] },
  { agentId: AGENTS.developer, type: "static", kind: "lesson", content: "The FoodCard component renders the photo, distance badge, allergen tags, author, and claim button. Claimed cards show the claimer name and reduce opacity to 0.7.", tags: ["component", "UI"] },
  { agentId: AGENTS.developer, type: "dynamic", kind: "blocker-resolved", content: "Fixed issue where the claim modal didn't close when clicking outside. Added onClick handler on the backdrop overlay with currentTarget check.", tags: ["bugfix", "modal"] },
  { agentId: AGENTS.developer, type: "procedural", kind: "pattern", content: "PostForm uses a bottom sheet pattern (slides up from bottom on mobile). Photo URL is optional — if omitted, a random Unsplash food photo is used.", tags: ["implementation", "form"] },

  // Tester
  { agentId: AGENTS.tester, type: "static", kind: "test-coverage", content: "Tested all 3 main flows: posting food (with/without photo), claiming food (enter name → confirm), and filtering (all/available/claimed). All pass.", tags: ["testing", "coverage"] },
  { agentId: AGENTS.tester, type: "dynamic", kind: "finding", content: "Found edge case: if two neighbors try to claim the same item simultaneously, both see success. Need backend-side locking in Sprint 2 when we add persistence.", tags: ["bug", "race-condition"] },
  { agentId: AGENTS.tester, type: "procedural", kind: "checklist", content: "Pre-release checklist: (1) allergen tags visible, (2) claim button disabled after claim, (3) empty state shows 'No food posted yet', (4) time-ago displays correctly, (5) mobile viewport scrolls correctly.", tags: ["qa", "checklist"] },

  // UI Designer
  { agentId: AGENTS.ui_designer, type: "static", kind: "design-system", content: "Design tokens: warm palette (#fafaf8 bg, #2d9d5c accent green, #f5efe6 warm highlights). Border radius 12px. Shadow 0 1px 3px. Font: system-ui stack. Mobile-first max-width 480px.", tags: ["design", "tokens"] },
  { agentId: AGENTS.ui_designer, type: "static", kind: "decision", content: "Cards use full-width images (200px height, object-fit cover) with distance overlay (top-left) and claim badge (top-right). Author shown with circular avatar initial.", tags: ["design", "cards"] },
  { agentId: AGENTS.ui_designer, type: "procedural", kind: "pattern", content: "Filter pills use a horizontal scrollable row with 20px border-radius. Active state: green fill (#2d9d5c) with white text. Inactive: white fill with muted text.", tags: ["design", "filters"] },
];

// ── Memory summaries (agent-level rollups) ─────────────────
const summaries = [
  {
    id: `memory_${AGENTS.ceo}`,
    agentId: AGENTS.ceo,
    currentFocus: ["Preparing Sprint 2 roadmap", "Evaluating partnership with local food banks"],
    recentLearnings: ["Mobile-first approach reduced time-to-market by 40%", "Neighborhood food sharing has strong viral loop potential"],
    activePatterns: ["Converge quickly on scope rather than over-discussing", "Push for demoable output every sprint"],
    openBlockers: [],
    importantDecisions: ["Launch as PWA, defer native apps to Q3", "Zero-waste metric as north star KPI"],
    updatedAt: new Date().toISOString(),
  },
  {
    id: `memory_${AGENTS.cto}`,
    agentId: AGENTS.cto,
    currentFocus: ["Image compression pipeline optimization", "Planning real-time notification system for Sprint 2"],
    recentLearnings: ["Client-side image compression saves 70% bandwidth on mobile", "Vite HMR makes iteration fast for the small team"],
    activePatterns: ["Always prototype with seed data before adding backend", "Optimize for mobile-first performance"],
    openBlockers: ["Need to decide on backend: Supabase vs custom API"],
    importantDecisions: ["Vite + React for frontend", "No native app — PWA only for MVP"],
    updatedAt: new Date().toISOString(),
  },
  {
    id: `memory_${AGENTS.pm}`,
    agentId: AGENTS.pm,
    currentFocus: ["Analyzing claim-rate metrics from Sprint 1", "Writing Sprint 2 user stories for pickup coordination"],
    recentLearnings: ["Allergen tags are a safety-critical feature — must be prominent", "Users want pickup time windows, not just addresses"],
    activePatterns: ["Validate with real neighbors before building", "Ship small, measure, iterate"],
    openBlockers: [],
    importantDecisions: ["Allergen tags mandatory on every post", "Claim rate > 60% is the success metric"],
    updatedAt: new Date().toISOString(),
  },
  {
    id: `memory_${AGENTS.developer}`,
    agentId: AGENTS.developer,
    currentFocus: ["Building the claim confirmation flow", "Implementing filter bar with available/claimed tabs"],
    recentLearnings: ["Bottom sheet modal pattern works well for mobile post forms", "Seed data approach lets us demo without backend"],
    activePatterns: ["Components: Header, FoodGrid, FoodCard, PostForm, ClaimModal", "Inline styles for rapid prototyping, extract to CSS later"],
    openBlockers: [],
    importantDecisions: ["React state for MVP, add persistence in Sprint 2", "Unsplash fallback for missing food photos"],
    updatedAt: new Date().toISOString(),
  },
  {
    id: `memory_${AGENTS.tester}`,
    agentId: AGENTS.tester,
    currentFocus: ["Verifying claim flow edge cases", "Testing mobile viewport breakpoints"],
    recentLearnings: ["Concurrent claim race condition needs backend-side locking", "Empty state rendering is important for first-time users"],
    activePatterns: ["Test all 3 flows: post, claim, filter", "Check allergen tag visibility on every card"],
    openBlockers: ["Cannot test real concurrent claims without backend"],
    importantDecisions: ["Pre-release checklist: allergens, claim button state, empty state, time-ago, scroll"],
    updatedAt: new Date().toISOString(),
  },
  {
    id: `memory_${AGENTS.ui_designer}`,
    agentId: AGENTS.ui_designer,
    currentFocus: ["Refining card hover states for desktop", "Designing pickup coordination modal for Sprint 2"],
    recentLearnings: ["Warm earth tones feel welcoming for community app", "Full-width card images with overlays create visual hierarchy"],
    activePatterns: ["Mobile-first 480px max-width", "System font stack for native feel"],
    openBlockers: [],
    importantDecisions: ["Green accent (#2d9d5c) for positive actions (share, claim)", "Cards show distance, allergens, and author prominently"],
    updatedAt: new Date().toISOString(),
  },
];

async function main() {
  const db = getDb();

  // Insert memory units
  let inserted = 0;
  for (const fact of memoryFacts) {
    await createMemoryUnit(db, {
      id: randomUUID(),
      companyId: COMPANY_ID as string,
      agentId: fact.agentId,
      type: fact.type,
      kind: fact.kind,
      content: fact.content,
      tags: fact.tags,
      confidence: 0.85 + Math.random() * 0.15,
      relevanceScore: 0.9 + Math.random() * 0.1,
      container: "",
    });
    inserted++;
  }
  console.log(`Inserted ${inserted} memory units`);

  // Upsert memory summaries
  for (const summary of summaries) {
    await upsertSummary(db, summary, COMPANY_FRIENDLY);
  }
  console.log(`Upserted ${summaries.length} memory summaries`);

  console.log("Done — demo memories seeded.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
