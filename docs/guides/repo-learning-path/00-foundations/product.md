# `doc/PRODUCT.md`

## Mental Model

This is the product vocabulary file.

It gives names and meaning to the things the code manipulates later.

## What This File Owns

- domain nouns like company, agent, issue, goal, heartbeat, routine
- product behaviors around delegation, execution, and visibility
- the board-versus-agent operating model

## How To Read It

Read it while building a noun map.

For every important concept, write:

- what it is
- who can act on it
- what state it moves through
- which later folders probably implement it

## Technical Thinking

This document is the bridge between “business language” and “schema and routes.”

A good repo-reading pattern is:

1. find a noun here
2. find it in `packages/shared`
3. find it in `packages/db`
4. find the route/service pair that manipulates it

That is how you stop reading isolated files and start reading a system.

## Self-Check

- Can you explain the difference between an agent, a role, and a hierarchy edge?
- Can you explain the difference between an issue, a goal, and a heartbeat run?
