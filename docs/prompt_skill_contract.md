# Prompt vs Skill Contract

## Core Distinction

- Skill: what the agent can *do* (capability + procedure).
- Prompt: what the agent can *refer to* (framing + structure + question scaffolding).

## Why This Exists

Prompts are often lost across chats. Converting useful prompts into file-backed references preserves the best instruction quality while keeping execution logic in skills.

## System Behavior

1. Skills remain the execution source of truth.
2. Prompts are loaded as references and included separately in context.
3. Prompt references are filtered when redundant with selected skills.
4. Prompts should only be included when they add net-new value, such as:
   - better clarifying questions,
   - stronger output structure/templates,
   - stakeholder communication framing,
   - domain wording not present in skills.

## Runtime Integration Notes

- Prompt references are selected during planning, but execution decisions rely on skills/tools.
- Web-evidence policy and loop iteration controls are policy-level behaviors, not prompt behaviors.
- Skill-gap drafting creates draft `SKILL.md` files for human review; prompts are never used as capability replacements.

## Anti-Redundancy Rule

If a selected prompt fully overlaps with currently selected skills, skip that prompt and rely on skill instructions.

## Practical Example

- `problem-statement` skill selected + `framing-the-problem-statement` prompt available:
  - use skill for execution;
  - include prompt only if it contributes additional framing not already covered.
