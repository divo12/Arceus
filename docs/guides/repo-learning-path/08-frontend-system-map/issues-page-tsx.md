# `ui/src/pages/Issues.tsx`

This guide explains [`ui/src/pages/Issues.tsx`](/Users/divyansh/Arceus/ui/src/pages/Issues.tsx) as a compact example of how Paperclip pages join planning data with execution data.

If you want one sentence first:

`Issues.tsx` looks small, but it quietly shows that Paperclip does not treat issues as isolated backlog items; it enriches them with assignee and live run context so operators can see planning and execution together.

---

## 1. Mental Model

This page is the main issue-list entrypoint for a company.

At first glance it may seem simple:

- load issues
- render list

But the page actually does more than that.

It also loads:

- agents
- live runs

and then passes enriched issue context into the shared `IssuesList` component.

So this file is a good example of a common Paperclip pattern:

small page file, meaningful data join.

---

## 2. What This File Owns

This page owns:

- company-scoped issue loading
- company-scoped agent loading
- live run loading for the company
- syncing search state with the URL
- setting breadcrumbs
- building issue link state for navigation continuity
- wiring update mutations into the shared list component

It does **not** own:

- the detailed issue row rendering
- the full issue detail page
- deep filter UI layout

Those are delegated to reusable components like `IssuesList`.

---

## 3. The Main Joined Data Sources

The page uses three important queries:

### Issues

The base planning records.

### Agents

Needed so the issue list can show assignee-related information in a richer way than raw IDs.

### Live runs

Used to detect which issues currently have active execution attached to them.

This is the key insight.

The page does not treat issue records as complete by themselves.

It adds runtime context.

---

## 4. `liveIssueIds`: A Small But Important Derived Structure

The page builds a `Set` of issue IDs touched by live runs.

This is a nice example of frontend-derived operator state.

The backend returns runs.
The page converts that into a fast lookup:

"is this issue currently live?"

That allows the issue list to communicate execution state without the issues endpoint itself needing to embed all of that information.

So the page is doing a clean join rather than asking one endpoint to become overly broad.

---

## 5. URL-Synced Search State

The search box behavior is more important than it first looks.

The page:

- reads initial search from query params
- debounces search changes
- writes search changes back into the browser URL

Why is that good?

Because it makes list state:

- shareable
- bookmarkable
- restorable on reload

This means the page treats search as navigation state, not just temporary input state.

That is a mature UI pattern.

---

## 6. `issueLinkState`: Navigation Continuity

The page creates `issueLinkState` so that when the user goes from list to detail, the app can remember where they came from.

This is subtle but valuable.

It makes "back to issues" flows feel more grounded and less disorienting.

Again, the page is doing more than just rendering data.

It is preserving operator context across navigation.

---

## 7. Why This Page Is Educational Even Though It Is Short

This file is a great learning file because it is small enough not to overwhelm you, but still reveals a core product truth:

issues in Paperclip sit at the boundary between planning and execution.

That is why the page asks for:

- issue records
- agent list
- live execution state

If issues were treated as plain backlog objects, only the first query would matter.

The extra queries tell you what the product cares about.

---

## 8. The Mutation Is Also A Clue

The page wires an `updateIssue` mutation and invalidates issue list queries afterward.

This tells you the list is not read-only.

Operators can update issues directly from the list surface.

But the file still keeps that mutation lightweight and delegates the row interaction details to `IssuesList`.

That is a good separation:

- page owns data plumbing
- list component owns interaction UI

---

## 9. Empty State Behavior

If there is no selected company, the page does not guess.

It shows an empty state asking the user to select a company.

This again reinforces a major repo truth:

company scope is not optional background context.

It is a real prerequisite for most domain pages.

---

## 10. What This Page Reveals About The Backend

This page reveals:

### Issues are company-scoped

Because nothing loads until a company is selected.

### Issues are linked to agents

Because agent data is part of the normal issue list experience.

### Issues are linked to execution

Because live run data is joined into the page.

That means issues are not just planning artifacts.

They are execution-linked work items.

---

## 11. Common Beginner Misunderstandings

### Misunderstanding 1: "This page is simple, so it is not important."

Actually it is a clean demonstration of how Paperclip joins data across subsystems.

### Misunderstanding 2: "Issues are only project-management objects."

This page proves they are also execution-aware objects.

### Misunderstanding 3: "Search state belongs only in component state."

This page intentionally syncs it to the URL because the search view matters as shareable navigation state.

---

## 12. Self-Check

After reading [`ui/src/pages/Issues.tsx`](/Users/divyansh/Arceus/ui/src/pages/Issues.tsx), you should be able to answer:

1. why does the issues page load agent data as well as issue data?
2. why does it load live runs?
3. what does `liveIssueIds` tell you about Paperclip's issue model?
4. why does the page write search state into the URL?
5. what is the page delegating to `IssuesList`?

If you can answer those, you understand the deeper value of this short page.
