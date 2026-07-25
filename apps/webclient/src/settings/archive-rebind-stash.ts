/** M5 S2b — the host-side `ArchiveRebindStashFn` the Backup & Recovery panel
 *  consumes. A committing `server.archive.import` swaps the whole server db,
 *  wiping THIS driving client's bearer row; the server mints a fresh bearer
 *  INTO the restored db + returns it as `ArchiveImportRebind`. This re-wraps
 *  that bearer under the SAME AES-GCM envelope the bootstrap's `resolveBearer`
 *  reads (via the shared `rewrapBearerForActivePair` — also behind the
 *  `token.rotated` handler) and overwrites `webclient_token` IN PLACE, so the
 *  global reconnect's next WS upgrade presents the new bearer + re-pairs
 *  seamlessly into the restored realm.
 *
 *  Factored out of `webclient-bootstrap.ts` so the rebind → wrap field mapping
 *  (`rebind.token_id` → AAD/record `token_id`; `rebind.bearer` → bearer) is
 *  unit-testable — a swap or a raw-bearer store would otherwise pass the
 *  panel's fake-seam tests + the helper's standalone tests while silently
 *  forcing a re-pair after every restore.
 *
 *  Best-effort by contract: `rewrapBearerForActivePair` never throws (it
 *  returns a tagged result we don't act on). A failed stash leaves the old
 *  (now swapped-away) bearer in place → the next reconnect's auth fails → the
 *  existing reauth → re-pair flow takes over (the pre-S2b fallback). The panel
 *  never blocks the "restarting" view on this. */

import type { ArchiveImportRebind } from '@recued/contracts';

import type { WebclientLocalStore } from '../storage/local-store.js';
import { rewrapBearerForActivePair } from '../storage/rewrap-bearer.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { ArchiveRebindStashFn } from './archive-backup-panel.js';

export interface CreateArchiveRebindStashDeps {
  localStore: WebclientLocalStore;
  tokenStore: WebclientTokenStore;
}

export const createArchiveRebindStash = (
  deps: CreateArchiveRebindStashDeps,
): ArchiveRebindStashFn => async (rebind: ArchiveImportRebind): Promise<void> => {
  await rewrapBearerForActivePair({
    localStore: deps.localStore,
    tokenStore: deps.tokenStore,
    token_id: rebind.token_id,
    bearer: rebind.bearer,
  });
};
