/** Persistent cursor store for peer cache sync.
 *
 *  Tracks the highest peer-issued `created_at` the local side has seen.
 *  On WS reconnect the peer wrapper calls getSince(cursor) to pull every
 *  entry peer wrote while we were disconnected; afterwards the cursor
 *  advances so the next reconnect only pulls the new gap.
 *
 *  Two implementations:
 *    - In-memory (default): session-scoped. On browser reload, full resync.
 *    - IndexedDB / SQLite: provided by the host, so the cursor survives
 *      restarts and a disconnect+reconnect chain only pulls the delta.
 */

export interface CursorStore {
  /** Read the current cursor. Return 0 when unknown (→ full resync). */
  get(): Promise<number>;
  /** Persist a new cursor. Callers should only ever advance (monotonic). */
  set(cursor: number): Promise<void>;
}

export const createInMemoryCursorStore = (initial = 0): CursorStore => {
  let cursor = initial;
  return {
    async get() { return cursor; },
    async set(next) {
      if (next > cursor) cursor = next;
    },
  };
};
