# `server/src/board-claim.ts`

This guide explains [`server/src/board-claim.ts`](/Users/divyansh/Arceus/server/src/board-claim.ts) as a narrow but very important bootstrap safety file.

If you want one sentence first:

`board-claim.ts` is the one-time ownership handoff mechanism that lets an authenticated human safely replace the temporary `local-board` bootstrap admin.

## 1. Why This File Exists

Paperclip has two different startup realities:

1. very convenient local bootstrap flows
2. authenticated long-lived deployments

In local trusted development, it is acceptable to have an implicit board operator identity.

In an authenticated deployment, leaving that implicit bootstrap admin in charge would be unsafe and confusing.

So the system needs a bridge:

- convenient enough for initial setup
- strict enough to transfer ownership to a real user

That bridge is this file.

## 2. The Core Problem It Solves

The file is solving a very specific transition:

`local-board` is currently the only instance admin  
and now a real signed-in user needs to become the owner.

That is not normal CRUD.

It is instance bootstrap lifecycle logic.

That is why the file is small but high leverage.

## 3. The Whole File Is A Tiny State Machine

Read it as four phases:

1. create a challenge
2. inspect the challenge
3. claim the challenge
4. mark the challenge consumed

That mental model will make the file much easier to understand.

## 4. Constants At The Top

The file starts with:

```ts
const LOCAL_BOARD_USER_ID = "local-board";
const CLAIM_TTL_MS = 1000 * 60 * 60 * 24;
```

These two constants explain most of the design.

### `LOCAL_BOARD_USER_ID`

This is the bootstrap principal the rest of the flow is trying to replace.

### `CLAIM_TTL_MS`

The claim challenge only lives for 24 hours.

That matters because bootstrap claim URLs should not stay valid forever.

This is a one-time, time-bounded transition mechanism.

## 5. The In-Memory Challenge Model

The file defines:

```ts
type ClaimChallenge = {
  token: string;
  code: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
};

let activeChallenge: ClaimChallenge | null = null;
```

### Why both `token` and `code`?

Using both gives the challenge a little more structure than a single identifier.

The token identifies the claim link.

The code acts like an extra secret attached to the URL.

### Why keep it in memory?

Because this is not a long-term product entity.

It is a short-lived bootstrap control.

That choice implies something important:

- if the process restarts, the active challenge may need to be recreated
- this flow is intentionally lightweight and startup-driven

## 6. `createChallenge(...)`

This function creates:

- a random token
- a random code
- timestamps for creation and expiry
- unclaimed state

The important point is not the random-bytes implementation.

The important point is that the file models claimability explicitly through timestamps and claimed fields.

That makes later checks easy and clear.

## 7. `getChallengeStatus(...)`

This function is the gatekeeper for the state machine.

It checks:

- no active challenge
- wrong token
- wrong code
- already claimed
- expired
- otherwise available

### Why this function is central

Because almost every other public function depends on it.

It is the single source of truth for:

- whether a challenge exists
- whether it matches
- whether it is still usable

This is the main "state machine evaluator" for the file.

## 8. `initializeBoardClaimChallenge(...)`

This is the startup-facing entrypoint.

It is the function `index.ts` calls when authenticated mode is being prepared.

## 8.1 First guard: only authenticated mode

```ts
if (opts.deploymentMode !== "authenticated") {
  activeChallenge = null;
  return;
}
```

That means this flow is intentionally disabled outside authenticated deployments.

Why?

Because in local trusted mode, the implicit local board identity is not the same kind of problem.

Board claim is about ownership handoff in authenticated environments.

## 8.2 Second guard: only if `local-board` is the sole admin

This section queries instance admins and checks:

```ts
const onlyLocalBoardAdmin = admins.length === 1 && admins[0]?.userId === LOCAL_BOARD_USER_ID;
```

That condition is the core trigger for the whole feature.

If there is already:

- no admin problem of this specific kind
- or a real human admin already present

then board claim is unnecessary and the active challenge is cleared.

## 8.3 Challenge regeneration rules

If the deployment needs a claim challenge, the function creates one when:

- none exists
- the old one expired
- the old one was already claimed

This keeps the flow one-time and renewable without creating many parallel active challenges.

## 9. `getBoardClaimWarningUrl(...)`

This function turns the active challenge into a human-usable URL.

It also refuses to return a URL if the challenge:

- does not exist
- is already claimed
- is expired

### Why this matters

This is the function that powers the startup warning shown by `index.ts`.

So it is the bridge from internal bootstrap state to operator-visible action.

### `0.0.0.0` normalization

Just like the startup banner, it rewrites `0.0.0.0` to `localhost` for human-facing display.

That is another small operator UX improvement.

## 10. `inspectBoardClaimChallenge(...)`

This function is the "read-only status view" of the challenge.

It returns:

- status
- `requiresSignIn: true`
- expiration time
- claimed-by user if already claimed

### Why `requiresSignIn: true`?

Because the URL alone is not sufficient.

The system is intentionally saying:

"Even if you have the claim link, a real signed-in user must complete the handoff."

That is one of the most important safety properties in the whole flow.

## 11. `claimBoardOwnership(...)`

This is the mutation that performs the handoff.

Read it as a controlled ownership transfer, not as a generic update.

## 11.1 First gate: challenge must be available

It immediately checks:

```ts
const status = getChallengeStatus(...)
if (status !== "available") return { status };
```

So the mutation does not proceed unless the challenge is valid right now.

## 11.2 Transactional ownership transfer

Then the function performs a DB transaction.

That is important because several related changes need to succeed together.

Inside the transaction it:

1. ensures the target user has `instance_admin`
2. removes `instance_admin` from `local-board`
3. loads all companies
4. ensures the target user has active owner membership in every company

This is not just role flipping.

It is a full control-plane ownership handoff across:

- instance scope
- company scope

## 11.3 Company membership updates

The company loop is especially important.

If the real user does not already have membership, it inserts one.

If membership exists but is inactive, it reactivates it and upgrades the role to owner.

That means the new owner is not only an instance admin in theory.

They also become operationally able to control every company.

## 11.4 Mark the challenge claimed

After the transaction succeeds, the in-memory challenge is updated:

- `claimedAt`
- `claimedByUserId`

That ensures the challenge cannot be reused.

## 12. The Most Important Design Lesson

This file is about reducing bootstrap risk.

It ensures that:

- local convenience does not silently become long-term ownership
- claim links expire
- claim URLs are one-time
- a real signed-in user must finish the handoff
- ownership transfer touches both instance and company scope

That is a lot of security/governance value in a small file.

## 13. What To Remember

- board claim only exists in authenticated mode
- it only matters when `local-board` is still the sole admin
- the challenge is in-memory, short-lived, and one-time
- the claim mutation is transactional because multiple scopes must move together
- the end goal is replacing bootstrap ownership with real human ownership

## Self-Check

- Why is board claim unnecessary when a real instance admin already exists?
- Why does the ownership handoff have to touch company memberships as well as instance roles?
- What makes this file a bootstrap governance mechanism instead of normal application CRUD?
