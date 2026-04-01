# `doc/GOAL.md`

## Mental Model

This file explains the thesis behind the repo.

It is not about implementation detail. It is about the bet Paperclip is making.

## What This File Owns

- the reason the product should exist
- the high-level problem statement
- the framing for “AI-agent companies” as an operating model

## How To Read It

Read it like a founder note, but annotate it like an engineer.

Ask:

- what core problem is the system trying to solve?
- what does the product assume about how humans and agents work together?
- which parts of the codebase exist only because this goal exists?

## Technical Thinking

The most important value of this file is not the wording itself.

It is that it tells you what kinds of complexity are intentional.

For example, if the goal were only “run an AI task,” then hierarchy, approvals, budgets, company scoping, activity logs, and role definitions would look like unnecessary weight.

But if the goal is “operate an AI company,” those become core control-plane primitives.

## Self-Check

- What problem is Paperclip solving that a plain coding-agent wrapper does not solve?
- Which later systems in the repo exist because of this goal?
