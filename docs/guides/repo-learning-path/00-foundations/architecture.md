# `doc/Architecture.md`

## Mental Model

This file is the high-level topology map.

It tells you how UI, API, services, persistence, adapters, and Hippocampus are expected to relate.

## What This File Owns

- the layer diagram of the system
- major subsystem boundaries
- the distinction between control plane and execution/runtime subsystems

## How To Read It

Read it while sketching arrows.

You want to come away with a rough graph like:

`UI -> API routes -> services -> DB / adapters / Hippocampus runtime`

Then later phases simply make each arrow concrete.

## Technical Thinking

The important thing here is boundary clarity.

Paperclip’s TypeScript server owns:

- product logic
- auth and company boundaries
- orchestration
- persistence
- route surface

Adapters own how specific agent runtimes are invoked.

Hippocampus owns memory-specific runtime behavior.

That separation shows up everywhere later:

- in `server/src/index.ts`
- in `server/src/services/heartbeat.ts`
- in `server/src/services/hippocampus-bridge.ts`

## Self-Check

- Where does the control plane end and runtime-specific execution begin?
- Where does memory fit relative to the core request path?
