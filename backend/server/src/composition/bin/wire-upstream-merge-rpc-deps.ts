/** D-138 P5 — upstream-merge rpc-deps composer.
 *
 *  Builds the `UpstreamMergeRpcDeps` shape consumed by the five
 *  `upstream_merge.*` rpcs (`describe` / `request` / `retry` / `discard` /
 *  `list`). Three external integrations land here:
 *
 *    1. **`vendorConnectionLookup`** — closes over `ConnectionStoreSqlite.get`
 *       and decodes one row's `config_json` / `auth_ciphertext` / `health_json`
 *       into the `ConnectionRecord` shape the upstream-merge driver
 *       consumes. Decrypt-on-read happens at the connection-handler rpc
 *       level normally; the upstream-merge driver runs server-side and
 *       reads the row directly. When the FileVault is initialised the
 *       AEAD ciphertext stays opaque (`JSON.parse` falls through to the
 *       `{ type: 'none' }` fallback and the driver surfaces
 *       `vendor_auth_expired`). The legacy/uninitialised-vault path
 *       stores `JSON.stringify(plain)` so `JSON.parse` recovers the
 *       shape directly. The keyProvider hook is a P5 follow-up.
 *
 *    2. **`approvalSink`** — bridges the upstream-merge state-machine
 *       driver onto the existing D-113 `ApprovalStore`. The merge
 *       request always emits `risk_tier: 'destructive'`, but a future
 *       caller could widen the request shape, so the narrower
 *       `'destructive' | 'admin' | 'write'` mapping is defensive. Both
 *       `addPending` and `markResolved` swallow store failures — the
 *       driver's state machine doesn't depend on the approval row
 *       landing successfully (audit + UI fall back to the outbox row's
 *       state).
 *
 *    3. **`audit`** — emits one `kind: 'memory'` audit subkind per state
 *       transition so the D-120 timeline captures the merge lifecycle.
 *       Best-effort; failures never abort the driver. The activity id
 *       stamps a composite of `(outbox_id, transition, ts)` so the
 *       audit ledger has unique entries per state hop.
 *
 *  Late-binding contract: `vendorMergers` is a single Map instance — the
 *  composer captures the reference into `UpstreamMergeRpcDeps.vendorMergers`
 *  + returns the same Map so the caller can publish it back into its
 *  module-top late-bound ref. Downstream vendor substrate composers
 *  (HubSpot + Salesforce) read the published ref + `.set(...)` per
 *  object_type after enrollment — those mutations take effect at the
 *  next rpc call because the deps object captured the Map by reference.
 *
 *  Returns `undefined` when any of (`upstreamMergeStore`, `contactStore`,
 *  `connectionStore`) is absent. Dbless harnesses leave the slice off
 *  and the five `upstream_merge.*` methods return `not_configured`. */

import type {
  ApprovalRequest,
  ConnectionRecord,
  UpstreamMergeObjectType,
  UpstreamMergeVendor,
} from '@recued/contracts';
import type { ApprovalStore } from '../../approval-handler.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import { decodeConnectionRow } from '../../storage/connection-row-decode.js';
import type { UpstreamMergeStore } from '../../storage/upstream-merge-store.js';
import type { VendorMergeClient } from '../../data/vendor-merge.js';
import type {
  UpstreamMergeRpcDeps,
  UpstreamMergeAuditEntry,
} from '../../upstream-merge-handler.js';
import type { EventBus } from '../../events/bus.js';

export type UpstreamMergeRegistry = Map<UpstreamMergeObjectType, VendorMergeClient>;

export interface ComposeUpstreamMergeRpcDepsInput {
  /** Pair-scoped outbox + state-machine durability. Absent → composer
   *  returns undefined and the rpc slice drops. */
  upstreamMergeStore: UpstreamMergeStore | undefined;
  /** Contact warehouse (the local survivor record + loser records).
   *  Absent → composer returns undefined. */
  contactStore: ContactStore | undefined;
  /** Connection substrate — backs `vendorConnectionLookup`. Absent →
   *  composer returns undefined (no per-vendor auth path exists). */
  connectionStore: ConnectionStoreSqlite | undefined;
  /** Existing vendor-merger registry reference. When present the
   *  composer uses it as-is + returns the same instance; when absent
   *  the composer mints a fresh empty Map + returns it so the caller
   *  can publish it back into its module-top late-bound ref. Either
   *  way the returned Map is the live instance downstream vendor
   *  substrate composers will populate. */
  existingRegistry: UpstreamMergeRegistry | undefined;
  /** D-113 approval store the upstream-merge driver pushes synthetic
   *  approval rows onto. Always present at the composition site (the
   *  approval store is built unconditionally at module top). */
  approvalStore: ApprovalStore;
  /** D-121 broadcast bus — the driver fires `upstream_merge_failed`
   *  on terminal failure. Always present at the composition site. */
  eventBus: EventBus;
  /** Server instance id used as the approval row's `initiator_instance`.
   *  Falls back to `'recued-server'` when undefined. */
  serverInstanceId: string | undefined;
}

export interface UpstreamMergeRpcBundle {
  /** Threaded into `createServerHandlerSet({ upstreamMergeDeps })`.
   *  Undefined when prereqs are missing → caller drops the spread + the
   *  five rpc methods return `not_configured`. */
  upstreamMergeDeps: UpstreamMergeRpcDeps | undefined;
  /** The live vendor-merger registry. Undefined iff `upstreamMergeDeps`
   *  is undefined. Caller publishes this back to its module-top
   *  late-bound ref so downstream vendor substrate composers
   *  populate the same instance. */
  vendorMergers: UpstreamMergeRegistry | undefined;
}

export const composeUpstreamMergeRpcDeps = (
  input: ComposeUpstreamMergeRpcDepsInput,
): UpstreamMergeRpcBundle => {
  const {
    upstreamMergeStore,
    contactStore,
    connectionStore,
    existingRegistry,
    approvalStore,
    eventBus,
    serverInstanceId,
  } = input;

  if (!upstreamMergeStore || !contactStore || !connectionStore) {
    return { upstreamMergeDeps: undefined, vendorMergers: undefined };
  }

  const vendorMergers: UpstreamMergeRegistry =
    existingRegistry ?? new Map<UpstreamMergeObjectType, VendorMergeClient>();

  const vendorConnectionLookup = (
    vendor: UpstreamMergeVendor,
    name: string,
  ): ConnectionRecord | null => {
    const row = connectionStore.get('api', name);
    if (row === null) return null;
    if (row.subtype !== vendor) return null;
    // Decrypt-on-read happens at the connection-handler rpc level
    // normally; the upstream-merge driver runs server-side so it reads
    // the row directly through `decodeConnectionRow` (opaque-AEAD-
    // tolerant projection — when FileVault-initialised the cipher is
    // opaque + the helper falls back to `auth: { type: 'none' }` so
    // the merger surfaces `vendor_auth_expired`; the legacy/
    // uninitialised-vault path stores `JSON.stringify(plain)` so the
    // parse recovers the shape directly).
    return decodeConnectionRow(row);
  };

  const approvalSink: NonNullable<UpstreamMergeRpcDeps['approvalSink']> = {
    addPending: ({ request, outbox_id }: {
      request: ApprovalRequest;
      outbox_id: string;
    }) => {
      try {
        // The approval store's risk_tier is narrower than RiskTier
        // (excludes `'read'`); the upstream-merge request always emits
        // `'destructive'` so the cast is safe. We narrow defensively in
        // case a future caller widens the request shape.
        const tier =
          request.risk_tier === 'destructive'
            ? 'destructive'
            : request.risk_tier === 'admin'
              ? 'admin'
              : 'write';
        approvalStore.add({
          approval_id: request.request_id,
          initiator_instance: serverInstanceId ?? 'recued-server',
          recipe_id: request.recipe_id,
          step_id: request.step_id,
          ingredient_slug: request.ingredient_slug,
          risk_tier: tier,
          description: request.description,
          resolved_input: request.resolved_input,
          timeout_at: 0,
          created_at: Date.now(),
        });
      } catch { /* best-effort */ }
      void outbox_id;
      return request.request_id;
    },
    markResolved: (approval_id: string, decision: 'approve' | 'reject') => {
      try {
        approvalStore.resolve(
          approval_id,
          decision,
          serverInstanceId ?? 'recued-server',
        );
      } catch { /* best-effort */ }
    },
  };

  const audit = (entry: UpstreamMergeAuditEntry): void => {
    // Emit a `kind: 'memory'` audit subkind so D-120 timeline captures
    // the state transition. Best-effort — failures never abort the
    // state-machine driver. The id stamps a composite of (outbox_id,
    // transition, ts) so the audit ledger has unique entries per state
    // hop.
    try {
      eventBus.emit({
        kind: 'memory',
        subkind: 'audit',
        id: `upstream_merge:${entry.outbox_id}:${entry.transition}:${entry.at}`,
      });
    } catch { /* */ }
  };

  const upstreamMergeDeps: UpstreamMergeRpcDeps = {
    store: upstreamMergeStore,
    contactStore,
    vendorMergers,
    vendorConnectionLookup,
    eventBus,
    approvalSink,
    audit,
    // D-138 P5 carry-over — cascade integration for identity change
    // uses the same hook the contact-merge-handler does. Until that
    // hook is wired into bin.ts (TBD alongside D-136 identity-change
    // cascade widening), the upstream-merge driver runs the local
    // merge without cascading per-record enrichments through
    // `cascadeForIdentityChange`. The local store's `setMergedInto` +
    // `linkPlatformId` calls already handle the row-level absorption;
    // perspective-topic enrichments invalidate on the next manual /
    // housekeeping pass.
  };

  return { upstreamMergeDeps, vendorMergers };
};
