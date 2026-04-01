# `packages/db/src/schema/index.ts`

This guide explains [`packages/db/src/schema/index.ts`](/Users/divyansh/Arceus/packages/db/src/schema/index.ts) as the export registry for the database schema package.

If you want one sentence first:

`schema/index.ts` is the file that tells the rest of the backend which tables exist as part of the official persistence model.

## 1. Why This File Matters

At first glance, this file looks boring because it mostly re-exports table modules.

But it is still important for three reasons:

1. it is the public schema surface
2. it is a fast architecture map of what the system stores
3. forgetting to export a new table here is a classic persistence-layer integration mistake

So this file is not where storage logic lives.

It is where persistence discoverability lives.

## 2. How To Read It

Do not read it alphabetically.

Read it in domain clusters.

That immediately makes the backend data model feel much more coherent.

## 3. Company, auth, and access cluster

At the top you can spot foundational tenancy/access tables:

- `companies`
- auth tables
- `instanceSettings`
- `instanceUserRoles`
- `companyMemberships`
- `principalPermissionGrants`
- `invites`
- `joinRequests`

This tells you Paperclip’s persistence model starts with:

- company scoping
- human/instance access
- membership and permission control

That matches the product’s control-plane nature.

## 4. Agent and org cluster

Then you see:

- `agents`
- `roleDefinitions`
- `hierarchySnapshots`
- `hierarchyEdges`
- `agentConfigRevisions`
- `agentApiKeys`
- `agentRuntimeState`
- `agentTaskSessions`
- `agentWakeupRequests`

This is one of the most important clusters in the whole file.

It teaches you something subtle:

the “agent domain” is not one table.

It is a family of:

- core identity/config tables
- governance tables
- runtime continuity tables
- execution-trigger tables

That is one of the most useful architectural insights in the repo.

## 5. Project, issue, and execution cluster

The next group includes:

- `projects`
- `projectWorkspaces`
- `executionWorkspaces`
- `workspaceOperations`
- `workspaceRuntimeServices`
- `goals`
- `issues`
- `routines`
- `routineTriggers`
- `routineRuns`
- work-product and document tables

This cluster shows that project/task persistence is deeply connected to execution workspace infrastructure.

So the task model is not “just project management.”

It is also an execution control model.

## 6. Heartbeat, cost, and approval cluster

Then:

- `heartbeatRuns`
- `heartbeatRunEvents`
- `costEvents`
- `financeEvents`
- `approvals`
- `approvalComments`
- `activityLog`

This is the system ledger layer:

- what ran
- what happened during it
- what it cost
- what approvals/governance state existed
- what should be auditable later

This is where Paperclip’s control-plane identity becomes very visible.

## 7. Plugin and meeting cluster

Later exports include:

- plugin tables
- meeting tables
- chat messages

That shows the persistence model extends beyond core execution into extensibility and coordination surfaces.

## 8. Why This File Helps During Feature Work

When you are adding or changing a feature, this file helps you ask:

- is this a new core table or just a neighboring support table?
- which existing domain cluster should the new table conceptually live near?
- did I remember to export the table so the rest of the backend can use it?

It also helps when reading code because schema consumers often import tables from this index rather than individual files.

## 9. What This File Does Not Tell You

This file shows:

- what tables exist
- how the persistence model is partitioned conceptually

It does not show:

- column definitions
- indexes
- foreign key details
- invariants encoded by field design

For that, you open the concrete schema files next.

## 10. What To Remember

- this is the official export surface of the schema package
- grouped reading is much more useful than alphabetical reading
- the file reveals major persistence domain clusters quickly
- it is a high-signal architecture map even though it contains almost no logic

## Self-Check

- Which exports tell you that “agent runtime” is a bigger persistence story than the `agents` table alone?
- Which clusters show Paperclip is an execution control plane, not just a planning app?
- Why is forgetting to export a table here an easy integration bug?
