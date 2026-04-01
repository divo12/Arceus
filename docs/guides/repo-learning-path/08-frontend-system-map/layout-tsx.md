# `ui/src/components/Layout.tsx`

This guide explains [`ui/src/components/Layout.tsx`](/Users/divyansh/Arceus/ui/src/components/Layout.tsx) as the shared board shell.

If you want one sentence first:

`Layout.tsx` is the app-wide frame that keeps navigation, company scope, global dialogs, and mobile/desktop shell behavior consistent while individual pages focus on their own domain data.

---

## 1. Mental Model

Treat `Layout.tsx` as the building around the rooms.

The page you are visiting is only one room.

`Layout.tsx` provides the things that exist no matter which room you enter:

- company rail
- sidebar
- breadcrumbs
- global dialogs
- command palette
- properties panel
- mobile shell
- onboarding hooks
- version/restart banners

That is why most board routes are nested inside this component.

---

## 2. What This File Owns

This file owns:

- shell composition
- sidebar open/close behavior
- company route and selected-company synchronization
- onboarding auto-open for empty local setups
- keyboard shortcut registration
- mobile-specific behavior and gestures
- top/bottom shell elements like breadcrumb bar and mobile nav
- mounting global dialogs and global UI chrome

This file does **not** own:

- domain-specific queries
- page-specific business logic
- CRUD behavior for agents/issues/projects

It is infrastructure for pages, not a domain page itself.

---

## 3. Why Layout Matters So Much In This Repo

In Paperclip, many concerns are not page-local:

- which company is active
- whether sidebar is open
- whether onboarding should appear
- whether the user is on an instance-level route
- keyboard shortcuts
- mobile shell visibility

If every page implemented these separately, the app would quickly become inconsistent and fragile.

So `Layout.tsx` acts as the place where app-wide operator experience is enforced.

This tells you something architectural:

the frontend has a real shell layer, not just a bunch of independent pages.

---

## 4. The Main Inputs It Depends On

This file pulls state from several contexts and hooks:

- `useSidebar()`
- `useDialog()`
- `usePanel()`
- `useCompany()`
- `useTheme()`
- route helpers like `useLocation`, `useNavigate`, `useParams`
- `healthApi` via React Query

That alone tells you this file is a coordinator.

It is not focused on one domain record.

It is stitching together app-wide state.

---

## 5. Company Route Synchronization Is A Core Responsibility

One of the most important things this file does is keep the selected company and the route company prefix aligned.

This is easy to miss, but it is central.

### What happens

The layout:

- reads `companyPrefix` from the route
- finds the matching company in the loaded company list
- detects when the route uses a non-canonical prefix form
- redirects to the canonical prefix form if needed
- updates selected company when route company should take precedence

### Why it matters

This prevents the app from drifting into inconsistent state like:

- URL says company A
- global selected company says company B

That would make page queries confusing and dangerous.

So this file is protecting a frontend invariant:

the route and the active company selection should agree.

This mirrors the backend invariant that most data is company-scoped.

---

## 6. Unknown Company Prefix Handling

The layout also checks whether a company prefix in the route does not match any known company.

If that happens, it renders a specialized not-found state instead of silently guessing.

That is a good design choice.

It means:

- bad URLs are handled explicitly
- users do not accidentally land in the wrong company
- scope mistakes stay visible

This is not just convenience.

It is scope safety.

---

## 7. Onboarding Is Wired Into The Shell

Another important section is the onboarding trigger logic.

If:

- companies have finished loading
- there are no companies
- deployment mode is not authenticated

the layout auto-opens onboarding.

This tells you two things:

### First

The shell understands first-run UX.

The app does not wait for some random page to notice there are zero companies.

### Second

The shell behaves differently based on deployment mode.

That means operator experience depends on instance mode, not only on route.

---

## 8. Keyboard Shortcuts Are Global, Not Page Local

`Layout.tsx` wires keyboard shortcuts through `useKeyboardShortcuts()`.

Those shortcuts include things like:

- new issue
- toggle sidebar
- toggle properties panel

This is a small but meaningful clue:

these actions are considered cross-app behaviors, not page-specific actions.

So the layout is also the right place for ergonomic, app-wide operator controls.

---

## 9. `useCompanyPageMemory()`: Remembering Navigation State

This hook name is easy to skim past, but it reflects a subtle product idea:

the app remembers where the user was inside company-scoped navigation.

That means the shell is helping continuity across navigation, not just rendering static chrome.

You do not need to know the hook internals yet to understand the design:

the shell is responsible for preserving useful context across page changes.

---

## 10. Desktop vs Mobile Is Not A Cosmetic Toggle

This file has substantial mobile/desktop branching.

That includes:

- sidebar behavior
- overlay behavior
- swipe gestures
- body overflow handling
- mobile nav visibility rules
- sticky breadcrumb behavior
- bottom navigation

This matters because the shell is not simply "responsive CSS."

It has real behavioral differences between mobile and desktop modes.

For example:

- mobile can swipe to open/close sidebar
- mobile shows an overlay when sidebar is open
- mobile bottom nav hides/shows based on scroll direction
- desktop keeps a more persistent multi-column shell

So this file owns interaction-level responsiveness, not just styling.

---

## 11. Why It Queries `healthApi`

At first glance, it may seem strange for layout to ask the backend for health information.

But it uses health information for shell behavior like:

- dev restart banner state
- version display
- some onboarding/deployment mode decisions

That means health is not only an ops endpoint.

It also feeds UX decisions about the shell.

---

## 12. Instance Settings Memory

The file remembers the last visited instance settings path using local storage.

That seems small, but it is another clue about shell responsibility.

The layout is trying to preserve operator continuity:

- if you go back to instance settings, it should remember where you left off

This is a shell concern because it spans multiple page visits.

It should not live inside one instance settings page component.

---

## 13. The Render Structure

At a high level, the render tree is:

```text
top-level shell wrapper
  skip link
  banners
  sidebar / company rail / instance sidebar
  main content area
    breadcrumb bar
    outlet for current page
    properties panel
  mobile bottom nav
  global dialogs and command palette
  toast viewport
```

This is a very typical app-shell pattern, but what matters is what the shell chooses to mount globally.

In Paperclip, those include:

- `CommandPalette`
- `NewIssueDialog`
- `NewProjectDialog`
- `NewGoalDialog`
- `NewAgentDialog`
- `ToastViewport`

That means creation flows are treated as global operator actions, not only as page-local buttons.

---

## 14. `Outlet` Is The Important Boundary

The `<Outlet />` is where current page content gets rendered.

That means everything around the outlet is layout-owned.

This gives you a useful reading rule:

If behavior is outside the outlet, it is likely shell behavior.
If behavior is inside the page rendered at the outlet, it is likely domain/page behavior.

That helps a lot when the frontend starts feeling large.

---

## 15. What This File Reveals About The Backend

Even though this file is frontend-only, it reveals a lot:

### Company scope is central

Because the shell spends real effort syncing route and company state.

### Deployment mode affects UX

Because onboarding and shell behavior look at health/deployment state.

### There is a clear instance-vs-company distinction

Because layout chooses between `InstanceSidebar` and normal `Sidebar` depending on route.

### The operator experience is rich and persistent

Because the shell mounts dialogs, panels, banners, command palette, and memory helpers globally.

---

## 16. Common Beginner Misunderstandings

### Misunderstanding 1: "Layout is just a sidebar component."

It is much more than that.

It is the stateful shell of the app.

### Misunderstanding 2: "Company selection is a page concern."

No. It is a shell concern because many pages depend on it and the route depends on it too.

### Misunderstanding 3: "Responsive UI means different CSS classes."

Not here.

There is real behavioral divergence for mobile and desktop.

### Misunderstanding 4: "Global dialogs can be mounted anywhere."

They work best here because this is the common shell all board pages share.

---

## 17. Self-Check

After reading [`ui/src/components/Layout.tsx`](/Users/divyansh/Arceus/ui/src/components/Layout.tsx), you should be able to answer:

1. why does the layout sync selected company with the route?
2. why are onboarding, command palette, and creation dialogs mounted here instead of inside one page?
3. what are the biggest behavioral differences between mobile and desktop shell?
4. why does the layout need health data?
5. what belongs to the shell versus what should stay in page files?

If you can answer those, you understand the real role of `Layout.tsx`.
