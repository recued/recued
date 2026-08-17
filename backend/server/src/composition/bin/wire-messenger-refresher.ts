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

  const keyProvider = (): (() => Uint8Array | null) | undefined =>
    // Re-read per call, never captured: a boot→unlock transition must land
    // without rebuilding the refresher (the same rule the credential resolver
    // follows).
    deps.keys && deps.keys.state() !== 'uninitialized'
      ? deps.keys.keyProvider('connection')
      : undefined;

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
    persist: async (vendor: string, auth: ConnectionAuth): Promise<void> => {
      const { encodeAuthForStorage } = await import('../../connection-handler.js');
      // The row is keyed by the VENDOR being renewed (D-163 I-4: row name IS
      // the vendor). Re-read rather than captured, so a re-enrolment between
      // the exchange and this write is not clobbered with the older record.
      const existingRow = deps.connectionStore.get('notification', vendor);
      if (existingRow === null) return;
      const auth_ciphertext = await encodeAuthForStorage(
        auth,
        { kind: existingRow.kind, name: existingRow.name },
        keyProvider(),
      );
      deps.connectionStore.upsert({
        kind: existingRow.kind,
        name: existingRow.name,
        ...(existingRow.subtype !== undefined ? { subtype: existingRow.subtype } : {}),
        display_name: existingRow.display_name,
        ...(existingRow.publisher_id !== undefined
          ? { publisher_id: existingRow.publisher_id }
          : {}),
        config_json: existingRow.config_json,
        auth_ciphertext,
        enrolled_at: existingRow.enrolled_at,
        updated_at: Date.now(),
        ...(existingRow.last_used_at !== undefined
          ? { last_used_at: existingRow.last_used_at }
          : {}),
        ...(existingRow.health_json !== undefined
          ? { health_json: existingRow.health_json }
          : {}),
      });
    },
    ...(deps.onFailure ? { onFailure: deps.onFailure } : {}),
  });

  shared.set(deps.connectionStore, refresher);
  return refresher;
};
