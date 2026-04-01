# `ui/src/api/assets.ts`

Why it matters:

- Agent detail can surface files or binary assets related to runs and outputs.

What to focus on:

- asset URL/download/read helpers
- how non-JSON content is exposed differently from normal API records

Connections:

- often used for run outputs, previews, or attachments in detail screens
- pairs with backend asset/document storage concerns

Self-check:

- Why is asset access separate from main entity APIs?
- What kinds of UI features depend on this?
- Which backend systems likely create the assets the page later reads?

