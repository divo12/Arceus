/**
 * Store event bus — breaks the store.ts ↔ control-plane.ts circular dependency.
 *
 * store.ts emits events here; control-plane.ts subscribes.
 * Neither file imports the other directly.
 */
import { EventEmitter } from "node:events";

export const storeEvents = new EventEmitter();
