---
name: local-web-app
description: Build self-contained web apps that preview locally without external dependencies.
role: developer
---

# Local Web App

## When to use
Use this skill for any task that produces a runnable web application in the workspace.

## Constraints
- Storage: Use SQLite (better-sqlite3) or JSON file storage. Never Postgres, Redis, or external databases.
- Port: Use port 3210 for the dev server. Never 3000, 4000, or 4096 (reserved by Arceus).
- Preview: The app must start with `npm install && npm run dev` and be reachable at http://localhost:3210.
- Dependencies: Only use npm packages. No Docker, no system services, no credentials required.
- Framework: Prefer Express or Fastify for backend, React or vanilla HTML for frontend.

## Project setup checklist
1. Initialize with `npm init -y`
2. Add a `dev` script in package.json that starts the server on port 3210
3. Add a `GET /` health route that returns a 200
4. Use TypeScript with tsx for dev mode: `"dev": "tsx watch src/index.ts"`

## Definition of done
- `npm install` succeeds without errors
- `npm run dev` starts the app on port 3210
- `curl http://localhost:3210/` returns 200
