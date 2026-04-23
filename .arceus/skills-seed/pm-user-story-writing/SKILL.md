---
name: pm-user-story-writing
description: Write user stories with concrete acceptance criteria QA can mechanically verify. Forces what-and-why before handoff.
role: pm
trigger: creating an implementation task for dev, or writing a task description that's more than "add feature X"
---

# User Story Writing

A user story is a contract between PM and the team. Sloppy contracts produce scope drift, QA ambiguity, and tasks that ship "technically done, actually broken."

## When this fires

- About to call `task_create({kind: "implementation", ...})` with a new feature
- Drafting a task description that's more than a sentence
- Decomposing an epic into child stories (pair with `pm-epic-breakdown`)

Not this skill when: bug fix with a clear repro (use `task_report_bug` flow directly), or cosmetic change ("fix typo on page X").

## The three-part form

### As a [user type], I want [capability], so that [outcome].

Each slot is load-bearing:

**User type** — who benefits? Not "user" (too vague). Be specific: "registered customer on the pro tier," "anonymous visitor," "admin user," "internal support rep."

**Capability** — what action? Concrete verb, not a feature name. "Reset my password via email link" not "password reset feature."

**Outcome** — why this matters? The business or user value. This slot prevents building the wrong thing for the right reason.

### Example

- Bad: "As a user, I want a better dashboard, so that it's easier."
- Good: "As a pro-tier customer, I want to see total revenue by month on my dashboard, so that I can track whether my team is hitting quarterly targets without leaving the app."

## Acceptance criteria

Every story has 2-5 acceptance criteria. **Each criterion is a single testable sentence.**

Format:

> **AC1:** Given [context], when [action], then [expected result].

Or simpler:

> **AC1:** The dashboard shows a "Monthly Revenue" chart with data for the last 12 months.

Rules:

1. **Testable.** QA reads AC, can pass/fail without asking you.
2. **Single.** One outcome per AC. Split "shows chart + exports CSV" into two.
3. **Concrete.** Numbers, not adjectives. "Loads in < 2s" not "loads fast."
4. **Negative cases too.** "When data is empty, shows empty-state illustration" — not just happy path.

## The loop

```
1. Draft the three-part form
2. Check each slot:
   - Is the user specific? (not just "user")
   - Is the capability a concrete action?
   - Does the outcome answer "so what?"
3. Write 2-5 acceptance criteria
4. Walk each AC: "Could QA pass/fail this without asking me?"
   - If no → rewrite until yes
5. Add context references: task_create({
     title, description, assignedRole: "dev",
     acceptance: "<joined ACs>",
     referenceArtifactIds: [<any supporting spec>]
   })
```

## Heuristics

- **One story, one outcome.** If the "so that" line has "and," split into two stories.
- **Write for a new hire.** Someone who joined yesterday reads the story — can they deliver it?
- **No UI detail unless critical.** "Export as CSV" is story-level; "use the Lucide download icon" is design-level.
- **Include the negative shape.** What DOESN'T happen? "Does not send email if user has opt-out flag set."
- **Link the UX spec if there is one.** `referenceArtifactIds: [<design artifact id>]` — don't re-describe.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| QA disputes "done" | AC was vague | Rewrite AC in Given/When/Then form; re-verify |
| Dev builds wrong thing | "User" was too vague | Name the user type specifically |
| Scope creeps during build | Multi-outcome story | Split into 2+ stories |
| Story delivered, nobody uses feature | Skipped "so that" — built right but wrong | Require outcome on every story |

## Anti-patterns

- **"As a user..."** — no. Name the user type.
- **"I want a new page"** — capability is too abstract. What do they DO on the new page?
- **Acceptance criteria = implementation details.** "Uses React Hook Form with Zod validation" — that's technical plan, not AC.
- **Story that's really 3 stories stapled together** — shows up as 10+ ACs. Split.
- **Skipping the "so that" because it's "obvious."** Write it anyway; it's cheap insurance.
