import {
  composeVendorSubstrate as composeWireVendorSubstrate,
  type VendorSubstrateBundle,
} from '../composition/bin/wire-vendor-substrate.js';
import type { EventBus } from '../events/bus.js';
import type { UpstreamMergeRegistry } from '../data/vendor-boot-registry.js';
import type { AppContext } from './compose-app-context.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { AuditLogStore } from '@recued/storage';

export type VendorSubstrateAppContext = Pick<
  AppContext,
  | 'connectionStoreRef'
  | 'keys'
  | 'engagementStoreRef'
  | 'enrichmentStoreRef'
  | 'crmRecordMirrorStoreRef'
  | 'contactStoreRef'
  | 'upstreamMergeStoreRef'
  | 'warehouseBus'
>;

export interface ComposeVendorSubstrateContextOptions {
  /** D-269 step 1 — the owner's declared server zone for D-139 § A.3.7's
   *  engagement timezone fallback. */
  prefsTimezone?: () => string | null | undefined;
  readonly app: VendorSubstrateAppContext;
  readonly upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'> | undefined;
  readonly eventBus: EventBus;
  readonly backgroundServices: BackgroundServiceRegistry;
}

export interface VendorSubstratePublishedRefs {
  readonly apiConnectionLookup: VendorSubstrateBundle['lookupConnection'];
  readonly refreshApiConnectionAuth: VendorSubstrateBundle['refreshAuth'];
  readonly registerSalesforceCallEntity?: NonNullable<
    VendorSubstrateBundle['registerSalesforceCallEntity']
  >;
}

export const composeVendorSubstrateContext = async (
  options: ComposeVendorSubstrateContextOptions,
): Promise<VendorSubstratePublishedRefs | undefined> => {
  const {
    app,
    upstreamMergeRegistry,
    auditLog,
    eventBus,
    backgroundServices,
  } = options;
  if (!app.connectionStoreRef) return undefined;

  const vendorBundle = await composeWireVendorSubstrate({
    connectionStore: app.connectionStoreRef,
    keys: app.keys,
    engagementStore: app.engagementStoreRef,
    // D-269 — D-139 § A.3.7's third fallback step, finally supplied.
    ...(options.prefsTimezone ? { prefsTimezone: options.prefsTimezone } : {}),
    enrichmentStore: app.enrichmentStoreRef,
    crmRecordMirror: app.crmRecordMirrorStoreRef,
    contactStore: app.contactStoreRef,
    upstreamMergeStore: app.upstreamMergeStoreRef,
    upstreamMergeRegistry,
    auditLog,
    warehouseBus: app.warehouseBus,
    eventBus,
  });

  if (vendorBundle.stop !== undefined) {
    backgroundServices.register({
      name: 'vendor-substrate',
      kind: 'emitter',
      stop: vendorBundle.stop,
    });
  }

  return {
    apiConnectionLookup: vendorBundle.lookupConnection,
    refreshApiConnectionAuth: vendorBundle.refreshAuth,
    ...(vendorBundle.registerSalesforceCallEntity !== undefined
      ? { registerSalesforceCallEntity: vendorBundle.registerSalesforceCallEntity }
      : {}),
  };
};
