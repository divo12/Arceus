# `ui/src/context/CompanyContext.tsx`

This guide explains [`ui/src/context/CompanyContext.tsx`](/Users/divyansh/Arceus/ui/src/context/CompanyContext.tsx) as the frontend company-scope backbone.

If you want one sentence first:

`CompanyContext.tsx` is the shared place where the UI learns which companies exist, which one is currently active, and how that selection should persist across the app.

---

## 1. Mental Model

Most Paperclip pages need a company ID.

If every page fetched companies, picked one, and remembered it on its own, the app would be messy and inconsistent.

So the app creates one global source of truth:

- load companies once
- store selected company once
- expose that selection everywhere

That is what this context does.

Kid version:

this file is the shared note that says, "right now we are working inside this company."

---

## 2. What This File Owns

It owns:

- loading the list of companies
- storing the currently selected company ID
- resolving the full selected company object
- remembering selection in local storage
- choosing a default selection when needed
- exposing a `createCompany` action
- exposing a `reloadCompanies` action
- tracking where the selection came from

It does **not** own:

- route synchronization rules
- page rendering
- company-specific domain data like issues or agents

Those are handled elsewhere.

---

## 3. Why This Context Exists

The backend is heavily company-scoped.

That means the frontend needs a reliable answer to:

"Which company are we looking at right now?"

Without that, pages like agents, issues, projects, org chart, and goals would all need to solve the same problem separately.

This context centralizes that problem.

That gives you:

- consistency
- less duplication
- easier page code
- fewer scope bugs

---

## 4. The Context Value

The context exposes a fairly small API:

- `companies`
- `selectedCompanyId`
- `selectedCompany`
- `selectionSource`
- `loading`
- `error`
- `setSelectedCompanyId(...)`
- `reloadCompanies()`
- `createCompany(...)`

This is useful because it tells you exactly what the rest of the app is allowed to depend on.

Notice what is **not** here:

- no issue data
- no agent data
- no route objects
- no shell state

This context is focused.

It only owns company selection and company list lifecycle.

---

## 5. Company Loading

The context uses React Query to load companies from `companiesApi.list()`.

That tells you:

- company list is fetched from backend, not hardcoded
- the list is cacheable shared app data
- pages do not need to refetch it independently

There is also an important auth-related behavior:

if the API returns `401`, the context turns that into an empty company list instead of exploding.

That is a practical UX choice.

It means the app can survive auth transitions more gracefully.

---

## 6. `selectedCompanyId` Lives In Two Places

This is one of the most important details.

The selected company lives in:

1. React state
2. local storage

### Why React state?

Because the current page tree needs live reactive access.

### Why local storage?

Because the app wants to remember your selection across reloads.

So the selection is both:

- immediate app state
- persisted user preference

That is a very common frontend pattern for global selection state.

---

## 7. Default Selection Logic

The auto-selection effect is doing an important job.

When company data loads, it decides whether the current/stored selection is still valid.

If not, it chooses a fallback company.

### Why this is needed

Selections can become invalid if:

- local storage points to a deleted or archived company
- this is the first app load and nothing is selected yet
- the company list changed

So the context protects against stale selection state.

This is subtle but very valuable.

It keeps the rest of the UI from having to deal with "selected company points nowhere."

---

## 8. Archived Companies And Sidebar Selection

The context computes `sidebarCompanies` by excluding archived companies when possible.

That means selection UX is not identical to raw company list data.

This is a useful distinction:

- backend may still return archived companies
- frontend may choose not to prioritize them for ordinary navigation

So this file is not just a dumb pass-through for API data.

It applies light product logic to make selection behavior sane.

---

## 9. `selectionSource` Is More Important Than It Looks

The context tracks where the current selection came from.

Examples include things like:

- bootstrap
- manual user choice
- route sync

Why does that matter?

Because not all selection changes should be treated the same.

Elsewhere in the app, route synchronization logic can use this source to decide whether the route should override current selection or not.

So `selectionSource` is a coordination aid.

It helps the shell avoid accidental selection thrashing.

This is a sign that the app has non-trivial navigation state, not just a single dropdown.

---

## 10. `setSelectedCompanyId(...)`

This setter does more than assign state.

It:

- updates React state
- updates the selection source
- persists to local storage

That means it is the canonical write path for changing company selection.

This is good design.

If pages changed state directly without going through one function, persistence and source tracking would drift out of sync.

---

## 11. `reloadCompanies()`

This function invalidates the companies query.

That means pages/components do not need to know the details of query invalidation.

They can just say:

"please reload companies."

This is a small but useful encapsulation pattern.

The context is not only exposing raw data.

It also exposes convenient lifecycle actions around that data.

---

## 12. `createCompany(...)`

This mutation is another important design choice.

Creating a company is not left as a page-specific concern.

The context provides a shared way to do it and handles the important after-effects:

- invalidate company list
- set newly created company as selected

That makes sense because company creation directly affects the global company-selection backbone.

This is a good example of why some mutations belong near shared state instead of inside an arbitrary page.

---

## 13. What Other Files Assume Because This Exists

Because `CompanyContext` exists, many other frontend files can safely assume:

- they can read `selectedCompanyId`
- they can use that ID to load company-scoped resources
- selection will survive reloads
- some sensible fallback company will exist if possible

This is why a lot of pages look simpler than they otherwise would.

They are standing on top of this context.

---

## 14. What This Reveals About The Backend

This file reveals several backend truths indirectly:

### Company scope is foundational

Because the frontend needs global infrastructure just to manage company context reliably.

### Many domains are company-scoped

Because one selection state is reused across many unrelated pages.

### Company creation is a high-level workflow

Because creating a company is important enough to update global app state immediately.

---

## 15. Common Beginner Misunderstandings

### Misunderstanding 1: "This is just a dropdown helper."

No.

It is the scope backbone for much of the app.

### Misunderstanding 2: "Pages know the company because the URL tells them."

Sometimes the route helps, but the shared selected company state still matters across navigation and non-route-specific logic.

### Misunderstanding 3: "Persisting to local storage is just convenience."

It is also part of making the operator experience stable and continuous.

### Misunderstanding 4: "Any page can create a company however it wants."

Technically it could call the API, but the context provides the safer shared flow because company creation changes global selection state.

---

## 16. Self-Check

After reading [`ui/src/context/CompanyContext.tsx`](/Users/divyansh/Arceus/ui/src/context/CompanyContext.tsx), you should be able to answer:

1. why is company selection global context instead of page-local state?
2. why does selected company live in both React state and local storage?
3. why does the context track `selectionSource`?
4. why does company creation belong here instead of only inside one page?
5. what problems would appear if this context did not exist?

If you can answer those, you understand why this is one of the most important frontend infrastructure files.
