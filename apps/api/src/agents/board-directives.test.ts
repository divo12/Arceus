/**
 * Tests for board-directive extraction — Arceus's "owner preferences" memory.
 *
 * The board (the human owner) gives standing instructions ("always use a dark
 * theme", "never add a signup wall"). Today these scroll out of the recent-chat
 * window and the CEO forgets them. This module extracts durable directives from
 * board messages so they can be re-surfaced into the CEO's context every beat —
 * the CEO honors them across sprints and flags conflicts instead of silently
 * overriding.
 *
 * Pure + deterministic (no LLM, no DB) so the extraction contract is testable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractBoardDirectives,
  dedupeDirectivesToLatest,
  renderBoardDirectivesBlock,
  findDirectiveConflicts,
  buildDirectiveChecklistForQA,
  type BoardDirective,
} from "./board-directives.js";

function directive(statement: string, kind: BoardDirective["kind"], id = "m"): BoardDirective {
  return { key: statement.toLowerCase(), statement, kind, sourceMessageId: id, createdAt: "2026-06-15T00:00:00.000Z" };
}

type Msg = { id: string; role: string; content: string; createdAt: string };
const msg = (over: Partial<Msg> & { id: string; content: string }): Msg => ({
  role: "board",
  createdAt: "2026-06-15T00:00:00.000Z",
  ...over,
});

test("extracts ALWAYS / NEVER directives from a board message", () => {
  const out = extractBoardDirectives([
    msg({ id: "m1", content: "Always use a dark theme. Never add a signup wall." }),
  ]);
  const kinds = out.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ["always", "avoid"]);
  assert.ok(out.some((d) => /dark theme/i.test(d.statement)));
  assert.ok(out.some((d) => /signup wall/i.test(d.statement)));
  assert.ok(out.every((d) => d.sourceMessageId === "m1"));
});

test("extracts preference + constraint phrasings", () => {
  const out = extractBoardDirectives([
    msg({ id: "m2", content: "I prefer minimal copy." }),
    msg({ id: "m3", content: "The checkout must work on mobile." }),
    msg({ id: "m4", content: "don't use stock photos" }),
  ]);
  assert.equal(out.find((d) => /minimal copy/i.test(d.statement))?.kind, "prefer");
  assert.equal(out.find((d) => /checkout/i.test(d.statement))?.kind, "constraint");
  assert.equal(out.find((d) => /stock photos/i.test(d.statement))?.kind, "avoid");
});

test("ignores non-board roles and non-directive chatter", () => {
  const out = extractBoardDirectives([
    msg({ id: "a1", role: "ceo", content: "Always ship fast." }),
    msg({ id: "a2", role: "board", content: "looks great, thanks!" }),
    msg({ id: "a3", role: "board", content: "How's it going?" }),
  ]);
  assert.deepEqual(out, []);
});

test("dedupes to the latest statement of the same directive (re-stated wins)", () => {
  const a: BoardDirective = { key: "use a dark theme", statement: "use a dark theme", kind: "always", sourceMessageId: "m1", createdAt: "2026-06-10T00:00:00.000Z" };
  const b: BoardDirective = { key: "use a dark theme", statement: "use a dark theme", kind: "always", sourceMessageId: "m9", createdAt: "2026-06-14T00:00:00.000Z" };
  const deduped = dedupeDirectivesToLatest([a, b]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].sourceMessageId, "m9", "the most recent restatement wins");
});

test("renderBoardDirectivesBlock surfaces directives + a conflict-handling instruction", () => {
  const block = renderBoardDirectivesBlock([
    { key: "use a dark theme", statement: "use a dark theme", kind: "always", sourceMessageId: "m1", createdAt: "2026-06-14T00:00:00.000Z" },
    { key: "add a signup wall", statement: "add a signup wall", kind: "avoid", sourceMessageId: "m1", createdAt: "2026-06-14T00:00:00.000Z" },
  ]);
  assert.match(block, /Standing board directives/i);
  assert.match(block, /dark theme/i);
  assert.match(block, /signup wall/i);
  // The CEO must be told to flag conflicts, not silently override.
  assert.match(block, /conflict|contradict/i);
});

test("renderBoardDirectivesBlock is empty when there are no directives (no prompt bloat)", () => {
  assert.equal(renderBoardDirectivesBlock([]), "");
});

// ── Wiring: the CEO operating prompt must actually surface board directives ──

import { createEmptyCompanySnapshot } from "@arceus/company-runtime";
import { buildCeoOperatingPrompt } from "./ceo.js";
import type { ChatMessage } from "@arceus/contracts";

function boardChat(id: string, content: string): ChatMessage {
  return {
    id,
    companyId: "company_test",
    sprintId: null,
    agentId: null,
    role: "board",
    content,
    cardType: null,
    cardData: null,
    createdAt: "2026-06-15T00:00:00.000Z",
  } as ChatMessage;
}

test("buildCeoOperatingPrompt injects standing board directives from board chat", () => {
  const snapshot = createEmptyCompanySnapshot();
  snapshot.chatMessages = [
    boardChat("m1", "Always use a dark theme. Never add a signup wall."),
    boardChat("m2", "looks good"),
  ];
  const prompt = buildCeoOperatingPrompt(snapshot);
  assert.match(prompt, /Standing board directives/i, "directives block must be in the CEO prompt");
  assert.match(prompt, /dark theme/i);
  assert.match(prompt, /signup wall/i);
});

test("buildCeoOperatingPrompt adds no directives block when board gave none", () => {
  const snapshot = createEmptyCompanySnapshot();
  snapshot.chatMessages = [boardChat("m1", "How's progress looking?")];
  const prompt = buildCeoOperatingPrompt(snapshot);
  assert.doesNotMatch(prompt, /Standing board directives/i);
});

// ── Component 2: contradiction detection ──

test("findDirectiveConflicts flags opposite-polarity directives on the same topic", () => {
  const conflicts = findDirectiveConflicts([
    directive("Never add a signup wall", "avoid", "m1"),
    directive("Always add a signup wall", "always", "m2"),
  ]);
  assert.equal(conflicts.length, 1);
  assert.ok(/signup wall/i.test(conflicts[0].a.statement));
  assert.ok(/signup wall/i.test(conflicts[0].b.statement));
});

test("findDirectiveConflicts flags avoid-vs-prefer on the same topic", () => {
  const conflicts = findDirectiveConflicts([
    directive("Avoid stock photos", "avoid", "m1"),
    directive("Use stock photos for the hero", "prefer", "m2"),
  ]);
  assert.equal(conflicts.length, 1);
});

test("findDirectiveConflicts does NOT flag agreeing directives (both positive)", () => {
  const conflicts = findDirectiveConflicts([
    directive("Always use a dark theme", "always", "m1"),
    directive("Use a dark theme everywhere", "prefer", "m2"),
  ]);
  assert.deepEqual(conflicts, []);
});

test("findDirectiveConflicts does NOT flag unrelated directives", () => {
  const conflicts = findDirectiveConflicts([
    directive("Always use a dark theme", "always", "m1"),
    directive("Never add a signup wall", "avoid", "m2"),
  ]);
  assert.deepEqual(conflicts, []);
});

test("findDirectiveConflicts does NOT flag two avoids on the same topic (they agree)", () => {
  const conflicts = findDirectiveConflicts([
    directive("Never add a signup wall", "avoid", "m1"),
    directive("Avoid any signup wall", "avoid", "m2"),
  ]);
  assert.deepEqual(conflicts, []);
});

test("renderBoardDirectivesBlock surfaces a CONFLICT warning when directives contradict", () => {
  const block = renderBoardDirectivesBlock([
    directive("Never add a signup wall", "avoid", "m1"),
    directive("Always add a signup wall", "always", "m2"),
  ]);
  // Specific to the new pairing logic (the generic block already says "conflict"):
  assert.match(block, /CONFLICTING|⚠/);
  assert.match(block, / vs /, "must pair the two conflicting directives");
});

// ── Component 4: directive-aware flow-test (QA verifies the product honors them) ──

test("buildDirectiveChecklistForQA turns board directives into a verification checklist", () => {
  const checklist = buildDirectiveChecklistForQA([
    msg({ id: "m1", content: "Always use a dark theme. Never add a signup wall." }),
  ]);
  assert.match(checklist, /verify|honor/i);
  assert.match(checklist, /dark theme/i);
  assert.match(checklist, /signup wall/i);
});

test("buildDirectiveChecklistForQA is empty when the board gave no directives", () => {
  assert.equal(buildDirectiveChecklistForQA([msg({ id: "m1", content: "looks good" })]), "");
});

test("buildCeoOperatingPrompt surfaces a directive conflict from the board chat", () => {
  const snapshot = createEmptyCompanySnapshot();
  snapshot.chatMessages = [
    boardChat("m1", "Never add a signup wall."),
    boardChat("m2", "Actually, always add a signup wall on the landing page."),
  ];
  const prompt = buildCeoOperatingPrompt(snapshot);
  assert.match(prompt, /CONFLICTING board directives/i);
  assert.match(prompt, / vs /);
});
