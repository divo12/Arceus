# `server/src/startup-banner.ts`

This guide explains `[server/src/startup-banner.ts](/Users/divyansh/Arceus/server/src/startup-banner.ts)` as the operator-facing summary of backend startup state.

If you want one sentence first:

`startup-banner.ts` turns resolved startup state into a compact human-readable status report printed at boot.

## 1. Why This File Exists

When the server starts, a human operator often wants immediate answers to questions like:

- which mode am I in?
- what URL should I open?
- which DB am I connected to?
- were migrations applied?
- is auth ready?
- are background systems on?

Those are not debugging details.

They are the first practical questions after boot.

This file exists to answer them quickly and consistently.

## 2. The Real Job Of A Startup Banner

It is tempting to think of a startup banner as decoration.

In this repo, it is not.

It is a tiny observability surface.

The fields it chooses to show reveal what Paperclip thinks operators need most:

- deployment/auth state
- API/UI URLs
- DB mode and migration state
- agent JWT readiness
- heartbeat scheduler state
- backup policy

That is a very control-plane-oriented list.

## 3. The File Structure

The file is small and clean. Read it in this order:

1. small type definitions
2. ANSI/color helpers
3. redaction and env-status helpers
4. `printStartupBanner(...)`

## 4. Type Definitions Show The Banner Inputs

The file defines:

- `UiMode`
- `ExternalPostgresInfo`
- `EmbeddedPostgresInfo`
- `StartupBannerOptions`

This is important because it tells you the banner is not reading random global state itself.

Instead, `index.ts` gathers the startup facts and passes them in explicitly.

That is good design because:

- formatting stays separate from startup orchestration
- the banner becomes deterministic
- the file is easier to test and reason about

## 5. ANSI Helpers

The `ansi`, `color(...)`, and `row(...)` helpers are simple formatting utilities.

They exist to make the banner readable:

- aligned labels
- color-coded emphasis
- compact rows

The interesting point is not the colors themselves.

The interesting point is that the banner wants to be scannable.

This is an operator UX file.

## 6. `redactConnectionString(...)`

This helper is one of the most important trust/safety details in the file.

It parses the DB URL and rewrites it so the password is hidden:

- user stays visible
- host stays visible
- path stays visible
- secret is redacted

That gives operators enough information to confirm:

- which DB target is in use
- which database name is selected

without leaking sensitive credentials into startup logs.

That is exactly the right tradeoff.

## 7. `resolveAgentJwtSecretStatus(...)`

This helper is more subtle than it first appears.

It checks three situations:

1. the secret is present in actual process env
2. the secret exists in the env file but was not loaded
3. the secret is missing entirely

### Why does that second case matter?

Because "found in env file but not loaded" is a very specific operator problem.

It means:

- the developer may think they configured the secret
- but the live process is not actually seeing it

That is much more helpful than a generic "missing secret" warning.

This helper is a good example of the banner being operationally thoughtful, not just pretty.

## 8. Main Function: `printStartupBanner(...)`

This is where the banner gets assembled.

Read it as a formatting pipeline.

It takes raw startup facts and derives display-friendly forms for each one.

## 8.1 Base URLs

This section computes:

- `baseUrl`
- `apiUrl`
- `uiUrl`

It also normalizes `0.0.0.0` to `localhost` for the displayed browser URL.

That is a nice operator-facing detail.

The process may bind broadly, but the human still wants a clickable/dev-friendly address.

## 8.2 Config and env paths

The banner resolves:

- config path
- env file path

This matters because startup is often a configuration debugging problem.

Surfacing the effective config locations reduces guesswork immediately.

## 8.3 Mode formatting

The file formats:

- DB mode
- UI mode
- listen port
- DB detail string
- heartbeat status
- backup status

Notice that it does not just print raw values.

It chooses meaningful operator language like:

- `embedded-postgres`
- `external-postgres`
- `vite-dev-middleware`
- `static-ui`
- `headless-api`

That is a small but important UX choice.

## 8.4 The ASCII art and row list

Then the final `lines` array is built.

This is the actual startup report.

Look carefully at the row order:

1. mode
2. deployment
3. auth
4. server/port
5. API URL
6. UI URL
7. database
8. migrations
9. agent JWT
10. heartbeat
11. DB backup
12. backup dir
13. config path

That order is meaningful.

It roughly moves from:

- high-level runtime identity
- to reachability
- to persistence
- to agent/runtime support
- to operational housekeeping

That is a smart sequence for a control-plane startup log.

## 9. Why This File Is More Important Than It Looks

This file is one of the fastest ways to understand what the backend considers "healthy startup."

If the banner did not show something, it is a clue that startup does not consider it first-tier operator information.

If the banner does show something, it is usually because missing or incorrect values there cause real operator confusion.

So this file is also a tiny window into product priorities.

## 10. What To Remember

- the banner is a formatter, not a startup decision-maker
- it receives already-resolved facts from `index.ts`
- it redacts secrets while preserving useful DB targeting info
- it treats JWT readiness and backup policy as operator-visible first-class facts
- it is a compact observability tool, not just console art

## Self-Check

- Why does the banner care whether the agent JWT secret is merely "in the env file" versus truly loaded?
- Why is connection-string redaction a better design than hiding the DB line entirely?
- What does the banner row order tell you about what startup considers most important?

