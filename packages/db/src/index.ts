// Spec 31 Phase 7 — canonical schema is the only source of truth.
// `./tables.ts` (legacy text-PK shapes) is re-exported until the
// remaining apps/api consumers migrate; once that lands it gets
// deleted along with the legacy public tables it declares.
export * from "./types";
export * from "./schema/index.js";
export * from "./tables";
export * from "./client";