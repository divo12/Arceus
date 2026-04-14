# Core Design Principles

This document is a living contract for Arceus.
It should keep expanding as architectural decisions harden.
New systems should align to these principles before new abstractions are introduced.

## 1. Policy-Driven Company Behavior

Policy must be explicit in code, not implied only through prompts or UI constraints.

This applies to:

- which roles exist,
- which roles can report to or orchestrate other roles,
- which powers each role has,
- which actions require board approval,
- which tools and runtime permissions are available to each agent.

Prompts may express policy, but prompts do not define policy.
The source of truth must live in typed runtime code and persisted state.

## 2. Control Plane Owns Truth

Arceus owns company truth.
OpenCode is an execution substrate, not the business source of truth.

Company state, hierarchy, tasks, meetings, approvals, memory summaries, and audit history must remain durable even if runtime sessions disconnect or fail.

## 3. Every Employee Is a Real Agent Identity

Persistent employees are not UI personas.
They are durable identities with:

- a role,
- a reporting line,
- a SOUL,
- runtime bindings,
- memory summaries,
- explicit authority boundaries.

The CEO is also an OpenCode agent.
The CEO is not a special hardcoded exception.
Its constraints, especially no-coding authority, must be encoded in policy and SOUL definitions.

## 4. Structured Outputs Over String Parsing

State-changing actions should come from typed structured outputs whenever possible.

This applies especially to:

- strategy proposals,
- hierarchy proposals,
- approvals,
- meeting records,
- task updates,
- memory summaries.

UI cards should render from typed objects, not fragile prompt text parsing.

## 5. Meetings Are the Canonical Coordination Surface

Inter-employee coordination should happen through meeting constructs, not invisible memory mutation or ad hoc cross-agent chat.

For MVP, this means structured meeting artifacts first.
Later implementations can deepen the meeting runtime, but they should not bypass the meeting model.

## 6. Board Governance Must Stay Visible

Any action that crosses a governance boundary must become a first-class approval or audit event.

At minimum this includes:

- CEO strategy approval,
- hiring approval,
- meeting-originated escalations that require board action.

## 7. Real Execution Over Demo Simulation

If the product claims something is happening, a real LLM call or a real process should back it.

Fallback behavior is acceptable.
Fake invisible simulation is not.

When capability is incomplete, the correct product behavior is to narrow scope, escalate, or block visibly.

## 8. Narrow Before Build

Broad startup ideas should be narrowed into a demoable first release before deeper execution begins.

The system should prefer a smaller real artifact over a larger unreliable promise.

## 9. Single-Company First, Multi-Company Ready

The MVP can optimize for one active company at a time, but schema and service boundaries should not make future multi-company support invasive.

## 10. Observability Without Cognitive Overload

The system should retain deep runtime traces while presenting a cleaner operating view to the board.

Raw trace fidelity is important for engineering.
Curated activity is important for trust and usability.

## 11. Use Shadcn As the Default UI Foundation

Arceus should use shadcn-style component architecture as the default UI foundation.

This means:

- reusable local UI primitives in the repository,
- composition over one-off page styling,
- minimal surfaces with the CEO chat as the primary operating interface,
- consistent components for cards, badges, buttons, forms, and system feedback.

## How To Extend This Document

Add new principles only when they materially affect architecture, orchestration, governance, or user trust.
Prefer concise durable rules over temporary implementation details.