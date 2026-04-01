# Repo Learning Path

This folder turns [`doc/REPO-LEARNING-PATH.md`](/Users/divyansh/Arceus/doc/REPO-LEARNING-PATH.md) into a repo study system that is closer to how an engineer actually learns a codebase.

The anchor idea is simple:

1. do not read this repo alphabetically
2. do not read it folder by folder
3. read it by execution flow and system responsibilities

If you follow this order, Paperclip stops looking like a large monorepo and starts looking like a set of connected layers:

`startup -> routes -> services -> adapters/runtime -> persistence -> UI`

## How To Use This Folder

Each guide is intentionally narrower than a full file commentary, but deeper than a summary.

Use each one like this:

1. read the mental model first
2. open the real file beside the guide
3. scan the sections or functions named in the guide
4. answer the self-check before moving on

The goal is not to memorize code.

The goal is to build a stable map of:

- what the file owns
- what it delegates away
- where it sits in the request or runtime flow
- which invariants it is protecting

## Read Order

1. [`00-foundations/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/00-foundations/README.md)
2. [`01-execution-start/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/01-execution-start/README.md)
3. [`02-backend-shape/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/02-backend-shape/README.md)
4. [`03-feature-trace-agents/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/README.md)
5. [`04-heartbeat-engine/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/README.md)
6. [`05-contracts-and-persistence/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/README.md)
7. [`06-memory-and-hippocampus/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/README.md)
8. [`07-governance-and-org/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/07-governance-and-org/README.md)
9. [`08-frontend-system-map/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/README.md)
10. [`09-schedule-and-milestones/README.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/09-schedule-and-milestones/README.md)

## What Each Phase Gives You

- `00-foundations`
  Product vocabulary and system framing, so code decisions stop feeling arbitrary.
- `01-execution-start`
  How the backend process boots, chooses config, prepares infra, and starts serving.
- `02-backend-shape`
  The route/service/middleware split that shapes most backend work.
- `03-feature-trace-agents`
  One concrete end-to-end feature path from UI to DB.
- `04-heartbeat-engine`
  The main execution loop that actually runs agent work.
- `05-contracts-and-persistence`
  How types, validators, and schema define cross-layer truth.
- `06-memory-and-hippocampus`
  Where memory fits, and where it does not.
- `07-governance-and-org`
  The “AI company” layer: roles, delegation, hierarchy, spawn rules.
- `08-frontend-system-map`
  How the UI helps you navigate and reinforce backend understanding.
- `09-schedule-and-milestones`
  A concrete way to pace learning without drowning in details.

## Suggested Habit

After every phase, pause and explain one real flow in your own words.

Examples:

- after phase 1: “how does the server boot?”
- after phase 3: “how does the agents page reach the database?”
- after phase 4: “what happens during one heartbeat run?”
- after phase 6: “when does memory actually affect a run?”

That is the fastest way to turn passive reading into working understanding.
