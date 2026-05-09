---
name: dev-state-management-decision
description: Pick local state vs context vs zustand vs redux based on actual access pattern. Replaces "let's add Redux to be safe" reflex.
role: developer
trigger: deciding where to put state for a new feature; refactoring state because it "doesn't feel right"
---

# State Management Decision

Most state-management mistakes happen because someone reached for global state when local would have worked, or vice versa. Use this decision tree.

## Question 1: Who reads this state?

- **One component (and its children via props)** → `useState` in that component. Done. Don't even read further.
- **A small subtree of related components** → `useState` in the nearest common parent, pass via props. Prop drilling 1–2 levels deep is fine and often clearer than context.
- **A wide subtree (many descendants, drilled 3+ levels)** → context.
- **Many unrelated components across the tree** → external store (Zustand, Jotai).
- **Server-derived data that needs caching, dedup, refetching** → React Query / TanStack Query / SWR. Don't use general-purpose state for this.

## Question 2: How often does it change?

- **Rarely (theme, locale, current user)** → context is fine. Re-render cost is low because changes are rare.
- **Frequently (input value, mouse position, animation frame)** → never put it in context — every consumer re-renders on every change. Keep it local or use a store with selector subscriptions.

## Question 3: Is it server data or client data?

- **Server data** (anything fetched from an API, cached, possibly stale): use a server-state library. React Query handles caching, refetching, invalidation, optimistic updates, and dedup. Reinventing this in `useState` will break.
- **Client-only state** (UI mode, draft form input, modal open/closed): the question 1/2 answers apply.

## The decision matrix

| Scenario | Pick |
|---|---|
| Form input, modal open, hover state | `useState` (local) |
| Multi-step form draft shared across siblings | `useReducer` in nearest parent or single Zustand store |
| Auth user object, theme, locale | Context |
| Cart, filters, anything reused on many unrelated screens | Zustand (or Jotai) |
| API data: list, detail, mutations | React Query |
| Real-time WebSocket-driven state | Zustand store + subscription |
| Cross-tab synchronized state | Zustand + localStorage middleware |

## What you should almost never do

- Use Redux for a small app. The boilerplate cost rarely pays back. If you genuinely need it, you'll know.
- Wrap fetch calls in your own custom hook with manual loading/error/data state. React Query is one dependency and removes hundreds of lines.
- Lift state to App.tsx because "we might need it elsewhere." Lift it when a second component actually needs it.
- Put fast-changing state in context — every consumer re-renders, performance dies, you blame React.

## Migration triggers

Promote state up the hierarchy ONLY when:
- A second component genuinely needs it (not "might in the future").
- The prop chain has crossed 3 levels.
- The state is being duplicated in two places and going out of sync.

Do the smallest possible promotion. Don't refactor adjacent state along the way.

## Decision deliverable

When you write the implementation, leave a single comment at the state declaration:
```ts
// State: [local | parent-lifted | context | zustand-store | react-query]
// Reason: [one line — who reads, how often it changes, why this layer]
```

This makes the next developer's promotion decision trivial.

## Common mistakes

- Reaching for Zustand on day one for a single-screen prototype.
- Putting input field values in context — they change every keystroke and tank perf.
- Storing server data in Zustand and writing 50 lines of refetch logic that React Query handles in a hook.
- Using `useReducer` for trivially simple state because it "looks more professional."
