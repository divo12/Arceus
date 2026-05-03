/**
 * Re-export shim — gates moved to @arceus/runtime-shared in
 * Spec 34 v3 PR 14. Existing imports (`../infra/gates.js`) keep working.
 */
export { TryRunGate, OncePromise } from "@arceus/runtime-shared";
