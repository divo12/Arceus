import { AsyncLocalStorage } from "node:async_hooks";

interface SessionStore {
  sessionId: string;
}

export const sessionAls = new AsyncLocalStorage<SessionStore>();
