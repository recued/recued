/** D-148 § A.4.1 — "Clear this browser" affordance.
 *
 *  Wipes the closed-list 5 IDB fields + sessionStorage + the SW
 *  cache. After invocation the webclient holds zero residual app
 *  state; the user re-pairs to re-enter.
 *
 *  Hard rule (P4 acceptance): the IDB inspection following a clear
 *  must report exactly zero keys in the
 *  `recued.webclient.local_storage` object store. The implementation
 *  exercises BOTH per-key removes AND a bulk clear so a dropped path
 *  can't silently leave residue.
 */

import type { WebclientLocalStore } from '../storage/local-store.js';
import { WEBCLIENT_SHELL_CACHE_NAME } from '../runtime/service-worker.js';
import {
  resolveBrowserPairFinalizeLockProvider,
  withPairFinalizeLock,
  type PairFinalizeLockProvider,
} from './pair-code-success.js';

export interface ClearThisBrowserOptions {
  /** Closed-list 5-field store. Always wiped. */
  local_store: WebclientLocalStore;
  /** Optional sessionStorage handle. When omitted the runtime
   *  resolves `globalThis.sessionStorage` if present; tests inject a
   *  fake. */
  session_storage?: SessionLikeStorage;
  /** Optional SW cache name(s) to delete. The default is the well-
   *  known `recued.webclient.assets` cache; bootstrap that registers
   *  a different name passes the override. */
  sw_cache_names?: string[];
  /** Optional CacheStorage handle. When omitted the runtime resolves
   *  `globalThis.caches` if present; tests inject a fake. */
  cache_storage?: CacheLikeStorage;
  /** Optional wiper for the AES-GCM key store (`crypto_keys` per
   *  spec § A.4.1 — the non-extractable `CryptoKey` that wraps the
   *  bearer at rest). The webclient entrypoint owns the IDB handle
   *  to the `recued.webclient.token_key` object store; the future
   *  Settings → Privacy → "Clear this browser" surface plumbs the
   *  store-clear here so the zero-residual-state privacy contract
   *  is honored end-to-end. When omitted the path no-ops; the key
   *  survives the reset, which is wrong for a paired browser but
   *  cannot be fixed inside this module without an IDB handle. */
  crypto_keys_wiper?: () => Promise<void>;
  /** Best-effort boundary hook invoked immediately after the five-field
   * credential store is clear. It runs before unrelated session/cache/key
   * cleanup so sibling tabs converge even if one of those later steps fails. */
  on_local_credentials_cleared?: () => void;
  /** Shared browser credential-transition lock. The default resolves Web
   * Locks; tests can inject a deterministic provider or `null`. */
  pair_lock_provider?: PairFinalizeLockProvider | null;
}

export interface ClearThisBrowserResult {
  /** Per-step outcome — true means the step ran successfully (or
   *  the surface was unavailable, which is a no-op success per
   *  graceful-degradation discipline). */
  cleared_local_store: boolean;
  cleared_session_storage: boolean;
  cleared_sw_caches: boolean;
  /** Names of SW caches that were actually deleted. Empty when the
   *  surface wasn't available or no recued caches existed. */
  deleted_cache_names: string[];
  /** True iff the AES-GCM key store was wiped. False when the caller
   *  passed no `crypto_keys_wiper` (no IDB handle to reach) — the
   *  Settings → Privacy UI should surface this as "key store left
   *  behind" if `false`, so the user understands the reset is
   *  partial. */
  cleared_crypto_keys: boolean;
}

export interface SessionLikeStorage {
  clear(): void;
  // Spec adherence: sessionStorage gives `length` + `key(i)`;
  // we don't need them — `clear()` wipes everything. Narrow the
  // contract to that one method so tests can inject a tiny fake.
}

export interface CacheLikeStorage {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

// Codex slice-109 P2 fold — the default MUST match the cache name
// `public/sw.js` actually opens. Pre-fold the default was a stale name
// (`recued.webclient.assets`) that no SW build had ever opened, so the
// default "Clear this browser" flow claimed cache deletion that never
// happened. The constant lives in `runtime/service-worker.ts` so the SW
// file's upgrade-version bump + the wipe target stay co-located.
//
// ⚠ Co-located is not derived: the name regressed to exactly the pre-fold
// failure once already (constant on `v4`, SW on `v5`). Parity is now
// asserted by a test — see `WEBCLIENT_SHELL_CACHE_NAME`.
const DEFAULT_SW_CACHE_NAMES = [WEBCLIENT_SHELL_CACHE_NAME] as const;

const resolveSessionStorage = (override?: SessionLikeStorage): SessionLikeStorage | null => {
  if (override) return override;
  if (typeof globalThis === 'undefined') return null;
  const ss = (globalThis as unknown as { sessionStorage?: SessionLikeStorage }).sessionStorage;
  return ss ?? null;
};

const resolveCacheStorage = (override?: CacheLikeStorage): CacheLikeStorage | null => {
  if (override) return override;
  if (typeof globalThis === 'undefined') return null;
  const cs = (globalThis as unknown as { caches?: CacheLikeStorage }).caches;
  return cs ?? null;
};

/** Wipe every documented webclient state surface. Returns a typed
 *  result so the Settings UX can render "what happened" feedback +
 *  the audit row carries the structured outcome. */
export const clearThisBrowser = async (
  options: ClearThisBrowserOptions,
): Promise<ClearThisBrowserResult> => {
  const result: ClearThisBrowserResult = {
    cleared_local_store: false,
    cleared_session_storage: false,
    cleared_sw_caches: false,
    deleted_cache_names: [],
    cleared_crypto_keys: false,
  };
  const pairLockProvider = options.pair_lock_provider !== undefined
    ? options.pair_lock_provider
    : resolveBrowserPairFinalizeLockProvider();
  // Keep only the shared credential + key transition inside the pairing lock.
  // SessionStorage and CacheStorage are unrelated cleanup surfaces and can be
  // slow or blocked; holding the cross-tab lock over them would strand a
  // sibling's otherwise-safe re-pair.
  await withPairFinalizeLock(
    pairLockProvider,
    async () => {
      // 1. Closed-list 5-field IDB store.
      await options.local_store.clear();
      result.cleared_local_store = true;
      if (options.on_local_credentials_cleared) {
        try {
          options.on_local_credentials_cleared();
        } catch {
          // The durable clear already succeeded; observers are advisory.
        }
      }

      // 2. AES-GCM key store (crypto_keys per § A.4.1). Pairing cannot
      // resume until the old key is gone, or a new bearer could be wrapped
      // with the key this clear is about to delete.
      if (options.crypto_keys_wiper) {
        await options.crypto_keys_wiper();
        result.cleared_crypto_keys = true;
      }
    },
  );

  // 3. sessionStorage (ephemeral_session_state per § A.4.1).
  const ss = resolveSessionStorage(options.session_storage);
  if (ss) {
    ss.clear();
  }
  result.cleared_session_storage = true;

  // 4. SW caches (cached_assets per § A.4.1).
  const cs = resolveCacheStorage(options.cache_storage);
  const cache_names =
    options.sw_cache_names && options.sw_cache_names.length > 0
      ? options.sw_cache_names
      : DEFAULT_SW_CACHE_NAMES;
  if (cs) {
    const present = await cs.keys();
    const present_set = new Set(present);
    for (const name of cache_names) {
      if (present_set.has(name)) {
        const ok = await cs.delete(name);
        if (ok) result.deleted_cache_names.push(name);
      }
    }
  }
  result.cleared_sw_caches = true;

  return result;
};
