# `server/src/services/index.ts`

## Mental Model

This file is the **catalog** of backend services.

It does not contain business logic itself.

Instead, it tells you:

`These are the major service modules the backend considers important.`

That is very useful when you are new.

## Why a file like this matters

At first glance, barrel files can look boring.

But this one is not just convenience.

It gives you a map of the whole backend.

If you read this file slowly, you can already see the system split into major areas:

- company and org
- agents and issues
- approvals and budgets
- heartbeat and runtime
- memory and workspace
- activity and live events

That is architecture information.

## What This File Owns

This file owns the **public export surface** for backend services.

That means other files can import from one place instead of remembering:

- which service is in which file
- what exact helper name each module exports

It gives the backend one cleaner import surface.

## How To Read It

Do not read it line by line asking “what does this exact function do?”

Instead, read it in groups.

### Group 1: business-domain services

These are the services that sound like core product nouns:

- `companyService`
- `agentService`
- `projectService`
- `issueService`
- `goalService`
- `meetingService`
- `chatService`

These are the files that usually hold domain logic.

### Group 2: governance and policy services

These tell you Paperclip is not a simple CRUD app:

- `approvalService`
- `budgetService`
- `accessService`
- `roleDefinitionService`
- `delegationGuardService`
- `spawnGovernanceService`
- `hierarchyService`

That means:

the backend cares deeply about permission, org structure, and control.

### Group 3: execution/runtime services

These reveal the agent-execution side:

- `heartbeatService`
- `executionWorkspaceService`
- `workspaceOperationService`
- `reconcilePersistedRuntimeServicesOnStartup`

This is the part that makes Paperclip feel like a runtime control plane.

### Group 4: memory/runtime-enrichment helpers

These are especially interesting:

- `buildMemoryContextForRun`
- `extractMemoriesFromRun`
- `recordDelegationEvent`

Notice these are exported right next to major services.

That means memory is treated as a real system capability, not a hidden optional afterthought.

### Group 5: observability/integration helpers

These are things like:

- `logActivity`
- `publishLiveEvent`
- `createStorageServiceFromConfig`

These are cross-cutting helpers that many parts of the backend need.

## What this file teaches about the repo

This file teaches a very important lesson:

Paperclip is not organized only by “pages” or “database tables.”

It is organized by **capabilities**.

Examples:

- agent management
- task execution
- org governance
- memory enrichment
- activity logging

That is why a service index is valuable.

## What this file does **not** do

It does not tell you the *details* of each service.

It tells you the *existence* and *importance* of each service.

So use it like a directory sign at a big building.

It tells you where the main departments are.

## Beginner-Friendly Summary

If the backend were a company, this file would be the organization chart of departments.

It tells you:

- there is an agents department
- there is an issues department
- there is a budgets department
- there is a heartbeat/runtime department
- there is a memory department

That is why it is more useful than it first appears.

## Self-Check

- Which names in this file feel like normal app-domain services?
- Which names show that this repo also manages agent execution?
- Which names show that governance is first-class?
- Why is it useful for the rest of the backend to import services from one file like this?

