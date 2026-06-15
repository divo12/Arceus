/**
 * Component 3: standing board directives reach EVERY role's beat context, not
 * just the CEO. "Always use a dark theme", "never add a signup wall", "checkout
 * must work on mobile" are implementation constraints — the developer, designer,
 * PM and tester need them on every beat. renderCompanyState is the role-agnostic
 * per-beat state renderer, so injecting directives there fans them out to all
 * roles. Pure over BeatRenderContext → testable with a fixture (no DB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCompanyState } from "./beat-context-builder.js";

type Ctx = Parameters<typeof renderCompanyState>[0];

function ctx(boardContents: string[]): Ctx {
  return {
    company: { id: "c1", name: "Acme", status: "active", goal: "Build it", currentSprintId: null },
    agents: [{ id: "a1", role: "developer", displayName: "Dev" }],
    sprints: [],
    tasks: [],
    artifacts: [],
    memorySummaries: [],
    roleMemoryUnits: null,
    roleAgent: { id: "a1", role: "developer", displayName: "Dev" },
    boardMessages: boardContents.map((content, i) => ({
      id: `m${i}`,
      role: "board",
      content,
      createdAt: "2026-06-15T00:00:00.000Z",
    })),
  } as unknown as Ctx;
}

test("renderCompanyState injects standing board directives for a non-CEO role", () => {
  const out = renderCompanyState(ctx(["Always use a dark theme. Never add a signup wall."]));
  assert.match(out, /Standing board directives/i);
  assert.match(out, /dark theme/i);
  assert.match(out, /signup wall/i);
});

test("renderCompanyState surfaces a directive conflict to every role", () => {
  const out = renderCompanyState(ctx([
    "Never add a signup wall.",
    "Always add a signup wall on the landing page.",
  ]));
  assert.match(out, /CONFLICTING board directives/i);
  assert.match(out, / vs /);
});

test("renderCompanyState adds no directives block when the board gave none", () => {
  const out = renderCompanyState(ctx(["how's it going?"]));
  assert.doesNotMatch(out, /Standing board directives/i);
  // Base company-state header is still present.
  assert.match(out, /Company State/i);
});
