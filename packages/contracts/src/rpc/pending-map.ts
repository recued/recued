/** RPC correlation primitive — pending request map with timeout + reject-all lifecycle.
 *
 *  Every transport that correlates `request_id → response` over a
 *  stateful socket runs into the same bookkeeping:
 *    - register `{ resolve, reject, timeout }` keyed by request_id
 *    - on response: `clearTimeout + delete + resolve/reject`
 *    - on disconnect: reject every in-flight caller with a concrete
 *      error so nobody hangs forever waiting for a socket that's gone
 *    - on timeout: delete the entry + reject (caller sets up the timer)
 *
 *  Without a primitive, every callsite re-implements this in 4–6 lines
 *  and drifts: some forget `clearTimeout` on delete (memory leak), some
 *  forget to `reject` on clear (dangling promises), some don't scope
 *  the reason to the disconnect context (opaque errors). This module
 *  centralizes those invariants.
 *
 *  Callers extend `PendingEntry` with whatever domain fields they need
 *  (slug, input, claimed_by, serverId, …) — the primitive only cares
 *  about the resolve/reject/timeout triple.
 *
 *  Current consumers:
 *    backend/server/src/ws-server.ts — aiDelegations,
 *      chatDelegations, kernelRecipeDelegations, ingredientQueries,
 *      cacheGetRequests
 */

/** Minimum shape every correlation-map value must carry. Callers
 *  extend this with their own domain fields — the primitive only
 *  cares about the promise triple plus the timeout handle so it can
 *  clean up on delete/clear. */
export interface PendingEntry {
  // `any` on `value` because T differs per entry type (unknown, CacheEntry | null,
  // Array<{slug, manifest}>, etc.). Callers provide a concrete type via the
  // shape they pass to `createPendingMap<T>()`; the constraint here is a
  // structural minimum, not a precise signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PendingMap<T extends PendingEntry> {
  /** Register a pending entry keyed by request id. Caller is expected
   *  to have already set up the timeout via `setTimeout(...)` and
   *  passed the handle in as `timeout` — the primitive will clear it
   *  on delete or clear. */
  set(id: string, entry: T): void;
  /** Peek at the pending entry, e.g. to resolve it with a specific
   *  value or inspect domain-specific extras. */
  get(id: string): T | undefined;
  /** Remove the entry and clear its timeout. Returns true when the
   *  id was present. Callers typically `get` → `resolve/reject` →
   *  `delete` after handling a response. */
  delete(id: string): boolean;
  /** Reject every in-flight entry with `new Error(reason)` and clear
   *  every timeout. Used on transport disconnect so callers receive
   *  a concrete error instead of hanging until their own timeout. */
  clear(reason: string): void;
  /** Iterate current entries. Escape hatch for non-standard cleanup
   *  (e.g. resolve-with-null on shutdown for cache fetches where
   *  rejecting would misrepresent a graceful teardown as an error).
   *  Prefer `clear(reason)` for the common reject-all path. */
  values(): IterableIterator<T>;
  size(): number;
}

export const createPendingMap = <T extends PendingEntry>(): PendingMap<T> => {
  const pending = new Map<string, T>();
  return {
    set: (id, entry) => { pending.set(id, entry); },
    get: (id) => pending.get(id),
    delete: (id) => {
      const entry = pending.get(id);
      if (!entry) return false;
      clearTimeout(entry.timeout);
      return pending.delete(id);
    },
    clear: (reason) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(reason));
      }
      pending.clear();
    },
    values: () => pending.values(),
    size: () => pending.size,
  };
};
