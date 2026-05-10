/**
 * Tiny per-key async serializer.
 *
 * `withKeyedLock(key, task)` ensures that for any given `key`, tasks run
 * one at a time. Multiple keys run independently. Used by:
 *   - git-ops.ts          → key = workspacePath; serializes git CLI calls
 *                           per workspace so concurrent beats don't race
 *                           on .git/index.lock or interleave commits.
 *   - preview.ts          → key = "local-preview"; serializes the
 *                           singleton preview lifecycle so two beats
 *                           calling workspace_start_preview don't clobber
 *                           previewState.
 *
 * Implementation: classic promise-chain queue. The `tails` map holds the
 * tail promise per key; `task` is appended via `.then(task, task)` so
 * a rejection on the previous task doesn't poison the queue (the next
 * task still runs). The cleanup `finally` removes the entry only when
 * we're still the tail — otherwise another waiter has already replaced
 * us, and we'd erase a live queue.
 *
 * The function returns the task's own result/error so the caller can
 * await it normally; the queue plumbing is invisible.
 *
 * No external deps. No timers. No background work. Pure microtask
 * coordination.
 */

const tails = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // `.then(task, task)` runs task whether prev resolved or rejected so
  // a single failed task doesn't permanently break the queue for `key`.
  const next: Promise<T> = prev.then(task, task);

  // Track the new tail. Wrap in a `.finally` so the entry is cleared
  // when this task settles AND nothing has queued behind it. The
  // `tails.get(key) === wrapped` check is the gate that prevents
  // erasing a queue that has gained new waiters since we attached.
  const wrapped: Promise<unknown> = next.finally(() => {
    if (tails.get(key) === wrapped) tails.delete(key);
  }).catch(() => {
    // silent: the caller awaits `next` and gets the real rejection.
    // This catch only neutralizes the tracker promise so a rejected
    // task doesn't fan out as unhandledRejection on the tail —
    // queue plumbing, not error suppression.
  });
  tails.set(key, wrapped);

  return next;
}

/** Test-only: how many distinct keys currently have an outstanding queue. */
export function keyedLockSize(): number {
  return tails.size;
}
