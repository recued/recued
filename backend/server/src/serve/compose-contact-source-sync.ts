/** D-205 #4c — wire the declared contact Source sync tasks.
 *
 *  ## Why this MOVED here, and it is not cosmetic
 *
 *  The contact sync used to be wired inside `composeAppContext`, and it could only
 *  ever build ONE leaf there: the CRM leaf, which needs nothing but the
 *  `crm_record_mirror` the reconcilers already fill.
 *
 *  The Google People leaf needs the **gateway** — it dispatches the pack's own
 *  `contact.connections.list` through `runSourceMirrorFetch`, so every call is
 *  admitted against the connection's grant and audited. Those deps
 *  (`SourceMirrorFetchDeps`, via `buildCanonicalPollDeps(executeDeps, …)`) are
 *  composed POST-LISTENER. `composeAppContext` runs before they exist, so a leaf
 *  built there could never have them.
 *
 *  Placement therefore mirrors `composeWorkEntitySourceSync` and
 *  `composeCanonicalCrmReconciliation` — post-listener, one housekeeping task per
 *  registered contact Source with a leaf. A db-less / keyless boot collapses to a
 *  no-op.
 *
 *  ⚠ **Source REGISTRATION stays in `composeAppContext` (`wireContactSourceBoot`),
 *  and must.** A Source that never ran still has to appear in the health strip —
 *  driving that list off "has a sync task" would make an un-runnable Source VANISH
 *  from the page whose whole job is to say why it is not running, and absent reads
 *  as fine. Registration is an identity/visibility fact; syncing is a capability.
 *
 *  ## The dep bundle is two INDEPENDENT halves, and that is the bug this closed
 *
 *  The old wire read `crmRecordMirrorStoreRef ? { resolveAdapter } : {}` — because
 *  `ContactSourceAdapterDeps` was literally `{ mirror }`, REQUIRED. On a server with
 *  no CRM connected there is no `crm_record_mirror`, so **no resolver was passed at
 *  all**, and a contact book would have registered as a Source, rendered in the
 *  health strip, and silently never synced. A dep bundle that couples two unrelated
 *  vendors is how a feature disappears for exactly the users who only wanted the
 *  other one. */

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { buildCanonicalPollDeps } from '../watch/canonical-poll-deps.js';
import {
  buildContactSourceAdapterResolver,
  type ContactSourceAdapterDeps,
} from '../contact-source-adapters/index.js';
import { wireContactSourceSync } from '../contact-source-sync.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { ContactSourceSyncStateStore } from '../storage/contact-source-sync-state.js';
import type { CrmRecordMirrorStore } from '../storage/crm-record-mirror-store.js';

export interface ComposeContactSourceSyncInput {
  /** Late-bound — composed by listener-compose time. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  connectionStore: ConnectionStoreSqlite | undefined;
  store: ContactStore | undefined;
  /** D-205 #1 — where the cycle's outcome is RECORDED. Required, so a sync task
   *  cannot exist without somewhere to report its health. */
  syncState: ContactSourceSyncStateStore | undefined;
  /** The CRM mirror. Absent ⇒ no CRM contact leaves — and that is NOT an error, it
   *  is a server with no CRM. The contact book still syncs. */
  crmMirror: CrmRecordMirrorStore | undefined;
}

export const composeContactSourceSync = (input: ComposeContactSourceSyncInput): void => {
  const executeDeps = input.getExecuteDeps();
  const { connectionStore, store, syncState, crmMirror } = input;

  // The contact substrate itself. Without it there is nothing to sync INTO.
  if (connectionStore === undefined || store === undefined || syncState === undefined) {
    return;
  }

  // Build every leaf this server CAN build. Each half is optional and independent:
  // a CRM-less install still imports a contact book; a contact-book-less install
  // still hydrates from HubSpot.
  // Both contact books dispatch through the SAME gateway bundle, so it is built
  // once and shared. They stay separate KEYS because the resolver keys leaves by
  // vendor — sharing the deps object is not coupling the vendors.
  const gatewayDeps =
    executeDeps !== undefined
      ? { fetchDeps: buildCanonicalPollDeps(executeDeps, connectionStore) }
      : undefined;

  const adapterDeps: ContactSourceAdapterDeps = {
    ...(crmMirror !== undefined ? { crm: { mirror: crmMirror } } : {}),
    // A contact-book leaf needs the GATEWAY, so it exists only once `executeDeps`
    // does. On a db-less / keyless boot there is no gateway to dispatch through, and
    // a contact book simply has no task — the Source still registers and its health
    // row says it never ran, which is the honest state.
    ...(gatewayDeps !== undefined ? { google: gatewayDeps, microsoft: gatewayDeps } : {}),
  };

  // No leaf at all ⇒ no resolver ⇒ no task for any vendor. Passing an empty
  // resolver would be identical, but saying it here keeps the no-op boot obvious.
  //
  // ⚠ EVERY leaf is named. Today `google` and `microsoft` are gated on the same
  // `executeDeps`, so testing one would pass — but that is a coincidence of the
  // current wiring, not a property. Gating the resolver on a subset is precisely how
  // the header's failure happens: a Source registers, shows in the health strip, and
  // silently never syncs.
  if (
    adapterDeps.crm === undefined
    && adapterDeps.google === undefined
    && adapterDeps.microsoft === undefined
  ) {
    return;
  }

  wireContactSourceSync({
    connectionStore,
    store,
    syncState,
    resolveAdapter: buildContactSourceAdapterResolver(adapterDeps),
  });
};
