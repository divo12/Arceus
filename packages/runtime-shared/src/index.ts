/**
 * @arceus/runtime-shared — minimal cross-package runtime helpers.
 * Spec 34 v3 PR 14.
 *
 * Hosts utilities that need to be reachable from multiple runtime
 * packages without forcing a circular dep through @arceus/contracts:
 *
 *   ./swallow.ts  swallowAndAudit fire-and-forget wrapper
 *   ./gates.ts    TryRunGate + OncePromise concurrency primitives
 */
export { swallowAndAudit } from "./swallow.js";
export { TryRunGate, OncePromise } from "./gates.js";
