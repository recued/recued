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

  /** Explicitly zero Master DEK + all sub-DEKs and transition to locked.
   *  Safe to call when already locked (no-op). */
  lock(): void;

  /** Get the sub-DEK for a domain. Throws when not unlocked. */
  getSubDEK(domain: SubDEKDomain): Uint8Array;

  /** Expose a `getEncryptionKey` callback for storage layers.
   *  Returns the sub-DEK when unlocked, null when locked. Never throws. */
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

  // A realm is "initialized" (→ boot `locked`, ready to unlock) when
  // EITHER a legacy password bundle OR a server vault bundle is
  // persisted. The server vault bundle is the live self-host path.
  const bundleAtStart = options.loadBundle() ?? options.loadServerBundle?.() ?? null;
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
        const existing = options.loadBundle();
        if (existing) {
          transition('locked');
        } else {
          throw new Error('key-manager: no bundle exists — call init first');
        }
      }
      // state === 'locked' (either from startup or just transitioned)
      const bundle = options.loadBundle();
      if (!bundle) {
        // Defensive: state says locked but bundle gone — fall back to uninitialized.
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
      const cached = subDEKs.get(domain);
      if (cached) return cached;
      const sk = deriveSubDEK(masterDEK, domain);
      subDEKs.set(domain, sk);
      return sk;
    },

    keyProvider(domain) {
      return () => {
        if (state !== 'unlocked' || !masterDEK) return null;
        const cached = subDEKs.get(domain);
        if (cached) return cached;
        const sk = deriveSubDEK(masterDEK, domain);
        subDEKs.set(domain, sk);
        return sk;
      };
    },
  };
};
