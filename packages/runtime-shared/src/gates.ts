/**
 * Concurrency gates — Audit C6 (module-level state TOCTOUs).
 * Spec 33 C6 / Spec 34 v3 PR 14.
 *
 * Node.js is single-threaded, but `await` is an interleave point. A
 * caller that does `if (!flag) { flag = true; await work(); flag = false; }`
 * has a window between the read and the write where another async
 * caller can park, resume, and read the same `false` — both then think
 * they're alone and run the work twice.
 *
 * The two helpers below collapse the read+write into a single function
 * call so there's no `await` between the two steps.
 */

/**
 * Mutex-with-skip. Use when "if running, skip" is the right behaviour:
 *
 *   const result = await ceoProposalGate.runExclusive(() => generateProposal());
 *   if (result === null) return; // someone else is already running it
 *
 * Atomically: checks the flag, claims it if free, runs the function,
 * releases on success OR failure (try/finally). Concurrent callers
 * during a run get `null` immediately.
 *
 * Returns `T | null` rather than throwing on contention so the caller
 * can decide between skip / queue / retry without a try/catch.
 */
export class TryRunGate {
  private inFlight = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      return await fn();
    } finally {
      this.inFlight = false;
    }
  }

  /** Read-only accessor for status pages / debug. Don't use for control flow — race-prone. */
  get isInFlight(): boolean {
    return this.inFlight;
  }
}

/**
 * Promise singleton with auto-clear on settle. Use when "make sure
 * this is running, dedupe concurrent starts" is the right behaviour:
 *
 *   eventBridgeOnce.run(() => startEventBridge());
 *
 * Semantics:
 *   - First call:           starts the work, stores the promise
 *   - Concurrent calls:     get the SAME promise (no double-start)
 *   - On settle (resolve / reject): promise is cleared, next call
 *     starts fresh
 *
 * Distinct from `TryRunGate`: that one returns `null` on contention;
 * this one returns the in-flight promise so all callers can `await`
 * the shared result if they care.
 */
export class OncePromise<T = void> {
  private current: Promise<T> | null = null;

  run(factory: () => Promise<T>): Promise<T> {
    if (this.current) return this.current;
    const promise = factory().finally(() => {
      // Only clear if WE'RE still the current promise. A re-entrant
      // factory that synchronously creates a new OncePromise.run()
      // could otherwise stomp on the next caller's promise.
      if (this.current === promise) this.current = null;
    });
    this.current = promise;
    return promise;
  }

  /** Read-only accessor for status pages / debug. */
  get isInFlight(): boolean {
    return this.current !== null;
  }
}
