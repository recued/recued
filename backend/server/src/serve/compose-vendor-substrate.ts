import {
  composeVendorSubstrate as composeWireVendorSubstrate,
  type VendorSubstrateBundle,
} from '../composition/bin/wire-vendor-substrate.js';
import type { EventBus } from '../events/bus.js';
import type { UpstreamMergeRegistry } from '../data/vendor-boot-registry.js';
import type { AppContext } from './compose-app-context.js';

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
  readonly app: VendorSubstrateAppContext;
  readonly upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  readonly eventBus: EventBus;
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
  const { app, upstreamMergeRegistry, eventBus } = options;
  if (!app.connectionStoreRef) return undefined;

  const vendorBundle = await composeWireVendorSubstrate({
    connectionStore: app.connectionStoreRef,
    keys: app.keys,
    engagementStore: app.engagementStoreRef,
    enrichmentStore: app.enrichmentStoreRef,
    crmRecordMirror: app.crmRecordMirrorStoreRef,
    contactStore: app.contactStoreRef,
    upstreamMergeStore: app.upstreamMergeStoreRef,
    upstreamMergeRegistry,
    warehouseBus: app.warehouseBus,
    eventBus,
  });

  return {
    apiConnectionLookup: vendorBundle.lookupConnection,
    refreshApiConnectionAuth: vendorBundle.refreshAuth,
    ...(vendorBundle.registerSalesforceCallEntity !== undefined
      ? { registerSalesforceCallEntity: vendorBundle.registerSalesforceCallEntity }
      : {}),
  };
};
