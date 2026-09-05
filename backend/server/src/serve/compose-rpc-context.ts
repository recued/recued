import type { ContactMergeScanMode } from '@recued/contracts';
import { createTrustStateStore, type TrustStateStore } from '@recued/approvals';

import type {
  AutoRunSettingsStore,
  CircuitBreakerStore,
  ServerAutoRunHandle,
} from '../auto-run-scheduler.js';
import type { AutoRunRpcDeps } from '../auto-run-handler.js';
import {
  composeContactMergeRpcDeps,
  type ComposeContactMergeRpcDepsInput,
} from '../composition/bin/wire-contact-merge-rpc-deps.js';
import {
  composeEngagementHealthRpcDeps,
  type ComposeEngagementHealthRpcDepsInput,
} from '../composition/bin/wire-engagement-health-rpc-deps.js';
import { liveVendorRegistry } from '../connection-convention-families.js';
import {
  composeHousekeepingRpcDeps,
} from '../composition/bin/wire-housekeeping-substrate.js';
import {
  composeNotificationsRpcDeps,
} from '../composition/bin/wire-notifications-rpc-deps.js';
import {
  composeObservabilityRpcDeps,
  type ObservabilityRpcBundle,
} from '../composition/bin/wire-observability-rpc-deps.js';
import {
  composePackInstallRpcDeps,
} from '../composition/bin/wire-pack-install-rpc-deps.js';
import {
  composePackListRpcDeps,
} from '../composition/bin/wire-pack-list-rpc-deps.js';
import {
  composePackUninstallRpcDeps,
} from '../composition/bin/wire-pack-uninstall-rpc-deps.js';
import {
  composeUpstreamMergeRpcDeps,
  type UpstreamMergeRegistry,
} from '../composition/bin/wire-upstream-merge-rpc-deps.js';
import type { ContactMergeRpcDeps } from '../contact-merge-handler.js';
import type { EngagementHealthDeps } from '../engagement-health-handler.js';
import type { HousekeepingRpcDeps } from '../housekeeping-handler.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { NotificationRpcDeps } from '../notifications-handler.js';
import type { PackInstallRpcDeps } from '../pack-install-handler.js';
import type { PackListRpcDeps } from '../pack-list-handler.js';
import type { PackUninstallRpcDeps } from '../pack-uninstall-handler.js';
import type { UpstreamMergeRpcDeps } from '../upstream-merge-handler.js';
import type { AppContext } from './compose-app-context.js';
import type { ExecutionContext } from './compose-execution-context.js';
import type { StorageContext } from './compose-storage-context.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

export interface ComposeRpcContextOptions {
  storage: Pick<
    StorageContext,
    | 'db'
    | 'recipeStore'
    | 'recordsStore'
    | 'approvalStore'
    | 'eventBus'
    | 'serverInstanceId'
    | 'pairing'
    | 'auditLog'
    | 'checkpointStore'
    | 'commitStore'
    | 'gatedActionStore'
    | 'mcpBodyVisibilityStore'
  >;
  app: Pick<
    AppContext,
    | 'housekeepingConfigRef'
    | 'housekeepingStateRef'
    | 'housekeepingTrustRef'
    | 'housekeepingTunableParamsRef'
    | 'housekeepingLlmResultCacheRef'
    | 'enrichmentStoreRef'
    // D-205 — the D-136 cascade engine. It has been on the AppContext since D-136 and was
    // simply never in this Pick, so the contact-merge composer could not reach it — which
    // is the entire reason `onIdentityChanged` had no supplier and a merge never
    // invalidated the loser's contact-scoped enrichment.
    | 'enrichmentCascadeRef'
    | 'llmConfig'
    | 'resolveLlmConfig'
    | 'llmQuota'
    | 'upstreamMergeStoreRef'
    | 'contactStoreRef'
    | 'connectionStoreRef'
    | 'annotationStoreRef'
    | 'remergePromptStoreRef'
    | 'engagementRateControlStoreRef'
    | 'engagementCapabilityStoreRef'
    | 'contractStoreRef'
    | 'sellerStoreRef'
    | 'webhookConsumerStoreRef'
    | 'chatInboundTokenStoreRef'
  >;
  /** D-163 Slice C — execution-context handle for the
   *  `@recued/notification` block. The block instance lives in
   *  `ExecutionContext` (it threads onto `executeDeps.preflightNotifier`
   *  at compose-execute-deps time); the rpc context reads it here to
   *  build `notificationsDeps` for the three `notifications.*` rpcs.
   *  Absent block ⇒ the bundle drops + every rpc returns
   *  `not_configured`. */
  execution: Pick<ExecutionContext, 'notificationBlock' | 'executeDeps'>;
  schedulerRegistry: ComposeContactMergeRpcDepsInput['schedulerRegistry'];
  upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  setActiveContactMergeScanMode: (mode: ContactMergeScanMode) => void;
  getApiConnectionLookup: ComposeEngagementHealthRpcDepsInput['getApiConnectionLookup'];
  getRefreshAuth: ComposeEngagementHealthRpcDepsInput['getRefreshAuth'];
  getRegisterSalesforceCallEntity:
    ComposeEngagementHealthRpcDepsInput['getRegisterSalesforceCallEntity'];
  circuitStore: CircuitBreakerStore | undefined;
  /** Reactive-substrate slice 1 — the SAME settings-store instance the
   *  scheduler boot consults, so `auto_run.update` writes land where
   *  `refreshRoster` reads. Absent (dbless) → `auto_run.*` surfaces
   *  `not_configured`. */
  autoRunSettingsStore: AutoRunSettingsStore | undefined;
  getAutoRunHandle: () => ServerAutoRunHandle | undefined;
  serverStartedAt?: number;
}

export interface RpcContext {
  housekeepingRpcDeps: HousekeepingRpcDeps | undefined;
  upstreamMergeDeps: UpstreamMergeRpcDeps | undefined;
  upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  contactMergeDeps: ContactMergeRpcDeps | undefined;
  engagementHealthDeps: EngagementHealthDeps | undefined;
  notificationsDeps: NotificationRpcDeps | undefined;
  /** D-145 PA10 follow-on — `packs.install` rpc deps. Composed off the
   *  per-pair `RecipeStore` (required) + the Standing Instructions
   *  store (optional — engine silently skips manifest SI rules when
   *  absent); undefined → `packs.install` surfaces `not_configured`. */
  packInstallDeps: PackInstallRpcDeps | undefined;
  /** D-145 PA10 follow-on — `packs.list` rpc deps. Composed off the
   *  per-pair `RecipeStore` (required for the `installed` join);
   *  undefined → `packs.list` surfaces `not_configured`. Shares no
   *  state with `packInstallDeps` apart from the recipe store handle. */
  packListDeps: PackListRpcDeps | undefined;
  /** D-145 PA10 follow-on Slice B — `packs.uninstall` rpc deps. Composed
   *  off the per-pair `RecipeStore` (required for recipe deletes) + the
   *  Standing Instructions store (optional — engine silently skips SI
   *  prefix delete when absent); undefined → `packs.uninstall` surfaces
   *  `not_configured`. Reuses the same recipe store + SI store handles
   *  as the install + list deps so all three rpcs see the same per-pair
   *  state. */
  packUninstallDeps: PackUninstallRpcDeps | undefined;
  observabilityBundle: ObservabilityRpcBundle;
  /** D-170 N.18 — persisted staged-trust state for recipes installed at runtime. */
  recipeTrustStore: TrustStateStore;
  /** Reactive-substrate slice 1 — `auto_run.{list,update}` rpc deps.
   *  Undefined in dbless harnesses → `not_configured`. */
  autoRunDeps: AutoRunRpcDeps | undefined;
}

export const composeRpcContext = (
  options: ComposeRpcContextOptions,
): RpcContext => {
  const {
    storage,
    app,
    execution,
    schedulerRegistry,
    upstreamMergeRegistry,
    setActiveContactMergeScanMode,
    getApiConnectionLookup,
    getRefreshAuth,
    getRegisterSalesforceCallEntity,
    circuitStore,
    autoRunSettingsStore,
    getAutoRunHandle,
    serverStartedAt = Date.now(),
  } = options;

  // Reactive-substrate slice 1 — `auto_run.*` rpc deps. Gated on the
  // settings + circuit stores (both db-backed); the live handle stays
  // late-bound exactly like the `/status` page's `buildSummary`.
  const autoRunDeps: AutoRunRpcDeps | undefined =
    autoRunSettingsStore && circuitStore
      ? {
          recipeStore: storage.recipeStore,
          settingsStore: autoRunSettingsStore,
          circuitStore,
          getHandle: getAutoRunHandle,
          eventBus: storage.eventBus,
          // D-179 — the managed auto-run config dish rides the SAME dish +
          // continuity stores the executor/scheduler use, so a config set
          // here is exactly what `executeFired` dispatches as.
          ...(execution.executeDeps.dishStore
            ? { dishStore: execution.executeDeps.dishStore }
            : {}),
          ...(execution.executeDeps.dishContextStore
            ? { dishContextStore: execution.executeDeps.dishContextStore }
            : {}),
        }
      : undefined;

  const housekeepingRpcDeps = composeHousekeepingRpcDeps({
    db: storage.db,
    stores: {
      configStore: app.housekeepingConfigRef,
      stateStore: app.housekeepingStateRef,
      trustStore: app.housekeepingTrustRef,
      tunableParamsStore: app.housekeepingTunableParamsRef,
      llmResultCacheStore: app.housekeepingLlmResultCacheRef,
    },
    enrichmentStore: app.enrichmentStoreRef,
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    llmConfig: app.llmConfig,
    resolveLlmConfig: app.resolveLlmConfig,
    llmQuota: app.llmQuota,
    enrichmentProducers: schedulerRegistry.producers(),
    getScheduler: () => schedulerRegistry.getScheduler(),
    // D-187 AMENDMENT — the owner panel's effective-policy display resolves against the
    // OWNER contract's `enrichment.<topic>` grant rows via the unified grant store
    // (stateless wrap of the shared contract store). Absent contract store → omit
    // → registry author defaults.
    ...(app.contractStoreRef
      ? {
          grantEntryStore: createContractGrantEntryStore(
            app.contractStoreRef,
          ),
        }
      : {}),
  });

  const upstreamMergeBundle = composeUpstreamMergeRpcDeps({
    upstreamMergeStore: app.upstreamMergeStoreRef,
    contactStore: app.contactStoreRef,
    connectionStore: app.connectionStoreRef,
    existingRegistry: upstreamMergeRegistry,
    approvalStore: storage.approvalStore,
    eventBus: storage.eventBus,
    serverInstanceId: storage.serverInstanceId,
  });

  const contactMergeBundle = composeContactMergeRpcDeps({
    contactStore: app.contactStoreRef,
    annotationStore: app.annotationStoreRef,
    promptStore: app.remergePromptStoreRef,
    housekeepingState: app.housekeepingStateRef,
    db: storage.db,
    eventBus: storage.eventBus,
    schedulerRegistry,
    setActiveScanMode: setActiveContactMergeScanMode,
    // D-205 — the engine has been on the AppContext all along; it was simply never
    // handed to this composer, which is why `onIdentityChanged` had no supplier and a
    // merge never invalidated the loser's enrichment.
    enrichmentCascade: app.enrichmentCascadeRef,
  });

  const recipeTrustStore = createTrustStateStore(
    createSQLiteCollection(storage.db, 'recipe_trust'),
  );

  const notificationsBundle = composeNotificationsRpcDeps({
    block: options.execution.notificationBlock,
    // D-169 P2 Slice 4 — thread the D-121 bus so a successful
    // `set_bridge_mode` fans out a `notification.bridge_mode_changed`
    // event to the affected bridge's side panel. Optional on the
    // composer: dbless / pre-bus harness omits it + the handler skips
    // the emit.
    eventBus: storage.eventBus,
  });

  // D-145 PA10 follow-on — `packs.install` rpc.
  const packInstallBundle = composePackInstallRpcDeps({
    recipeStore: storage.recipeStore,
    recordsStore: storage.recordsStore,
    webhookConsumerStore: app.webhookConsumerStoreRef,
    // D-139 P6.B — the body-content visibility grant store (created in
    // compose-storage-context over `storage.db`, shared with the foundation
    // pre-install path). A pack declaring `mcp_body_visibility_grants[]`
    // persists them here on install.
    mcpBodyVisibilityStore: storage.mcpBodyVisibilityStore,
    // D-165 P3.1 — thread the gateway-read-only contract store so a
    // successful install records `installed_pack` + `installed_ingredient`
    // inventory. Optional: dbless boots leave it undefined + the handler
    // skips the inventory write.
    contractStore: app.contractStoreRef,
    // D-196 install grant audiences — lets `all_customers` and
    // `all_other_contracts` fan out against the current seller customer rows.
    sellerStore: app.sellerStoreRef,
    inboundTokenStore: app.chatInboundTokenStoreRef,
    // D-145 PA10 follow-on — thread the D-121 bus so successful
    // installs fan out a `pack_installed` event to every paired
    // client's Settings → Packs panel. Optional on the composer:
    // dbless / pre-bus harnesses pass nothing + the handler skips
    // emit.
    eventBus: storage.eventBus,
    recipeTrustStore,
    // D-247 D15 — the preview resolves a recipe's ops to a risk tier through the
    // SAME manifest registry the executor runs against, so the tier the consent
    // surface shows and the tier the gate enforces cannot diverge.
    // ⚠ Conditional because a dbless / partial harness composes an EMPTY
    // `executeDeps`: absent ⇒ the documented `grant_class: 'unknown'` degrade,
    // never a throw from inside a consent surface.
    ...(execution.executeDeps.executorConfig !== undefined
      ? {
          getManifest: (slug: string) =>
            execution.executeDeps.executorConfig.manifests.get(slug) ?? undefined,
        }
      : {}),
    // D-247 D15.1 — the owner's grant rows, so the install applies the access
    // ceiling the owner picked to each recipe's seeded row. Absent (dbless) ⇒
    // the mutation hook's `chat_exposed` seed stands.
    ...(app.contractStoreRef
      ? { grantEntryStore: createContractGrantEntryStore(app.contractStoreRef) }
      : {}),
  });

  // D-145 PA10 follow-on — `packs.list` rpc. Read counterpart to
  // `packs.install`; reuses the same recipe store handle so the
  // `installed` join sees the same per-pair stored rows the install
  // transaction writes against.
  const packListBundle = composePackListRpcDeps({
    recipeStore: storage.recipeStore,
    recordsStore: storage.recordsStore,
    // Packs-route delta 1 — same contract-store handle threaded into
    // `packs.install` / `packs.uninstall` (above/below) so the `installed`
    // join reads the `installed_pack` rows install writes (the canonical
    // signal for empty-`recipes[]` composition / CLI / workflow packs).
    contractStore: app.contractStoreRef,
  });

  // D-145 PA10 follow-on Slice B — `packs.uninstall` rpc. Reverses the
  // install transaction; reuses the same recipe store handle so recipe
  // deletes target the same per-pair rows the install transaction wrote.
  const packUninstallBundle = composePackUninstallRpcDeps({
    recipeStore: storage.recipeStore,
    recordsStore: storage.recordsStore,
    webhookConsumerStore: app.webhookConsumerStoreRef,
    // D-139 P6.B — same body-visibility store as install above so an
    // uninstall revokes the pack's body grants.
    mcpBodyVisibilityStore: storage.mcpBodyVisibilityStore,
    // D-165 P3.1 — same contract-store threading as install above so a
    // successful uninstall drops the pack's inventory rows.
    contractStore: app.contractStoreRef,
    // D-196 — remove pack rollout grants from existing customer bearer
    // snapshots together with the contract rows.
    sellerStore: app.sellerStoreRef,
    inboundTokenStore: app.chatInboundTokenStoreRef,
    // D-145 PA10 follow-on — same bus threading as install above so
    // successful uninstalls fan out `pack_uninstalled` to every
    // subscribed client.
    eventBus: storage.eventBus,
  });

  const engagementHealthBundle = composeEngagementHealthRpcDeps({
    connectionStore: app.connectionStoreRef,
    housekeepingState: app.housekeepingStateRef,
    rateControlStore: app.engagementRateControlStoreRef,
    capabilityStore: app.engagementCapabilityStoreRef,
    getApiConnectionLookup,
    getRefreshAuth,
    getRegisterSalesforceCallEntity,
    // D-192 — live merged registry (built-ins + installed packs), read per rpc so
    // a pack-declared engagement CRM's health surface works with no code edit.
    resolveVendorRegistry: () =>
      liveVendorRegistry(options.execution.executeDeps.localManifestStore),
  });

  const observabilityBundle = composeObservabilityRpcDeps({
    recipeStore: storage.recipeStore,
    approvalStore: storage.approvalStore,
    eventBus: storage.eventBus,
    serverStartedAt,
    db: storage.db,
    auditLog: storage.auditLog,
    checkpointStore: storage.checkpointStore,
    commitStore: storage.commitStore,
    gatedActionStore: storage.gatedActionStore,
    serverInstanceId: storage.serverInstanceId,
    pairing: storage.pairing,
    circuitStore,
    getAutoRunHandle,
    // D-181 §12 — the `/status` lanes line reads live governor occupancy off
    // the SAME in-flight registry the execute deps + `execution.*` rpcs use.
    // Absent registry (dbless / unwired) ⇒ the lanes section is omitted.
    ...(options.execution.executeDeps.inFlightRegistry
      ? {
          getLaneStatus: () =>
            options.execution.executeDeps.inFlightRegistry!.laneStatus(),
        }
      : {}),
  });

  return {
    housekeepingRpcDeps,
    upstreamMergeDeps: upstreamMergeBundle.upstreamMergeDeps,
    upstreamMergeRegistry: upstreamMergeBundle.vendorMergers,
    contactMergeDeps: contactMergeBundle.contactMergeDeps,
    engagementHealthDeps: engagementHealthBundle.engagementHealthDeps,
    notificationsDeps: notificationsBundle.notificationsDeps,
    packInstallDeps: packInstallBundle.packInstallDeps,
    packListDeps: packListBundle.packListDeps,
    packUninstallDeps: packUninstallBundle.packUninstallDeps,
    observabilityBundle,
    recipeTrustStore,
    autoRunDeps,
  };
};
