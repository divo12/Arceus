# Phase 3: Trace One Feature End-to-End

Goal: follow one real feature from UI to API to service to storage.

Best first feature: agents.

Read in this order:

1. [app-tsx.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/app-tsx.md)
2. [agents-page-tsx.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/agents-page-tsx.md)
3. [agent-detail-page-tsx.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/agent-detail-page-tsx.md)
4. [api-agents-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-agents-ts.md)
5. [api-heartbeats-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-heartbeats-ts.md)
6. [api-company-skills-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-company-skills-ts.md)
7. [api-budgets-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-budgets-ts.md)
8. [api-instance-settings-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-instance-settings-ts.md)
9. [api-activity-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-activity-ts.md)
10. [api-issues-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-issues-ts.md)
11. [api-assets-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/api-assets-ts.md)
12. [routes-agents-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/02-backend-shape/routes-agents-ts.md)
13. [services-agents-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/02-backend-shape/services-agents-ts.md)
14. [shared-index-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/shared-index-ts.md)
15. [db-schema-index-ts.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/db-schema-index-ts.md)
16. [exercise-agent-list-trace.md](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH/03-feature-trace-agents/exercise-agent-list-trace.md)

What this phase should teach you:

- frontend routes map to pages
- pages use API wrappers, not raw fetch
- API wrappers mirror backend route shape
- backend routes delegate most real logic to services
- shared contracts keep UI and server synchronized
- schema exports show what persistent entities exist

