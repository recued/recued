/** Server-side Master DEK lifecycle manager.
 *
 *  Three states:
 *    uninitialized — no bundle persisted. Server has never been through
 *                    auth.init. Plaintext storage allowed; encrypted
 *                    storage ops throw until init runs.
 *    locked        — bundle exists on disk; Master DEK not in RAM. All
 *                    key requests throw "locked". This is the state a
 *                    freshly-restarted server enters when a bundle is
 *                    present — restart-wipes-credential discipline per
 *                    project_crypto_architecture.md.
 *    unlocked      — Master DEK is in RAM; sub-DEKs can be derived.
 *                    Only reachable via a successful unlock() call.
 *
 *  Sub-DEK caching: HKDF is cheap but not free. The manager caches
 *  derived sub-DEKs for the unlocked lifetime and zeroizes them on lock.
 *
 *  Zeroization: lock() overwrites the Uint8Arrays holding Master DEK
 *  and every cached sub-DEK with zeros before releasing references.
 *  This is defense-in-depth — Node has no native mlock, but wiping
 *  arrays we still control shortens the attack window for memory-dump
 *  adversaries. Residual copies in V8's heap are a known limitation.
 */

import {
  openBundleWithPassword,
  openBundleWithRecoveryKey,
  createBundle,
  createServerBundle,
  openServerBundleWithServerKey,
  openServerBundleWithRecoveryKey as openBundleWithRecoveryKeyForServerBundle,
  deriveSubDEK,
  rotatePassword as cryptoRotatePassword,
  type Argon2Params,
  type Bundle,
  type ServerBundle,
  type SubDEKDomain,
} from '@recued/crypto';

export type KeyManagerState = 'uninitialized' | 'locked' | 'unlocked';

export interface KeyManagerOptions {
  /** Load the persisted bundle. Called once at construction and again
   *  after init. Return null/undefined when no bundle exists. */
  loadBundle: () => Bundle | null;
  /** Persist a bundle. Called after init + rotations (future). */
  saveBundle: (bundle: Bundle) => void;
  /** Load the persisted SERVER vault bundle (server-key + recovery-key
   *  dual-wrap). Optional — omit in db-less / password-only test
   *  compositions. When present, its existence also flips the startup
   *  state to `locked` so a server-bundle-only realm boots ready to
   *  auto-unlock. */
  loadServerBundle?: () => ServerBundle | null;
  /** Optional bundle already read before storage opened (D-212 boot order).
   *  Construction uses this snapshot for its initial state; later unlock/init
   *  guards still call `loadServerBundle` so they observe current disk state. */
  initialServerBundle?: ServerBundle | null;
  /** Persist the server vault bundle. Called at first-boot enrollment
   *  (`initServerVault`). Required for `initServerVault` to run. */
  saveServerBundle?: (bundle: ServerBundle) => void;
  /** Observational hook — fires on every state transition.
   *  Useful for telemetry and "locked: true" flag surfacing. */
  onStateChange?: (next: KeyManagerState, prev: KeyManagerState) => void;
  /** Override for Argon2id cost parameters at init time. Omit to use
   *  OWASP 2024 defaults (64 MiB / 3 iter / 4 lanes). Tests only — in
   *  production leaving this at defaults is a security requirement. */
  argon2Params?: Argon2Params;
  /** Optional idle-lock timeout. When set (> 0), the KeyManager starts
   *  a timer on unlock that locks the server if no activity for this
   *  many ms. Callers must invoke touch() on every activity-worthy rpc
   *  to reset the timer. Omit or set to 0 to disable auto-lock. */
  idleTimeoutMs?: number;
  /** Scheduler override for tests (setTimeout / clearTimeout). Default
   *  uses Node's timer globals. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface KeyManager {
  state(): KeyManagerState;

  /** Create a fresh bundle with the given password, persist it, and
   *  enter unlocked state. The returned recoveryKey is the only moment
   *  the caller sees the 24-word mnemonic; it must be shown to the user
   *  exactly once. */
  init(options: { password: string }): Promise<{ recoveryKey: string }>;

  /** Transition locked → unlocked using the bundle persisted at init.
   *  Exactly one of password/recoveryKey must be provided. Throws on
   *  wrong credentials or malformed bundle. */
  unlock(credentials: { password?: string; recoveryKey?: string }): Promise<void>;

  /** First-boot encryption enrollment. Creates a SERVER vault bundle
   *  wrapping a fresh Master DEK under both the (caller-supplied) server
   *  key and the user's recovery key, persists it, and enters unlocked
   *  state. The caller persists the same `serverKey` in the keyfile so
   *  future boots can `unlockWithServerKey`. Throws if a vault bundle
   *  already exists (would orphan encrypted data) or the store is not
   *  wired. */
  initServerVault(args: { recoveryKey: string; serverKey: Uint8Array }): Promise<void>;

  /** Headless boot auto-unlock. Transition locked → unlocked by opening
   *  the persisted server vault bundle with the keyfile-held server key.
   *  Throws when no server bundle exists or the key does not open it. */
  unlockWithServerKey(args: { serverKey: Uint8Array }): Promise<void>;

  /** Does `recoveryKey` open this realm's vault bundle? Read-only — binds
   *  nothing, changes no state, and wipes the Master DEK it recovers.
   *
   *  The bundle is what an ENCRYPTED realm is actually bound to; the recovery
   *  sentinel is a side-record that can go missing while the bundle survives.
   *  Callers gating enrollment must ask this, not just the sentinel, or a realm
   *  in that split state re-binds to whoever asks next. `true` for a realm with
   *  no bundle — there is nothing to prove against. */
  verifyRecoveryKey(recoveryKey: string): Promise<boolean>;

  /** Is a server vault bundle durably present? Reads the store, not the
   *  in-memory state, because the two can disagree — and callers about to do
   *  something destructive (minting a replacement keyfile key) need the disk's
   *  answer, not the manager's recollection. */
  hasServerBundle(): boolean;

  /** Zero the Master DEK and every cached sub-DEK, then transition to locked.
   *  Safe to call when already locked (no-op).
   *
   *  ⚠ Scope: the MANAGER's material. Buffers already handed to callers are
   *  copies and are not reachable from here — see `getSubDEK`. After this,
   *  `keyProvider` returns null and `getSubDEK` throws. */
  lock(): void;

  /** The sub-DEK for a domain, as a COPY the caller owns and may wipe.
   *  Throws when not unlocked.
   *
   *  Ownership is the contract: wiping what you were handed is expected and
   *  cannot affect the manager or any other caller. The flip side is that
   *  `lock()` cannot reach your copy — hold it no longer than the operation
   *  that needs it. */
  getSubDEK(domain: SubDEKDomain): Uint8Array;

  /** Expose a `getEncryptionKey` callback for storage layers.
   *  Returns a caller-owned copy of the sub-DEK when unlocked, null when
   *  locked. Never throws. Same ownership rule as `getSubDEK`. */
  keyProvider(domain: SubDEKDomain): () => Uint8Array | null;

  /** Rotate the password wrap. Requires unlocked state + the current
   *  password for re-verification. Recovery key wrap untouched. */
  rotatePassword(args: { oldPassword: string; newPassword: string }): Promise<void>;

  /** Reset the auto-lock inactivity timer. No-op when auto-lock is
   *  disabled. Called by dispatch on every activity-worthy rpc. */
  touch(): void;
}

const zeroize = (buf: Uint8Array): void => {
  buf.fill(0);
};

export const createKeyManager = (options: KeyManagerOptions): KeyManager => {
  let masterDEK: Uint8Array | null = null;
  const subDEKs = new Map<SubDEKDomain, Uint8Array>();

  /** Derive-once, hand out a COPY.
   *
   *  The cache is ours; the array a caller receives is theirs. Returning the
   *  cached array directly made the two the same object, so a caller writing
   *  the pattern this codebase uses everywhere else —
   *
   *      const k = keys.getSubDEK('blob-store');
   *      try { … } finally { k.fill(0); }
   *
   *  — would zero the manager's cache in place while `state` stayed
   *  `unlocked`. Every later read of that domain then returns 32 zero bytes:
   *  everything written afterwards is encrypted under a publicly known key and
   *  everything written before becomes unreadable to the process, with no
   *  error and no state change to notice. No current consumer does it, which
   *  is exactly why the next one would.
   *
   *  The copy costs 32 bytes per call and skips the HKDF, which is the part
   *  worth caching. `zeroAll` still wipes the originals on lock. */
  const cachedSubDEK = (dek: Uint8Array, domain: SubDEKDomain): Uint8Array => {
    let cached = subDEKs.get(domain);
    if (!cached) {
      cached = deriveSubDEK(dek, domain);
      subDEKs.set(domain, cached);
    }
    return Uint8Array.prototype.slice.call(cached);
  };

  // A realm is "initialized" (→ boot `locked`, ready to unlock) when
  // EITHER a legacy password bundle OR a server vault bundle is
  // persisted. The server vault bundle is the live self-host path.
  const serverBundleAtStart = Object.prototype.hasOwnProperty.call(
    options,
    'initialServerBundle',
  )
    ? options.initialServerBundle ?? null
    : options.loadServerBundle?.() ?? null;
  const bundleAtStart = options.loadBundle() ?? serverBundleAtStart;
  let state: KeyManagerState = bundleAtStart ? 'locked' : 'uninitialized';

  // Auto-lock timer: single rescheduling handle. Reset on every touch().
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  let idleTimerHandle: unknown = null;

  const clearIdleTimer = () => {
    if (idleTimerHandle) {
      clearTimer(idleTimerHandle);
      idleTimerHandle = null;
    }
  };

  const armIdleTimer = () => {
    if (idleTimeoutMs <= 0) return;
    clearIdleTimer();
    idleTimerHandle = setTimer(() => {
      idleTimerHandle = null;
      // Only fire lock if still unlocked — otherwise it's a no-op anyway.
      if (state === 'unlocked') {
        zeroAll();
        transition('locked');
      }
    }, idleTimeoutMs);
  };

  const transition = (next: KeyManagerState) => {
    if (next === state) return;
    const prev = state;
    state = next;
    options.onStateChange?.(next, prev);
  };

  const zeroAll = () => {
    if (masterDEK) zeroize(masterDEK);
    masterDEK = null;
    for (const sk of subDEKs.values()) zeroize(sk);
    subDEKs.clear();
  };

  return {
    state: () => state,

    async init({ password }) {
      if (state === 'unlocked') {
        throw new Error('key-manager: already unlocked (call lock() first if re-initializing)');
      }
      // Re-check persistent store: migration (or another actor) may have
      // saved a bundle since construction. Don't silently overwrite it.
      const existing = options.loadBundle();
      if (existing || state === 'locked') {
        if (state === 'uninitialized') transition('locked');
        throw new Error(
          'key-manager: bundle already exists — init would replace encryption keys and orphan existing encrypted data. '
          + 'Rotate the password via auth.rotatePassword instead, or wipe the data directory before re-initializing.',
        );
      }
      // state === 'uninitialized' and no bundle persisted
      const { bundle, recoveryKey, masterDEK: fresh } = await createBundle({
        password,
        argon2: options.argon2Params,
      });
      options.saveBundle(bundle);
      masterDEK = fresh;
      transition('unlocked');
      armIdleTimer();
      return { recoveryKey };
    },

    async unlock({ password, recoveryKey }) {
      if (state === 'unlocked') return;
      if (state === 'uninitialized') {
        // Re-check persistent store: migration (or another actor) may have
        // saved a bundle since construction.
        const existing = options.loadBundle() ?? options.loadServerBundle?.();
        if (existing) {
          transition('locked');
        } else {
          throw new Error('key-manager: no bundle exists — call init first');
        }
      }
      // state === 'locked' (either from startup or just transitioned)
      const bundle = options.loadBundle();
      if (!bundle) {
        // A D-212 realm has no legacy password bundle at all — its Master DEK
        // lives in the server vault sidecar. Falling through to the divergence
        // branch here used to flip state to `uninitialized` while that sidecar
        // sat on disk, and the next re-pair then overwrote the keyfile before
        // `initServerVault`'s guard could refuse: an unopenable realm, reached
        // by following the boot log's own advice after a failed auto-unlock.
        const serverBundle = options.loadServerBundle?.() ?? null;
        if (serverBundle) {
          if (!recoveryKey) {
            // The password factor does not exist on this realm. Refuse without
            // touching state — locked is the truth, and it stays recoverable.
            throw new Error(
              'key-manager: this realm is unlocked by its recovery key (or the server keyfile), not a password',
            );
          }
          masterDEK = await openBundleWithRecoveryKeyForServerBundle(serverBundle, recoveryKey);
          transition('unlocked');
          armIdleTimer();
          return;
        }
        // Genuinely nothing on disk under either scheme.
        transition('uninitialized');
        throw new Error('key-manager: bundle missing from storage (state divergence)');
      }
      let dek: Uint8Array;
      if (password) {
        dek = await openBundleWithPassword(bundle, password);
      } else if (recoveryKey) {
        dek = await openBundleWithRecoveryKey(bundle, recoveryKey);
      } else {
        throw new Error('key-manager: password or recoveryKey is required');
      }
      masterDEK = dek;
      transition('unlocked');
      armIdleTimer();
    },

    async initServerVault({ recoveryKey, serverKey }) {
      if (state === 'unlocked') {
        throw new Error('key-manager: already unlocked (call lock() first if re-initializing)');
      }
      if (!options.saveServerBundle) {
        throw new Error('key-manager: server-bundle store not wired — cannot initServerVault');
      }
      // Refuse to overwrite an existing vault bundle (server OR legacy
      // password) — a fresh Master DEK would orphan every row already
      // encrypted under the current one. Mirror the password init guard.
      const existing = options.loadServerBundle?.() ?? options.loadBundle();
      if (existing || state === 'locked') {
        if (state === 'uninitialized') transition('locked');
        throw new Error(
          'key-manager: a vault bundle already exists — initServerVault would replace encryption keys and orphan existing encrypted data.',
        );
      }
      // createServerBundle throws on a malformed recovery key / wrong
      // server-key length BEFORE anything is persisted.
      const { bundle, masterDEK: fresh } = await createServerBundle({ recoveryKey, serverKey });
      // Re-assert the guard at the act site: the check above happened
      // BEFORE this await, so a concurrent initServerVault could have
      // committed its own bundle in between and this save would silently
      // orphan every row already encrypted under it. Callers serialize at
      // the door (`enrollRealmRecoveryKey`); this is the backstop for any
      // caller that does not.
      if ((options.loadServerBundle?.() ?? options.loadBundle()) || state !== 'uninitialized') {
        fresh.fill(0);
        throw new Error(
          'key-manager: a vault bundle was created concurrently — initServerVault refused to replace it.',
        );
      }
      options.saveServerBundle(bundle);
      masterDEK = fresh;
      transition('unlocked');
      armIdleTimer();
    },

    async unlockWithServerKey({ serverKey }) {
      if (state === 'unlocked') return;
      const bundle = options.loadServerBundle?.();
      if (!bundle) {
        throw new Error('key-manager: no server vault bundle exists — call initServerVault first');
      }
      // Opens + AEAD-authenticates the server wrap; throws on a wrong
      // key or tampered bundle. On success the Master DEK enters RAM.
      const dek = await openServerBundleWithServerKey(bundle, serverKey);
      masterDEK = dek;
      transition('unlocked');
      armIdleTimer();
    },

    hasServerBundle() {
      return !!options.loadServerBundle?.();
    },

    async verifyRecoveryKey(recoveryKey) {
      // The bundle, not the sentinel, is what an encrypted realm is bound to —
      // and this reads it through the SAME accessor the guards use, so a caller
      // cannot end up proving a key against a different bundle than the one the
      // manager would open. Read-only: nothing is bound, no state changes, and
      // the Master DEK it recovers is wiped rather than retained.
      const bundle = options.loadServerBundle?.() ?? null;
      // No bundle means there is nothing to prove against — the caller's own
      // sentinel check owns that case.
      if (!bundle) return true;
      let dek: Uint8Array | undefined;
      try {
        dek = await openBundleWithRecoveryKeyForServerBundle(bundle, recoveryKey);
        return true;
      } catch {
        // Wrong key, malformed mnemonic, tampered or unreadable bundle all
        // collapse here on purpose, so the answer cannot say which it was.
        return false;
      } finally {
        dek?.fill(0);
      }
    },

    lock() {
      clearIdleTimer();
      zeroAll();
      // uninitialized stays uninitialized; locked/unlocked → locked.
      if (state === 'uninitialized') return;
      transition('locked');
    },

    touch() {
      // Only meaningful in unlocked state + when auto-lock is configured.
      if (state !== 'unlocked' || idleTimeoutMs <= 0) return;
      armIdleTimer();
    },

    async rotatePassword({ oldPassword, newPassword }) {
      if (state !== 'unlocked') {
        throw new Error('key-manager: rotatePassword requires unlocked state');
      }
      if (!newPassword || newPassword.length === 0) {
        throw new Error('key-manager: newPassword is required');
      }
      const current = options.loadBundle();
      if (!current) {
        throw new Error('key-manager: bundle missing despite unlocked state');
      }
      const next = await cryptoRotatePassword(current, oldPassword, newPassword, {
        argon2: options.argon2Params,
      });
      options.saveBundle(next);
      armIdleTimer();
    },

    getSubDEK(domain) {
      if (state !== 'unlocked' || !masterDEK) {
        throw new Error('key-manager: locked');
      }
      return cachedSubDEK(masterDEK, domain);
    },

    keyProvider(domain) {
      return () => {
        if (state !== 'unlocked' || !masterDEK) return null;
        return cachedSubDEK(masterDEK, domain);
      };
    },
  };
};
