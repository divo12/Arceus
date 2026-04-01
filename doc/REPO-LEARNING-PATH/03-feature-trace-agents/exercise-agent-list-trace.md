# Exercise: Trace `list agents`

Chosen action: list agents in the main Agents page.

## 1. UI trigger

The user opens `/agents/all`, `/agents/active`, `/agents/paused`, or `/agents/error`, which all render `Agents` from `ui/src/pages/Agents.tsx`.

The page calls:

- `useQuery({ queryFn: () => agentsApi.list(selectedCompanyId!) })`

## 2. Frontend API function

`ui/src/api/agents.ts`

- `list: (companyId: string) => api.get<Agent[]>(\`/companies/${companyId}/agents\`)`

This is the frontend-to-backend boundary.

## 3. Backend route

`server/src/routes/agents.ts`

- `router.get("/companies/:companyId/agents", async (req, res) => { ... })`

This route:

- checks company access
- calls the agent service
- redacts restricted fields if needed
- returns JSON

## 4. Service execution

`server/src/services/agents.ts`

- `list: async (companyId: string) => { ... }`

This service:

- queries the `agents` table
- hydrates spend data
- normalizes agent rows
- returns company-scoped agent records

## 5. Tables read

Primary:

- `packages/db/src/schema/agents.ts`

Supporting:

- spend hydration logic also consults cost/finance-related data, depending on service helpers

## 6. Why this is a good first trace

It is simple enough to follow but still shows the main repo pattern:

`Page -> API wrapper -> Route -> Service -> Schema/Table`

## 7. Questions to answer yourself

- Where is company scoping enforced?
- Where is display shape normalized?
- Where would you add a new field if the Agents list needed it?

