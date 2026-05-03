---
name: cto-acceptance-criteria-writing
description: How to write testable acceptance criteria a QA agent can mechanically verify.
role: cto
trigger: creating a task or authoring an acceptance_spec artifact
---

# Acceptance Criteria Writing

Acceptance criteria are the contract between CTO and QA. Bad criteria produce flaky verification and arguments about "done"; good criteria make verification mechanical.

## The test

> Could a tester who reads ONLY these criteria, with NO other context, decide pass/fail without judgment calls?

If no, rewrite.

## Shape

Each criterion is:

```
<preconditions> + <action> + <observable outcome>
```

**Concrete:**
- "When a user submits the login form with a valid email + password, the response redirects to `/dashboard` within 2 seconds."
- "When `GET /api/markets?status=active` is called, the response is 200 with a JSON array; every element has `status: "active"`."

**Vague (rewrite):**
- "Login works" — not testable
- "The API performs well" — unmeasurable
- "UI looks clean" — subjective

## Rules

### 1. One criterion, one check
Don't compound. "Login works and redirects and shows errors" should be three criteria.

### 2. Observable outcomes only
- HTTP status codes — observable
- Rendered DOM text — observable
- Log messages — observable
- "The code is maintainable" — not observable

### 3. Thresholds are numbers
- "Response within 2 seconds" not "quickly"
- "At most 3 DB queries" not "efficient"
- "Passes on Chrome 120+, Safari 17+" not "modern browsers"

### 4. Include negative paths
If the criterion says what passes, write another that says what fails. "Invalid credentials show an error; valid ones redirect."

### 5. No "should"
"The form should validate" → "The form rejects submission if email is empty" + "The form rejects submission if password is <8 chars".

## Anti-patterns

| Bad | Why | Better |
|---|---|---|
| "Works as expected" | Whose expectation? | Reference the spec artifact by id + pointer to specific section |
| "Tested" | Tests exist vs tests pass | "All tests in `auth.test.ts` pass" + "Coverage on login module ≥90%" |
| "No bugs" | Absence of known bugs ≠ known good | List positive behaviors that must hold |
| "Looks good" | Subjective | Screenshot comparison or specific element assertions |

## For UI tasks

Acceptance criteria need to cover:
- DOM structure ("a `<form>` with `action="/login"` exists")
- Interactivity ("clicking submit with valid inputs calls POST /api/login")
- State ("on 401 response, error text `"Invalid credentials"` renders within the form")
- Accessibility ("all form inputs have associated `<label>`")

Avoid visual-only criteria unless screenshot comparison infrastructure exists.

## For API tasks

- Request contract (method, path, headers, body shape)
- Response contract (status, body shape, headers)
- Happy path observable outcome
- One failure path per distinct error (validation, auth, not-found, conflict)
- Idempotency if mutating

## For feature tasks

Break into layers:
- Data layer: schema/migration criteria
- API layer: endpoint contract criteria
- UI layer: render + interaction criteria
- Integration: end-to-end flow criteria

Attach each layer to separate subtasks via `task_create` when feasible.

## Output — on a task

```typescript
task_create({
  title: "Wire up login form",
  description: "...",
  acceptance: [
    "Form renders at /login with email + password fields",
    "Valid credentials (test user: alice@test.com / pw123) redirect to /dashboard within 2s",
    "Invalid credentials show error 'Invalid email or password' within the form",
    "Empty email shows 'Email required' on blur",
    "Form is keyboard-accessible (tab moves through fields + submit)",
  ],
  ...
})
```

Every item in `acceptance` is a bullet that QA can mechanically test. No compounds, no vagueness, no "should".

## When not to use this skill

Acceptance criteria are for `implementation` / `acceptance_spec` tasks. They don't apply to:
- Research tasks ("investigate X") — use success criteria instead
- Design tasks ("produce a mockup") — artifact produced IS the criterion
- Meta tasks (planning, retros) — no acceptance needed
