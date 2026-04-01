# `server/src/startup-banner.ts`

Why it matters:

- This file shows what the system considers operationally important at boot.

Read focus:

- which runtime facts are displayed
- how deployment/auth/DB/backup state is summarized

Connections:

- `index.ts` calls this after successful listen.
- It is a good cheat sheet for important startup state.

Questions:

- What information would operators want immediately?
- Which startup concerns are important enough to print?
- What does the banner reveal about system priorities?

