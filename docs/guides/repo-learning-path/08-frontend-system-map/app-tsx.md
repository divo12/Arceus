# `ui/src/App.tsx` In Frontend Map

This guide explains [`ui/src/App.tsx`](/Users/divyansh/Arceus/ui/src/App.tsx) as the frontend routing and gating hub.

If you want one sentence first:

`App.tsx` decides which product areas exist, who is allowed to see them, and how the app moves the user into the correct company-scoped route.

---

## 1. Mental Model

Treat `App.tsx` as three things at once:

1. the product sitemap
2. the route guard
3. the URL normalizer

It is not a page.

It is the file that answers:

- what screens exist?
- what URL shape does the app want?
- what has to be true before we let the user into the board?

If the backend `server/src/index.ts` opens the server process, `ui/src/App.tsx` opens the frontend world.

---

## 2. What This File Owns

`App.tsx` owns:

- top-level route definitions
- authenticated/bootstrap gating through `CloudAccessGate`
- root redirect behavior
- company-prefixed route normalization
- special global routes like auth, invite, and board claim
- the handoff into the shared `Layout`

It does **not** own:

- page-specific data loading
- sidebar behavior
- company selection logic itself
- most domain UI details

Those are delegated to layout, context, pages, and components.

---

## 3. The First Big Clue: Product Surface Area

The imports near the top tell you which domains are first-class:

- dashboard
- companies
- agents
- projects
- issues
- routines
- goals
- approvals
- costs
- activity
- inbox
- org and hierarchy
- memory
- meetings
- orchestration
- plugins
- instance settings

That alone is useful.

If a domain has its own route and page file here, the product team believes operators need to navigate to it directly.

So this file is a very good answer to:

"What are the main nouns in Paperclip?"

---

## 4. `CloudAccessGate`: The Front Door

One of the most important sections is `CloudAccessGate()`.

This component runs before most app routes render.

### What it checks

It queries:

- health / deployment state
- auth session, when the deployment is in authenticated mode

### Why that matters

The app can run in different deployment modes.

That means the UI cannot assume:

- auth is always required
- auth is never required
- bootstrap is already complete

So the route layer needs to branch based on instance state.

### What this gate can do

It can:

- show loading state while bootstrap/session checks are pending
- show an error if app state cannot be loaded
- show the bootstrap-required screen if no admin exists yet
- redirect to `/auth` if authenticated mode is enabled but the user is not signed in
- allow the route tree to continue if everything is ready

This is an important lesson:

the UI is not just "page navigation."

It is also part of operational startup flow.

---

## 5. Bootstrap and First-Run UX

The `BootstrapPendingPage` exists for a very specific system problem:

what should the UI do if the server is up, but the instance is not fully bootstrapped?

Instead of failing mysteriously, the app shows a clear operator action:

- there is no instance admin yet
- here is the command to bootstrap one

That is a product decision.

Paperclip does not treat setup as an invisible backend-only concern.

It surfaces setup state in the UI.

---

## 6. `boardRoutes()`: The Board-Facing Product Map

`boardRoutes()` is the main route bundle for board/operator screens.

This function is useful because it groups the "normal working app" routes together.

### What you learn from the route list

You can learn which concepts the operator is expected to move between frequently:

- dashboard
- onboarding
- company settings/import/export
- skills
- plugins
- org / roles / hierarchy proposals
- memory
- meetings
- orchestration
- agents and agent detail tabs
- projects and project detail subsections
- issues and issue detail
- routines and routine detail
- goals and goal detail
- approvals
- costs
- activity
- inbox

This is not random.

It means Paperclip sees itself as:

- an organization tool
- an execution tool
- a governance tool
- a planning tool
- a memory/orchestration tool

all at once

---

## 7. Company-Prefixed Routing Is A Big Deal

One of the most important frontend patterns in this repo is:

```text
/:companyPrefix/...
```

This means the app wants company scope to be visible in the URL.

### Why that is useful

It helps:

- make scope explicit
- keep links shareable
- avoid "which company am I in?" ambiguity
- keep frontend navigation aligned with backend company scoping

### Where you can see it

The main board route branch is:

```text
/:companyPrefix
```

and then `Layout` wraps the board routes under that scope.

This tells you that company selection is not an afterthought.

It is part of the route design itself.

---

## 8. Redirect Helpers: Making URLs Canonical

Three helpers matter a lot here:

### `CompanyRootRedirect()`

This decides what `/` should do.

It:

- waits for company loading
- chooses selected company or first company
- redirects to that company's dashboard
- or sends the user to onboarding / no-company start state if needed

So `/` is not a real content page.

It is a routing decision point.

### `UnprefixedBoardRedirect()`

This handles routes like `/agents` or `/issues` when the app wants the canonical form to include company prefix.

It:

- looks up the selected or first company
- preserves the rest of the path
- redirects from generic route to company-scoped route

Example mental model:

```text
/agents  ->  /ABC/agents
```

This is a subtle but important product pattern:

the UI is forgiving when the user lands on a generic route, but it still normalizes into the scoped route shape it wants.

### `NoCompaniesStartPage()`

This is the "there is no company yet" UX.

Instead of leaving the app empty, it gives the user a clear next action: start onboarding.

---

## 9. How `App()` Is Structured

The `App()` component itself has a very clear shape:

1. special public-ish routes
2. guarded app routes inside `CloudAccessGate`
3. nested `Layout` routes for instance settings and board screens
4. fallback not-found routes
5. globally mounted `OnboardingWizard`

### Special routes

These include:

- `/auth`
- `/board-claim/:token`
- `/invite/:token`

These routes are important because they do **not** belong inside normal company-scoped navigation.

They are instance/auth flows.

### Guarded routes

Everything important runs inside `CloudAccessGate`.

That ensures the board UI is only reachable when instance/bootstrap/auth conditions are satisfied.

### Nested layout routes

There are two major layout-wrapped branches:

- `/instance/settings/...`
- `/:companyPrefix/...`

That shows there are really two board shells:

- instance-level administration
- company-scoped operational work

### `OnboardingWizard`

This is mounted outside the route tree but still inside the app.

That means onboarding is treated as a global interaction surface, not just a single page.

---

## 10. The Difference Between Instance Routes And Company Routes

This is one of the easiest things to miss.

The app has two big kinds of route scope:

### Instance scope

Examples:

- `/instance/settings/general`
- `/instance/settings/plugins`

These are about the whole Paperclip installation.

### Company scope

Examples:

- `/:companyPrefix/dashboard`
- `/:companyPrefix/agents`
- `/:companyPrefix/issues`

These are about work inside one company.

This matters because it mirrors backend reality:

- some state is instance-wide
- much of the domain data is company-scoped

The UI route tree makes that distinction visible.

---

## 11. What This File Reveals About The Backend

Even though this is a frontend file, it tells you a lot about backend structure.

### It reveals company scoping is fundamental

Because most board routes are company-prefixed.

### It reveals auth/bootstrap are deployment-mode sensitive

Because the route gate queries health and session state before rendering.

### It reveals plugins are becoming first-class

Because plugin manager and plugin settings are normal routed pages.

### It reveals governance is product-level

Because routes exist for:

- roles
- hierarchy proposals
- approvals

This is not hidden admin plumbing.

---

## 12. What This File Does Not Try To Solve

It is important not to over-assign responsibility to `App.tsx`.

This file does **not**:

- fetch agent lists
- load issue details
- render org charts
- manage company list state
- implement memory UI

It only decides where those concerns should live.

That is a healthy architecture signal.

`App.tsx` is a coordinator, not a kitchen sink of page logic.

---

## 13. Common Beginner Misunderstandings

### Misunderstanding 1: "This is just a route table."

It is more than that.

It is also:

- an auth gate
- a bootstrap gate
- a URL normalization layer
- a company-scope enforcement layer

### Misunderstanding 2: "Company prefix is just cosmetic."

It is not.

It is how the UI keeps company scope explicit and canonical.

### Misunderstanding 3: "The UI starts at the dashboard."

Not necessarily.

The UI starts at a decision point:

- auth?
- bootstrap?
- company exists?
- selected company?
- canonical route?

### Misunderstanding 4: "Onboarding is just one page."

Not in this app.

It is a cross-cutting flow that can be mounted globally.

---

## 14. Self-Check

After reading [`ui/src/App.tsx`](/Users/divyansh/Arceus/ui/src/App.tsx), you should be able to answer:

1. why does the app redirect many unprefixed routes into `/:companyPrefix/...` routes?
2. what problem does `CloudAccessGate` solve?
3. why are instance settings separated from company routes?
4. why is `OnboardingWizard` mounted globally instead of being only a normal page?
5. what backend domains look most important just from the route list?

If you can answer those, you understand the real job of `App.tsx`.
