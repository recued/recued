/** D-148 § A.5.3 / § A.6.5 — Pro auth state machine substrate.
 *
 *  Server-side persistence of the `pro_subscription_token` bearer the
 *  ACME helper / DDNS update API validate per call. Mirrors the
 *  101st handle-state-machine shape:
 *
 *    - Closed-list state (`ProAuthState`): bearer + `authenticated_at`
 *      stamp, or null (signed out / never authenticated).
 *    - Store interface (`ProAuthStore`): async load + save + delete
 *      backed by the SQLite-backed adapter (`./sqlite-store.ts`) in
 *      production + the in-memory factory below in tests.
 *    - Mutation interface (`ProAuthStateMachine`): authenticate /
 *      signOut / current. Both writes call `persist()` which fires the
 *      `onStateChanged` listener used by `bin.ts` to flip the ACME
 *      factory's `ProAuthResolver` ref.
 *
 *  Minting is external (Stripe per § A.13 future); the substrate never
 *  validates the token's contents — the cloud helper does that. A
 *  garbage bearer travels through the substrate untouched + fails at
 *  the ACME `issueCert` call, where the renewer's `mapAcmeFailure`
 *  regex routes to `subscription_required`. The substrate only rejects
 *  empty / oversize tokens at the rpc boundary.
 *
 *  Single-slot. There is at most one active Pro authentication slot
 *  per server. `authenticate` replaces any prior slot atomically (the
 *  store does an INSERT OR REPLACE). `signOut` clears.
 *
 *  No cloud client. There is no `/v1/pro/auth/*` cloud endpoint in
 *  the six-family `CLOUD_PATH_FAMILIES` list — the substrate is
 *  local-only; the bearer is exercised lazily by the ACME / DDNS
 *  adapters when they make their next call. */

/** Persistent Pro auth state. The store serializes this to one row in
 *  `server_config` (key `pro_auth_state`). The signed-out state is
 *  represented by an absent row at the store layer (`load()` returns
 *  `null`); the state machine projects that into `null` snapshots. */
export interface ProAuthState {
  pro_subscription_token: string;
  /** Unix-ms when the slot was last (re-)authenticated. */
  authenticated_at: number;
}

/** Store interface backing the state machine. Production wires
 *  `createSqliteProAuthStore({db})`; tests use the in-memory factory
 *  below. */
export interface ProAuthStore {
  load(): Promise<ProAuthState | null>;
  save(state: ProAuthState): Promise<void>;
  delete(): Promise<void>;
}

/** In-memory `ProAuthStore` factory. Test-only; production paths use
 *  `createSqliteProAuthStore`. Holds the singleton in a closed-over
 *  variable so the test runner can introspect state across awaits. */
export const createInMemoryProAuthStore = (
  initial?: ProAuthState,
): ProAuthStore => {
  let state: ProAuthState | null = initial ?? null;
  return {
    async load() {
      return state;
    },
    async save(next) {
      state = next;
    },
    async delete() {
      state = null;
    },
  };
};

export interface ProAuthAuthenticateArgs {
  pro_subscription_token: string;
}

export interface ProAuthStateMachine {
  /** Returns the persisted state or `null` when the slot is empty.
   *  Lazy-loads from the store on first call + caches in memory for
   *  the process lifetime; mutations write through the cache. */
  current(): Promise<ProAuthState | null>;
  /** Persist a fresh bearer token + fire `onStateChanged`. Replaces
   *  any prior slot. */
  authenticate(args: ProAuthAuthenticateArgs): Promise<ProAuthState>;
  /** Clear the slot + fire `onStateChanged` with `null`. Idempotent. */
  signOut(): Promise<void>;
}

export interface CreateProAuthStateMachineOptions {
  store: ProAuthStore;
  /** Optional clock override (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Optional listener invoked synchronously after every state
   *  mutation. Production wires this in `bin.ts` to flip the ACME
   *  factory's `ProAuthResolver` ref (passes the snapshot when
   *  authenticated, `null` on sign-out). Errors are swallowed so a
   *  listener bug never aborts the mutation. */
  onStateChanged?: (state: ProAuthState | null) => void;
}

export const createProAuthStateMachine = (
  opts: CreateProAuthStateMachineOptions,
): ProAuthStateMachine => {
  const clock = opts.clock ?? Date.now;
  let cached: ProAuthState | null | undefined;

  const loadOrInit = async (): Promise<ProAuthState | null> => {
    if (cached !== undefined) return cached;
    cached = (await opts.store.load()) ?? null;
    return cached;
  };

  const emit = (state: ProAuthState | null): void => {
    if (!opts.onStateChanged) return;
    try {
      opts.onStateChanged(state);
    } catch {
      // Listener errors must not abort a successful mutation — the
      // state is already persisted + the next loadOrInit will read
      // the fresh row. Swallow so the rpc surface stays clean.
    }
  };

  return {
    async current() {
      return loadOrInit();
    },
    async authenticate({ pro_subscription_token }) {
      const next: ProAuthState = {
        pro_subscription_token,
        authenticated_at: clock(),
      };
      await opts.store.save(next);
      cached = next;
      emit(next);
      return next;
    },
    async signOut() {
      await opts.store.delete();
      cached = null;
      emit(null);
    },
  };
};
