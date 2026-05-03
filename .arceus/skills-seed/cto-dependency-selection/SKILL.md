---
name: cto-dependency-selection
description: Evaluate library/framework picks on license, maintenance, bundle size, conflict, exit cost. Prevents first-result search decisions.
role: cto
trigger: about to add a new external dependency to a technical plan, or about to propose a library switch
---

# Dependency Selection

Adding a dependency is a 5-year commitment disguised as a 5-minute decision. This skill gates the commitment.

## When this fires

- About to author a `technical_plan` that introduces a new top-level dependency
- Dev asks "can we use X library?" and you need to decide
- Proposing a framework switch (Express → Fastify, etc.)
- Adding a paid service dependency (external API with cost)

Not this skill when: upgrading an existing dependency (different skill territory — changelog review), or a dev-only tool (linter, formatter) with no runtime footprint.

## The five checks

### 1. License

Check the license. Compatible with your project's license?

- MIT, Apache 2.0, BSD → safe for most projects
- GPL / AGPL → copyleft; only if your project is open-source with compatible license
- SSPL, BSL, Elastic License → restrictive; check terms carefully
- Custom / unclear → red flag; likely reject

Tool: `bash("npm view <pkg> license")` or check `package.json` / `LICENSE` file.

### 2. Maintenance activity

A dead library becomes your liability.

- Last commit within 6 months → active
- Last commit 6–18 months → check if feature-complete or abandoned
- Last commit > 18 months → red flag unless it's a very narrow utility

Indicators:
- Open issues count + response time (look for maintainer engagement)
- Release cadence (any releases in last year?)
- Commit frequency trend (decelerating = red)
- Bus factor (1 maintainer → fragile)

### 3. Bundle + runtime cost

For frontend: what does this add to bundle size? Use `bundlephobia.com` or equivalent.

- < 10 KB gzipped → fine
- 10–50 KB → justify it
- > 50 KB → red flag; likely a smaller alternative exists

For backend: runtime memory / startup-time impact. Dependencies that load at import time (not lazy) accumulate.

### 4. Conflict with existing deps

Check: does this duplicate functionality we already have? Does its peer-dep conflict with what's installed?

- Run `bash("npm ls <similar-existing-pkg>")` if suspicious
- Two HTTP clients / two date libraries / two form libraries = anti-pattern; pick one

### 5. Exit cost

If we need to remove this in 2 years, how hard is it?

- **Low exit cost**: imported in 1-3 files, used via a thin wrapper → easy swap
- **Medium**: imported in 10+ files, core APIs → refactor sprint
- **High**: shapes your architecture (e.g. React, PostgreSQL, AWS SDK) → near-permanent commitment

High exit cost is fine — but name it explicitly in the technical plan. Don't stumble into commitments.

## The decision

Run all 5 checks. Record findings in the technical plan artifact:

```
## Dependency: <name>@<version>

- License: <spdx> (✓ compatible with <project license>)
- Maintenance: active (last commit <date>, N contributors, monthly releases)
- Cost: <size> gzipped / <runtime footprint>
- Conflicts: none (or: replaces <existing lib>)
- Exit cost: medium — imported in ~5 files, wrap in `lib/<name>-client.ts`
- Rationale: <why this one over alternatives>
- Alternatives considered: <A>, <B> — rejected because <reason>
```

If any check fails and you still want the dep: document why and escalate via `approval_request({type: "architecture_change"})`.

## Heuristics

- **Boring dependencies > novel dependencies.** Something with 5 years of production use > something trending on HN this week.
- **The stdlib is a dependency.** Use built-ins where reasonable — no external dep is lower-cost than no external dep.
- **One dep per need.** Resist the urge to mix libraries that overlap.
- **Wrap external APIs behind your own interface.** Reduces exit cost from "rewrite everything" to "swap the wrapper."
- **Licenses change.** What's Apache 2.0 today could be BSL tomorrow (see Redis, Elastic). Pin major versions.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Dep added, then replaced 1 sprint later | Skipped conflict / alternatives check | Alternatives-considered list required in plan |
| Bundle bloat over time | No per-dep cost review | Check bundle diff on every PR that adds a dep |
| Abandoned dep blocks upgrade | Skipped maintenance check | Maintenance check is non-skippable |
| License issue discovered at fundraising | Skipped license check | Add `license-checker` to CI |

## Anti-patterns

- **"It has 10K GitHub stars so it's fine."** Stars are vanity metrics; check commits.
- **Adding a dep for one function you could write in 20 lines.** Write the function.
- **Using a dep's deep internals or undocumented APIs.** Breaks on next minor version.
- **Shipping a dep without a team member understanding how it works.** If the author disappears, someone on your team has to.
- **Adding a dep because it's "the standard way."** Sometimes the standard way is bloated; evaluate on merits.
