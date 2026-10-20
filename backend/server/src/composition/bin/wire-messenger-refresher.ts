/** D-238 — the ONE `kind: 'notification'` OAuth2 refresher, shared by both
 *  consumers.
 *
 *  ⛔⛔ **SHARING IS A CORRECTNESS REQUIREMENT AND IT USED TO BE A COMMENT.**
 *  `createMessengerNotificationRefresher` is single-flight PER INSTANCE, because
 *  a rotating refresh token cannot survive two concurrent exchanges — each
 *  invalidates the other's, and the loser's stored credential is dead until the
 *  owner re-consents. The outbound send path (`compose-execution-context`) and
 *  the ingress supervisor (`compose-listeners`) are composed in DIFFERENT
 *  modules, so "pass the same instance" was an instruction nothing enforced and
 *  neither site followed — both simply omitted it, and the refresher was never
 *  constructed in production at all.
 *
 *  🔑 The fix is structural rather than documentary: this module memoizes per
 *  connection store, so both callers asking for a refresher GET THE SAME ONE by
 *  construction. There is no longer a way to wire two.
 *
 *  Spec: D-238 § 2a. */

import {
  createMessengerNotificationRefresher,
  type MessengerNotificationRefresher,
  type MessengerRefreshFailure,
  type OAuth2RefreshAuth,
  type MessengerRefreshIdentity,
} from '../../messenger-notification-refresh.js';
import type { ConnectionAuth } from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { KeyManager } from '../../key-manager.js';

export interface MessengerRefresherDeps {
  connectionStore: ConnectionStoreSqlite;
  keys?: KeyManager;
  /** Where a renewal failure becomes visible to the owner. ⛔ Not optional in
   *  spirit: the whole reason the oauth lane was gated is that such a row
   *  probes green and reports ready, so a failure with nowhere to go rebuilds
   *  exactly the mute channel this feature exists to avoid. */
  onFailure?: (failure: MessengerRefreshFailure) => void;
}

/** One refresher per connection store, for the lifetime of the process. */
const shared = new WeakMap<ConnectionStoreSqlite, MessengerNotificationRefresher>();

/** Persist the credential only against the source captured before renewal. */
export const persistMessengerNotificationAuth = async (
  deps: MessengerRefresherDeps, name: string, auth: ConnectionAuth, identity?: MessengerRefreshIdentity,
): Promise<void> => {
  const { encodeAuthForStorage } = await import('../../connection-handler.js');
  const existing = deps.connectionStore.get('notification', name);
  const matches = (row: typeof existing) => identity && row && row.enrolled_at === identity.enrolled_at
    && row.auth_ciphertext === identity.auth_ciphertext && row.config_json === identity.config_json;
  if (!matches(existing) || !existing) throw new Error('The notification connection changed during credential renewal');
  const auth_ciphertext = await encodeAuthForStorage(auth, { kind: existing.kind, name: existing.name },
    deps.keys?.keyProvider('connection'));
  if (deps.connectionStore.persistRefreshedAuth) {
    if (!deps.connectionStore.persistRefreshedAuth(existing, auth_ciphertext, Date.now())) {
      throw new Error('The notification connection changed during credential renewal');
    }
  } else {
    const current = deps.connectionStore.get('notification', name);
    if (!matches(current) || !current) throw new Error('The notification connection changed during credential renewal');
    // Synchronous fallback for embedders without the store's atomic CAS.
    deps.connectionStore.upsert({ ...current, auth_ciphertext, updated_at: Date.now() });
  }
};

/** Get (or build) the process-shared notification refresher.
 *
 *  Both call sites pass the same `connectionStore` — it is the server's single
 *  store — so both receive the same refresher and the single-flight guarantee
 *  actually holds across send AND poll. */
export const getMessengerNotificationRefresher = (
  deps: MessengerRefresherDeps,
): MessengerNotificationRefresher => {
  const existing = shared.get(deps.connectionStore);
  if (existing !== undefined) return existing;

  const refresher = createMessengerNotificationRefresher({
    now: () => Date.now(),
    refresh: async (auth: OAuth2RefreshAuth): Promise<ConnectionAuth> => {
      // Dynamic, matching the api-side refresher: keeps `@recued/ingredients`
      // out of the boot import graph for callers that never refresh anything.
      const { refreshOAuth2WithMetadata } = await import('@recued/ingredients');
      const refreshed = await refreshOAuth2WithMetadata(
        auth,
        globalThis.fetch.bind(globalThis),
        () => Date.now(),
        null,
      );
      return refreshed.auth;
    },
    persist: (name, auth, identity) => persistMessengerNotificationAuth(deps, name, auth, identity),
    ...(deps.onFailure ? { onFailure: deps.onFailure } : {}),
  });

  shared.set(deps.connectionStore, refresher);
  return refresher;
};
