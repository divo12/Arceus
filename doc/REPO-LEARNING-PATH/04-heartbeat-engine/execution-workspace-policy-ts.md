# `server/src/services/execution-workspace-policy.ts`

Why it matters:

- This file translates project/issue workspace settings into concrete execution policy.

What to focus on:

- parsing project and issue workspace policy
- default-mode resolution
- adapter config shaping based on workspace mode

What this file teaches:

- workspace strategy is policy-driven
- issue-level overrides can narrow or replace project defaults
- adapter config is partly synthesized from higher-level execution policy

Self-check:

- What is the difference between project policy and issue settings?
- How does the file decide shared versus isolated workspace mode?
- Why is adapter config built here instead of in the page or route?

