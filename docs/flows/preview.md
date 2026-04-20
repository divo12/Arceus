# Preview Lifecycle

The preview system provides a live deployment of the product being built.

## Overview

Agents write code into a workspace directory. The preview system builds and serves this code so the board can see the product evolving in real time.

## Flow

### 1. Workspace Initialization
- `initWorkspace()` in `apps/api/src/workspace/manager.ts`
- Creates the workspace directory structure
- Installs dependencies (`npm install`)
- Writes base configuration files

### 2. Code Generation
- Developer agent writes files via OpenCode sessions
- Files land in the `workspace/` directory
- Each file write emits a `workspace:file-changed` event

### 3. Build & Serve
- `startPreview()` in `apps/api/src/workspace/preview.ts`
- Runs `npm run dev` (or `npm run build && npm run preview`) in the workspace
- Captures stdout/stderr for dashboard display
- Proxies the dev server port to the API's `/preview` route

### 4. Hot Reload
- File changes trigger Vite HMR (if using Vite)
- Build errors are captured and fed back to the developer agent as context
- Agent can self-correct based on build output

### 5. Board Review
- Board accesses the preview via the dashboard
- Can approve the current state or request changes
- Feedback flows back as task rework items

## Preview States

```
idle → building → running → error
                     ↓
                  stopped
```
