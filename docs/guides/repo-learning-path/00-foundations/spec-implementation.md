# `doc/SPEC-implementation.md`

## Mental Model

This is the build contract for V1.

If `PRODUCT.md` says what the product is, this file says what the current code is actually supposed to deliver.

## What This File Owns

- V1 scope boundaries
- required behaviors and invariants
- the difference between “must exist now” and “interesting future idea”

## How To Read It

Read it like a checklist of promises the repo is actively keeping.

As you read, ask:

- which routes or services enforce this?
- which schema or shared contracts support this?
- is this a current behavior or only long-horizon direction?

## Technical Thinking

This file is especially important for avoiding false conclusions while reading code.

Without it, you might treat unfinished or partial systems as bugs.

With it, you can separate:

- intentional V1 scope
- adjacent unfinished infrastructure
- later-phase ideas that should not control today’s reading

## Self-Check

- Which control-plane invariants are V1-critical?
- If you changed behavior in routes or services, which promises here would you need to re-check?
