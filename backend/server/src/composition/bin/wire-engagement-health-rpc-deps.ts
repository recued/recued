/** D-139 P2 — engagement-health rpc-deps composer.
 *
 *  Builds the `EngagementHealthDeps` shape consumed by the
 *  `engagement.health.{read,reprobe}` rpcs. Two pure store passes +
 *  three late-bound closures land here:
 *
 *    1. **`lookupConnection`** — vendor-agnostic api-connection
 *       lookup. Decodes auth + parses config. Reads the cmdServe-local
 *       `apiConnectionLookupRef` at rpc-call time (the vendor substrate
 *       composer assigns the binding a few hundred LOC below in bin.ts).
 *       Throws a descriptive `Error` when the ref is still undefined —
 *       indicates the rpc fired before connection substrate boot
 *       completed.
 *    2. **`refreshAuth`** — OAuth refresh shared with the CRM-trio +
 *       engagement reconcilers. Same late-binding contract as
 *       `lookupConnection`.
 *    3. **`registerSalesforceCallEntity`** (D-184) — on a Salesforce
 *       re-probe, swaps the dual-schema call entity's HOUSEKEEPING task
 *       for the reprobed connection (voice_call ↔ call_history). The
 *       registration logic itself lives in the Salesforce boot wire
 *       (where the engagement store + refresh + housekeeping registry
 *       are in scope); this composer's closure just delegates to the
 *       late-bound `getRegisterSalesforceCallEntity` hook. Replaces the
 *       pre-D-184 path that registered a `reconciler-runonce` runner
 *       (the runonce stopgap is retired).
 *
 *  Late-binding contract: the three refs the rpc closures consume
 *  (`apiConnectionLookupRef`, `refreshApiConnectionAuthRef`,
 *  `registerSalesforceCallEntityRef`) are cmdServe-local `let` bindings
 *  in bin.ts that the vendor substrate composer assigns AFTER this
 *  composer call. The composer takes getter thunks so reads resolve at
 *  rpc-call time rather than composer-call time.
 *
 *  Returns `{ engagementHealthDeps: undefined }` when any of the four
 *  required stores is absent — dbless harnesses leave the slice off
 *  and the engagement-health rpcs return `not_configured`. The
 *  conditional spread shape changes from `...(refs ? {...} : {})` to
 *  `...(engagementHealthDeps ? { engagementHealthDeps } : {})`;
 *  runtime outcome identical. */

import type {
  ConnectionAuth,
  ConnectionRecord,
  ConnectionVendorEntity,
} from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { EngagementCapabilityStore } from '../../storage/engagement-capability-store.js';
import type { EngagementRateControlStore } from '../../storage/engagement-rate-control-store.js';
import type { EngagementHealthDeps } from '../../engagement-health-handler.js';
import type { HousekeepingStateStore } from '../../housekeeping/state-store.js';
import type { ConnectionLookup } from '../../housekeeping/reconciliation/vendor-reconciler.js';

export interface ComposeEngagementHealthRpcDepsInput {
  /** Connection substrate — required. Absent → composer returns the
   *  undefined-bundle and the caller drops the spread. */
  connectionStore: ConnectionStoreSqlite | undefined;
  /** Per-task cursor store — required. Absent → undefined-bundle. */
  housekeepingState: HousekeepingStateStore | undefined;
  /** Engagement rate-control store — required. Absent →
   *  undefined-bundle. */
  rateControlStore: EngagementRateControlStore | undefined;
  /** Engagement capability store — required. Absent →
   *  undefined-bundle. */
  capabilityStore: EngagementCapabilityStore | undefined;
  /** Late-bound api-connection lookup getter. Reads the cmdServe-
   *  local `apiConnectionLookupRef` at rpc-call time. Returns
   *  undefined until the vendor substrate composer assigns the
   *  binding; the rpc closure throws when that happens. */
  getApiConnectionLookup: () => ConnectionLookup | undefined;
  /** Late-bound auth-refresh getter. Same contract as
   *  getApiConnectionLookup. */
  getRefreshAuth: () =>
    | ((connection: ConnectionRecord) => Promise<ConnectionAuth>)
    | undefined;
  /** D-184 — late-bound Salesforce call-entity registration hook. The
   *  Salesforce boot wire surfaces it on its `VendorBootBundle`; the
   *  reprobe rpc invokes it to swap the dual-schema call entity's
   *  housekeeping task per connection. Returns undefined until the
   *  vendor substrate boot publishes the ref (db-less / pre-boot). */
  getRegisterSalesforceCallEntity: () =>
    EngagementHealthDeps['registerSalesforceCallEntity'];
  /** D-192 — late-bound live merged vendor-entity registry accessor. Drives the
   *  registry-facet-based health surface (vendor gating + entity surface +
   *  streaming gates) so a pack-declared engagement CRM's health works with no
   *  code edit. Omit → the handler falls back to the shipped built-ins. */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
}

export interface EngagementHealthRpcBundle {
  /** Threaded into `createServerHandlerSet({ engagementHealthDeps })`.
   *  Undefined when any required store is missing → caller drops the
   *  conditional spread. */
  engagementHealthDeps: EngagementHealthDeps | undefined;
}

export const composeEngagementHealthRpcDeps = (
  input: ComposeEngagementHealthRpcDepsInput,
): EngagementHealthRpcBundle => {
  const {
    connectionStore,
    housekeepingState,
    rateControlStore,
    capabilityStore,
    getApiConnectionLookup,
    getRefreshAuth,
    getRegisterSalesforceCallEntity,
    resolveVendorRegistry,
  } = input;

  if (
    !connectionStore
    || !housekeepingState
    || !rateControlStore
    || !capabilityStore
  ) {
    return { engagementHealthDeps: undefined };
  }

  const lookupConnection: ConnectionLookup = async (name: string) => {
    const ref = getApiConnectionLookup();
    if (!ref) {
      throw new Error(
        'engagementHealth: connection lookup not initialized — cmdServe() has not yet '
          + 'wired the api-connection lookup helper. This indicates the rpc fired before '
          + 'connection substrate boot completed.',
      );
    }
    return ref(name);
  };

  const refreshAuth = async (
    connection: ConnectionRecord,
  ): Promise<ConnectionAuth> => {
    const ref = getRefreshAuth();
    if (!ref) {
      throw new Error(
        'engagementHealth: refresh-auth helper not initialized — cmdServe() has not yet '
          + 'wired the OAuth refresh path. This indicates the rpc fired before '
          + 'connection substrate boot completed.',
      );
    }
    return ref(connection);
  };

  // D-184 — on reprobe, swap the dual-schema call entity's HOUSEKEEPING
  // task for the reprobed connection (voice_call ↔ call_history). The
  // actual registration logic lives in the Salesforce boot wire (where the
  // engagement store + refresh + housekeeping registry are in scope); this
  // closure just delegates to the late-bound hook. Replaces the pre-D-184
  // runonce-runner swap. No-op until the vendor substrate boot publishes
  // the ref (db-less / pre-boot) — the reprobe still persists capabilities;
  // the call task appears once the boot ref is live.
  const registerSalesforceCallEntity = async (input: {
    connection: ConnectionRecord;
    winner: 'voice_call' | 'call_history' | null;
    prior: 'voice_call' | 'call_history' | null;
  }): Promise<void> => {
    const hook = getRegisterSalesforceCallEntity();
    if (hook) await hook(input);
  };

  const engagementHealthDeps: EngagementHealthDeps = {
    connectionStore,
    housekeepingState,
    rateControlStore,
    capabilityStore,
    lookupConnection,
    refreshAuth,
    registerSalesforceCallEntity,
    ...(resolveVendorRegistry ? { resolveVendorRegistry } : {}),
  };

  return { engagementHealthDeps };
};
