import {
  MEMORY_RETENTION_DEFAULT_DAYS,
  defaultDdnsZone,
  zoneByLabel,
  type Checkpoint,
  type Commit,
  type RecuedPlan,
} from '@recued/contracts';
import { RUNTIME_SCHEMA_MAP } from '@recued/config';
import type { RuntimeConfigStore } from '@recued/config';
import {
  createAuditLogStore,
  createCheckpointStore,
  createCommitStore,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
  type RecuedPlanStore,
  type VaultStore,
} from '@recued/storage';
import type Database from 'better-sqlite3';
import { createMailWorkStore, type MailWorkStore } from '../storage/mail-work-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import {
  MCP_ACTION_TABLE,
  createMcpActionStore,
  createSqliteMcpActionCompareAndSet,
  type McpActionRecord,
  type McpActionStore,
} from '../mcp-action-store.js';
import {
  GATED_ACTION_TABLE,
  createGatedActionStore,
  createSqliteGatedActionChangeClock,
  createSqliteGatedActionCompareAndSet,
  type GatedActionRecord,
  type GatedActionStore,
} from '../gated-action-store.js';
import {
  createSettledRunResults,
  type SettledRunResults,
} from '../settled-run-results.js';

import type { ServerAccountStore } from '../account-store.js';
import { createServerAccountStore } from '../account-store.js';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { copyDatabaseForSnapshot, openDatabase } from '../open-database.js';
import { SERVER_VERSION } from '../server-version.js';
import { deriveInFlightEntry } from '../update/apply-orchestrator.js';
import {
  legacyRealmSnapshotPath,
  prepareRealmForRelease,
  readReleaseGenerationTransition,
  realmSnapshotMatchesTransition,
  realmSnapshotPath,
  snapshotRealmOnNewRelease,
  writeReleaseGenerationTransition,
} from '../update/realm-generation-snapshot.js';
import {
  completeSnapshotReceiptEpochAfterKeyedOpen,
  consumePendingSnapshotRestore,
  markSnapshotRestorePending,
  reconcileSnapshotReceiptEpochBeforeOpen,
} from '../update/binary-apply-executor.js';
import { resolveUpdateBinaryPath } from '../update/install-paths.js';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from '../update/update-ledger.js';
import {
  createAuditRetention,
  type AuditRetention,
  type AuditRetentionConfig,
} from '../audit-retention.js';
import { createSigningAuditLog } from '../audit/signing.js';
import { createDrainableAuditLog } from '../audit/drainable.js';
import {
  consumeDroppedWritesMarker,
  droppedWritesMarkerPath,
  writeDroppedWritesMarker,
} from '../audit/dropped-writes-marker.js';
import { createApprovalStore, type ApprovalStore } from '../approval-handler.js';
import { composeRecuedPlanStore } from '../composition/bin/wire-recued-plan-store.js';
import type { FileStack } from '../collections/file/compose.js';
import { composeFileBoot } from '../composition/bin/wire-file-stack.js';
import {
  composePerPairStores,
  type PerPairStoresBundle,
} from '../composition/bin/wire-per-pair-stores.js';
import { createEventBus, type EventBus } from '../events/bus.js';
import {
  emitApprovalPending,
  emitApprovalResolved,
} from '../events/emit-sites.js';
import { bootServerIdentity, type BootedServerIdentity } from '../identity/boot.js';
import { CONTAINER_UNSEALED_REFUSAL } from '../identity/passphrase-env.js';
import { runningInContainer } from '../lifecycle/supervisor.js';
import {
  createAccountBindingManager,
  type AccountBindingManager,
} from '../account-binding/manager.js';
import { createHttpAccountBindingExchangeClient } from '../account-binding/exchange-client.js';
import { resolveAccountBindingExchangeUrl } from '../account-binding/exchange-url.js';
import {
  buildProvisionedSnapshot,
  createProConvenienceProvisioner,
  type ProConvenienceProvisioner,
  type ProvisionedConvenienceSnapshot,
} from '../pro-convenience/provisioner.js';
import {
  createHttpProEntitlementSource,
  resolveProEntitlementMintUrl,
  resolveProEntitlementPublicKey,
} from '../pro-convenience/entitlement-source.js';
import { createSqliteHandleStateStore } from '../handle/sqlite-store.js';
import { createSqliteDdnsIpStateStore } from '../ddns/ip-state-store.js';
import type { HandleStateStore } from '../handle/index.js';
import { createSqliteDdnsEnabledStore } from '../ddns/ddns-enabled-store.js';
import { createDdnsUpdateClient } from '../ddns/update-client.js';
import type { DdnsHandlerDeps } from '../ddns-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createContractStore } from '../storage/contract-store.js';
import { createTrustStateStore } from '@recued/approvals';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import {
  createDraftStore,
  type DraftStore,
} from '../ingredient-authoring/draft-store.js';
import {
  ensureCheckpointSchema,
  ensureCommitSchema,
  ensureMemorySchema,
} from '../memory-schema.js';
import { backfillRecipeInsights } from '../memory-backfill.js';
import { createPairingManager, type PairingManager } from '../pairing.js';
import { createPairingStateStore } from '../pairing-state-store.js';
import type { PairedInstancesStore } from '../paired-instances-store.js';
import type { RecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import {
  createPressureStateStore,
  reconcilePressureStateAtBoot,
  type PressureStateStore,
} from '../pressure-state.js';
import {
  createMcpBodyVisibilityStore,
  type McpBodyVisibilityStore,
} from '../storage/mcp-body-visibility-store.js';
import {
  createServerVaultStore,
  listVaultPublishers,
  loadVaultAsObject,
} from '../server-vault.js';
import {
  resolveLLMConfigFromEnv,
  resolveVaultFromEnv,
  mergeVault,
} from '../server-executor.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { readAuditUsageBytes } from '../audit-usage-counter.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createPreapprovalStorage, type PreapprovalStorage } from '../storage/preapproval-storage.js';
import { preapprovalLimitsFromEnvironment } from '../preapproval-limits.js';
import {
  computeInitialUsage,
  createGateRegistry,
  type GateRegistry,
} from '../storage-gates.js';
import {
  createHostnameRegistryStore,
  type HostnameRegistryStore,
} from '../storage/hostname-registry.js';
import {
  createCloudReachabilityProber,
  createPublicAddressService,
  createSqlitePublicAddressStore,
  type PublicAddressService,
} from '../public-address.js';
import { resolveCloudApex } from '../account-binding/exchange-url.js';
import type { BaseVaultQuotas } from './compose-base-context.js';
import type { BootTrace } from '../cli/boot-trace.js';
import {
  createRecordsStore,
  createRecordsImportAuditEmitter,
  type RecordsChangeNotice,
  type RecordsImportAudit,
  type RecordsStore,
} from '../records/index.js';

type PerPairStore<K extends keyof PerPairStoresBundle> =
  PerPairStoresBundle[K] | undefined;

export interface ComposeStorageContextOptions {
  dbPath: string;
  bootTrace: BootTrace;
  runtimeConfig: RuntimeConfigStore;
  vaultQuotas: BaseVaultQuotas;
  /** Slice 4 — lazy vault key provider (`keys.keyProvider('vault')`).
   *  Late-bound: returns the `sub_dek.vault` bytes once the server is
   *  unlocked, or null while locked. When supplied, the vault is keyed by
   *  the Master DEK (no plaintext `server_dek`) and its boot-time load is
   *  locked-tolerant — persisted creds load on the post-unlock re-init. */
  getVaultKey?: () => Uint8Array | null;
  /** The serve boot reconciles any interrupted restore immediately before
   *  storage composition. This explicit handoff lets the database chokepoint
   *  open when only an unresolved CAS park deliberately keeps the marker. */
  restoreJournalReconciled?: boolean;
}

export interface StorageContext {
  db: Database.Database;
  preapprovalStorage: PreapprovalStorage;
  mailWorkStore: MailWorkStore;
  manifests: ManifestRegistry;
  /** D-170 — persistent body store for locally-authored (decomposed)
   *  catalog / ingredient / entity-schema manifests. Boot re-registers its
   *  manifests into `manifests` so the gateway resolves them (N.16). */
  localManifestStore: LocalManifestStore;
  /** D-170 N.4 / N.15 — per-pair in-progress composition draft store. Backs
   *  `ingredient.draft.{save,list,get,delete}` + the test-before-save preview;
   *  unlike `localManifestStore` it is NOT boot-registered into `manifests` (a
   *  draft is not yet an installed capability). */
  draftStore: DraftStore;
  recipeStore: RecipeStore;
  /** D-221 — core-owned, publisher/pack-namespaced Records authority. */
  recordsStore: RecordsStore;
  eventBus: EventBus;
  approvalStore: ApprovalStore;
  fileStack: FileStack | undefined;
  envLlmConfig: ReturnType<typeof resolveLLMConfigFromEnv>;
  readonly vaultStore: VaultStore | undefined;
  readonly baseVault: Record<string, unknown>;
  initVault: () => Promise<void>;
  pairing: PairingManager | undefined;
  serverInstanceId: string;
  pairedInstances: PairedInstancesStore | undefined;
  recoveryKeyCheck: RecoveryKeyCheckStore | undefined;
  auditLog: AuditLogStore | undefined;
  /** Terminal lifecycle flush for every admitted audit append, including
   * intentionally detached activity telemetry. */
  drainAuditWrites?: (() => Promise<void>) | undefined;
  readonly signingIdentity: BootedServerIdentity | undefined;
  bootSigningIdentity: () => Promise<void>;
  /** D-175 P5 — recued.com account-binding manager. Always constructed
   *  (matches the audit-log / RecuedPlan signing-wrapper pattern); its
   *  `getServerIdentity` / `getKeyStore` resolvers throw `not_ready`
   *  before `bootSigningIdentity()` completes. composeListeners forwards
   *  it as `accountBindingDeps.manager` so `account.bind` / `unbind` /
   *  `bindingStatus` dispatch against it. */
  accountBindingManager: AccountBindingManager;
  /** D-175 P8 — Pro convenience provisioner. Always constructed; reads
   *  the binding via `accountBindingManager.status()` (secret-free) and
   *  gates on the Worker-minted, locally verified Pro entitlement claim.
   *  composeListeners
   *  forwards it as `proConvenienceDeps.provisioner` so
   *  `pro_convenience.status` dispatches against it. */
  proConvenienceProvisioner: ProConvenienceProvisioner;
  /** R27 delta-B — DDNS pause/resume handler deps (the server-local publish
   *  flag + handle-state target resolver + cloud-pause client). composeListeners
   *  forwards it as `ddnsDeps` so `ddns.status` / `ddns.setEnabled` dispatch
   *  against it. The cloud-pause client + signer are bound lazily (first call,
   *  post-boot) so the signing identity + cloud URL are ready. */
  ddnsHandlerDeps: DdnsHandlerDeps;
  /** D-145 PB13 — signing-wrapped RecuedPlan store. Always constructed
   *  (matches the audit-log signing wrapper pattern); the underlying
   *  `getServerIdentity` resolver throws if the boot hasn't finished
   *  yet, so direct callers must wait for `bootSigningIdentity()` to
   *  complete before invoking `append`. Future consumers (the
   *  un-implemented `context_packet_quality` PA9 producer, post-PB14
   *  engine wiring) pull the store from here. */
  recuedPlanStore: RecuedPlanStore;
  /** D-145 PB13 — callback shape compatible with
   *  `ExecuteRecuedRequestContext.persist?` in
   *  `packages/middleware/src/orchestrator/execute-recued-request.ts`.
   *  Pre-bound to the signing store's `append`. The D-173 reception
   *  compose-propose path is the live producer — it threads this
   *  through `executeRecuedRequest` so a `RecuedPlan` persists per
   *  compose request. */
  executeRecuedRequestPersist: (plan: RecuedPlan) => Promise<void>;
  commitStore: CommitStore | undefined;
  checkpointStore: CheckpointStore | undefined;
  /** One generic JSON table carrying token-bound deferred MCP results. */
  mcpActionStore: McpActionStore;
  /** Owner-facing, operation-scoped receipts for checkpointed gated steps. */
  gatedActionStore: GatedActionStore;
  /** What an owner's page-started run answered once its approval let it
   *  finish — written by the approval resumer, read by `execution.get`.
   *  In memory: a courtesy to an open page, not a record. */
  settledRunResults: SettledRunResults;
  workEntityStoreRef: PerPairStore<'workEntityStore'>;
  s2sPreviewStoreRef: PerPairStore<'s2sPreviewStore'>;
  correctionEventsStoreRef: PerPairStore<'correctionEventsStore'>;
  publicEndpointRegistryStoreRef: PerPairStore<'publicEndpointRegistryStore'>;
  receptionRegistryCacheRef: PerPairStore<'receptionRegistryCache'>;
  receptionRateLimiterRef: PerPairStore<'receptionRateLimiter'>;
  previewHashStoreRef: PerPairStore<'previewHashStore'>;
  schedulingFormNonceStoreRef: PerPairStore<'schedulingFormNonceStore'>;
  intakeFormDefinitionStoreRef: PerPairStore<'intakeFormDefinitionStore'>;
  intakeRecipePairStoreRef: PerPairStore<'intakeRecipePairStore'>;
  intakeFormSubmissionStoreRef: PerPairStore<'intakeFormSubmissionStore'>;
  formResponseStoreRef: PerPairStore<'formResponseStore'>;
  /** D-315 — mail templates, facts and things. */
  mailFactStoreRef: PerPairStore<'mailFactStore'>;
  intakeFormNonceStoreRef: PerPairStore<'intakeFormNonceStore'>;
  dropBlobStoreRef: PerPairStore<'dropBlobStore'>;
  dropLinkNonceStoreRef: PerPairStore<'dropLinkNonceStore'>;
  approvalIntentStoreRef: PerPairStore<'approvalIntentStore'>;
  approvalLinkNonceStoreRef: PerPairStore<'approvalLinkNonceStore'>;
  statusProjectionStoreRef: PerPairStore<'statusProjectionStore'>;
  ipBlockStoreRef: PerPairStore<'ipBlockStore'>;
  accountStore: ServerAccountStore | undefined;
  hostnameRegistryStore: HostnameRegistryStore;
  /** The addresses the internet reaches this server at — every link, vendor
   *  sign-in and claim reads them here (`public-address.ts`). The listener
   *  binds its facts; the post-listener runtime runs the probe rounds. */
  publicAddress: PublicAddressService;
  /** D-269 step 1 — the server's own timezone (mode + declared zone). Read by
   *  every wall-clock surface when no live client supplies one. */
  serverTimeZoneStore: import('../storage/server-timezone-store.js').ServerTimeZoneStore;
  /** D-269 step 2 — the per-kind notification policy the due-status sweep reads. */
  notificationKindPolicyStore: import('../storage/notification-kind-policy-store.js').NotificationKindPolicyStore;
  /** D-269 step 3 — the one quiet-hours window. */
  quietHoursStore: import('../storage/quiet-hours-store.js').QuietHoursStore;
  gateRegistry: GateRegistry | undefined;
  auditRetention: AuditRetention | undefined;
  pressureState: PressureStateStore | undefined;
  /** D-139 P6.B — MCP body-content visibility grant store. Created here
   *  (before pre-install) so a foundation pack that ships
   *  `mcp_body_visibility_grants[]` persists them at boot. The rpc-deps
   *  composer builds its own ref over the same db handle (shared storage). */
  mcpBodyVisibilityStore: McpBodyVisibilityStore | undefined;
}

/** Read `cloud.base_url` defensively — the binding-exchange URL resolver
 *  no longer reads it — the apex is `RECUED_CLOUD_APEX`.
 *  The key carries a schema default, but a missing / non-string value
 *  must not throw on the binding hot path (it just falls back to prod). */
const readCloudBaseUrl = (
  runtimeConfig: RuntimeConfigStore,
): string | undefined => {
  try {
    const value = runtimeConfig.get('cloud.base_url');
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const storagePathIdentity = (path: string): string => {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const composeStorageContext = async (
  options: ComposeStorageContextOptions,
): Promise<StorageContext> => {
  const { dbPath, bootTrace, runtimeConfig, vaultQuotas, getVaultKey } = options;

  // A snapshot restore can rewind receipt change sequences. Its two-phase
  // journal is reconciled before the first handle, then completed only after
  // the canonical encrypted/keyless open has supplied the correct key.
  reconcileSnapshotReceiptEpochBeforeOpen(dbPath);

  // ⛔ BEFORE THE FIRST DATABASE HANDLE. A rollback swaps the host executable,
  // not one realm, so a realm that did not initiate it may still hold the newer
  // schema. Its generation-bound snapshot is the only safe bridge back.
  const updateBinaryPath = resolveUpdateBinaryPath(process.env);
  let transition = readReleaseGenerationTransition(updateBinaryPath);

  // A deployed N-1 release predates the host-generation witness but still left
  // a complete apply ledger and pre-migration snapshot. Reconstruct the exact
  // transition before downgrade preparation or the first database handle, so a
  // stale scoped marker cannot make recovery refuse before it sees the proof.
  // A malformed or unreadable ledger remains fail-closed below.
  let inFlightApply = false;
  try {
    const ledgerPath = join(dirname(resolve(dbPath)), UPDATE_LEDGER_FILE);
    if (existsSync(ledgerPath)) {
      const entry = deriveInFlightEntry(createUpdateLedger(ledgerPath));
      if (entry !== null) {
        if (
          transition === null
          && entry.to_version === SERVER_VERSION
          && typeof entry.migration === 'boolean'
        ) {
          transition = {
            schema: 1,
            from_version: entry.from_version,
            to_version: entry.to_version,
            migration: entry.migration,
          };
          writeReleaseGenerationTransition(updateBinaryPath, transition);
        }
        const scopedSnapshot = storagePathIdentity(realmSnapshotPath(dbPath));
        const legacySnapshot = storagePathIdentity(legacyRealmSnapshotPath(dbPath));
        const declaredSnapshot = typeof entry.snapshot_ref === 'string'
          ? storagePathIdentity(entry.snapshot_ref)
          : null;
        if (declaredSnapshot === scopedSnapshot) {
          inFlightApply = true;
        } else if (
          entry.migration === true
          && (declaredSnapshot === null || declaredSnapshot === legacySnapshot)
        ) {
          // A deployed N-1 entry did not carry a scoped owner. While its flat
          // snapshot exists, the snapshot module performs the conservative
          // single-SQLite-realm proof. After adoption, only the realm whose
          // scoped metadata matches this transition remains the applying realm.
          inFlightApply = existsSync(legacySnapshot)
            || (transition !== null && realmSnapshotMatchesTransition(dbPath, transition));
        }
      }
    }
  } catch {
    // Unreadable means an apply may be in flight. Skipping a fresh snapshot is
    // safer than overwriting a real pre-migration recovery copy before DDL.
    inFlightApply = true;
  }

  const prepared = await prepareRealmForRelease({
    dbPath,
    releaseIdentity: SERVER_VERSION,
    transition,
    restoreSnapshot: (snapshotPath) => {
      markSnapshotRestorePending(dbPath, snapshotPath);
      const restored = consumePendingSnapshotRestore(
        dbPath,
        (from, to) => copyFileSync(from, to),
        (message) => console.error(`[update] ${message}`),
      );
      if (!restored.restored) throw new Error('the generation-bound snapshot restore did not complete');
    },
  });
  if (prepared.action === 'downgrade-prepared') {
    console.error(
      `[update] prepared this realm for host rollback ${prepared.from} → ${prepared.to}`
      + (prepared.restoredSnapshot ? ' (pre-migration snapshot restored)' : ''),
    );
  }

  bootTrace.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath, {
    restoreJournalReconciled: options.restoreJournalReconciled === true,
  });
  try {
    completeSnapshotReceiptEpochAfterKeyedOpen(dbPath, db);
  } catch (error) {
    db.close();
    throw error;
  }
  db.pragma('journal_mode = WAL');
  // D-212 slice 0 — the page-cache ceiling. Ships independently of the rest of
  // the at-rest-encryption arc because it is a free win TODAY and it is what
  // makes every later step of that arc cost ~nothing on reads.
  //
  // SQLite's default is ~2 MB, which is the worst case for a workload like this
  // one: `records`-shaped tables plus FTS5, where a scan re-reads the same pages.
  // Measured (`scripts/bench-at-rest-encryption.mjs`, 20k rows), encrypted vs
  // plain at the DEFAULT cache: timeline scan +131%, warm point read +212%,
  // FTS5 +8.3%. At 20 MB every one of those is statistical NOISE, and by 64 MB
  // writes fall from +30% to +5.4%. Unencrypted it is simply free headroom.
  //
  // ⚠ NEGATIVE value = KIBIBYTES (SQLite convention), not pages. And it is a
  // CEILING, not a reservation: the page cache grows lazily, so a small database
  // on a constrained 1-click VPS never allocates 64 MB. Lower it only if a host
  // genuinely cannot spare the ceiling.
  db.pragma('cache_size = -64000');
  db.pragma('foreign_keys = ON');
  bootTrace.mark('db-opened');

  // ⛔ BEFORE ANY STORE IS CONSTRUCTED. Store setup is what runs the schema DDL,
  // and not all of it is additive — it DROPs columns. A realm meeting a binary
  // generation it has never run gets its own pre-migration copy first, so the
  // ordinary "stop the server, back up, update, restore" workflow and a second
  // `--db` path are covered by the same rule. `realm-generation-snapshot.ts`
  // says why the realm that ran the update is deliberately excluded.
  await snapshotRealmOnNewRelease({
    dbPath,
    releaseIdentity: SERVER_VERSION,
    transition,
    hasInFlightApply: () => inFlightApply,
    takeSnapshot: (destination) => copyDatabaseForSnapshot(db, destination),
  });

  bootTrace.mark('shared-setup-start');

  const manifests = createManifestRegistry(undefined, db);
  // D-170 — local manifest body store + boot preload. Persisted locally-authored
  // catalog / ingredient bodies are re-registered into the live `manifests`
  // registry so the gateway resolves their operations on this boot exactly as
  // for a marketplace ingredient (N.16). The install-time slug-conflict guard
  // refuses authoring over any slug already present in the registry, so at
  // install time a local body never collides with a bundled disk manifest.
  // KNOWN LIMITATION (cross-release only): if a later server release bundles a
  // disk manifest under a slug a user previously authored locally, this register
  // shadows the bundled one with the local body (Map.set), and uninstalling the
  // local catalog then drops the slug outright until the next restart re-loads
  // the bundled file. A two-layer (bundled vs local) registry would restore the
  // bundled fallback in-process; deferred as out of scope for the install core.
  const localManifestStore = createLocalManifestStore(db);
  for (const manifest of localManifestStore.listManifests()) {
    manifests.register(manifest);
  }
  // D-259 launch reconciliation + the current-validator check run later in
  // `composeListeners`, after the contract store and composition provisioner
  // exist but before listener construction. Checking here would warn about a
  // legacy body moments before that safe reconciliation repairs it.
  // D-170 N.4 / N.15 — draft store shares the per-pair db. No boot-register
  // step: a draft is an in-progress composition, not an installed capability.
  const draftStore = createDraftStore(db);
  const recipeStore = createRecipeStore(undefined, db);
  // D-221 — the import-audit sink is LATE-BOUND because the records store is
  // built here and the audit log only exists ~70 lines below (it needs the gate
  // registry and the signing identity). Reordering either is a bigger change
  // than a one-line indirection.
  //
  // ⛔ AN UNASSIGNED SINK IS SILENCE — a bulk write over the owner's data with
  // no durable record, and nothing anywhere would say so. The assignment below
  // is asserted by `records-import-audit.test.ts` against THIS composer, not
  // against a hand-built store, precisely because "someone forgot to wire it"
  // is the failure this shape invites.
  let emitRecordsImportAudit: ((event: RecordsImportAudit) => void) | undefined;
  // ⛔⛔ D-282 B4 — THE SECOND UNWIRED SINK IN THIS FILE'S HISTORY. `packs-panel.ts`
  // has declared and implemented `refreshAppView()` since the Use tab shipped and
  // nothing ever called it, so a write by a schedule, a webhook, the AI, a peer or
  // the owner's other device left every open pack view stale until its tab was
  // re-selected. The same late-assignment shape as the audit sink above, for the
  // same reason: the store is constructed before the bus exists, and reordering the
  // two is a bigger change than a one-line indirection.
  //
  // ⚠ The assignment below is asserted by `records-change-broadcast.test.ts` against
  // THIS composer, never a hand-built store — an unwired sink is silence, and this
  // slice exists because that silence lasted.
  let emitRecordsChange: ((event: RecordsChangeNotice) => void) | undefined;
  const recordsStore = createRecordsStore(db, {
    onImport: (event) => emitRecordsImportAudit?.(event),
    onChange: (event) => emitRecordsChange?.(event),
  });
  const eventBus = createEventBus();
  emitRecordsChange = (event) => {
    try {
      eventBus.emit({
        kind: 'records',
        publisher: event.owner.publisher,
        pack_slug: event.owner.pack_slug,
        entity: event.entity,
        op: event.op,
        id: event.id,
      });
    } catch {
      /* never abort a write that already committed on bus failure */
    }
  };
  const approvalStore = createApprovalStore(undefined, {
    onPending: (id) => emitApprovalPending(eventBus, id),
    onResolved: (id) => emitApprovalResolved(eventBus, id),
  });
  const fileStack: FileStack | undefined = composeFileBoot({ db });
  const envLlmConfig = resolveLLMConfigFromEnv();

  let gateRegistry: GateRegistry | undefined;
  let vaultStore: VaultStore | undefined;
  let baseVault: Record<string, unknown> = {};

  const initVault = async (): Promise<void> => {
    const envVault = resolveVaultFromEnv();
    vaultStore = await createServerVaultStore(db, {
      quotas: vaultQuotas,
      onBytesChanged: (delta) => {
        if (gateRegistry) gateRegistry.vault.addUsed(delta);
      },
      // Slice 4 — Master-DEK-keyed lazy vault (no plaintext server_dek)
      // when a key provider is wired. Absent ⇒ legacy per-server DEK.
      ...(getVaultKey ? { getEncryptionKey: getVaultKey } : {}),
    });
    const publishers = await listVaultPublishers(db);
    // Locked-tolerant: at first-boot vault load the Master DEK isn't
    // unlocked yet (unlock runs later, behind the lifecycle lock), so the
    // lazy store throws. Persisted creds load on the post-unlock re-init;
    // env vault is available now. Any non-locked error still propagates.
    let persisted: Record<string, Record<string, string>> = {};
    try {
      persisted = await loadVaultAsObject(vaultStore, publishers);
    } catch (err) {
      if (!(err instanceof Error && /locked|vault key unavailable/i.test(err.message))) {
        throw err;
      }
    }
    baseVault = mergeVault(persisted, envVault);
    if (gateRegistry) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(length(data)), 0) AS total FROM server_vault`,
        )
        .get() as { total: number };
      gateRegistry.vault.setUsed(row.total);
    }
  };

  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const realmRow = db.prepare(`SELECT value FROM server_config WHERE key = 'realm_token'`).get() as { value: string } | undefined;
  // Shared with `recued pair` through `server_config`, so a refresh from the
  // CLI reaches THIS manager — the one /auth/pair actually verifies against.
  const pairing = createPairingManager({
    realmToken: realmRow?.value,
    store: createPairingStateStore(db),
  });
  if (!realmRow) {
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('realm_token', ?)`).run(pairing.getRealmToken());
  }

  let serverInstanceId = 'server';
  const idRow = db.prepare(`SELECT value FROM server_config WHERE key = 'instance_id'`).get() as { value: string } | undefined;
  if (idRow) {
    serverInstanceId = idRow.value;
  } else {
    const { generateInstanceId } = await import('@recued/instances');
    serverInstanceId = generateInstanceId();
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('instance_id', ?)`).run(serverInstanceId);
  }

  const { createPairedInstancesStore } = await import('../paired-instances-store.js');
  const pairedInstances = createPairedInstancesStore(db);

  const { createRecoveryKeyCheckStore } = await import('../recovery-key-store.js');
  const recoveryKeyCheck = createRecoveryKeyCheckStore(db);
  const hostnameRegistryStore = createHostnameRegistryStore(db);
  const publicAddress = createPublicAddressService({
    configured: () => process.env.RECUED_PUBLIC_BASE_URL,
    hostnames: hostnameRegistryStore,
    store: createSqlitePublicAddressStore(db),
    prober: createCloudReachabilityProber({
      endpoint: () => `https://probe.${resolveCloudApex()}/v1/reachability/probe`,
    }),
    log: (message) => console.warn(`[public-address] ${message}`),
  });
  const { createServerTimeZoneStore } = await import('../storage/server-timezone-store.js');
  const serverTimeZoneStore = createServerTimeZoneStore(db);
  const { createNotificationKindPolicyStore } = await import('../storage/notification-kind-policy-store.js');
  const notificationKindPolicyStore = createNotificationKindPolicyStore(db);
  const { createQuietHoursStore } = await import('../storage/quiet-hours-store.js');
  const quietHoursStore = createQuietHoursStore(db);

  const baseAuditLog: AuditLogStore | undefined = createAuditLogStore(
    createSQLiteCollection(db, 'audit_entries'),
    createSQLiteCollection(db, 'audit_activities'),
    {
      onBytesChanged: (delta) => {
        if (gateRegistry) gateRegistry.audit.addUsed(delta);
      },
    },
  );
  let signingIdentityRef: BootedServerIdentity | undefined;
  const signingAuditLog = createSigningAuditLog(baseAuditLog, {
    getServerIdentity: () => {
      if (!signingIdentityRef) {
        throw new Error(
          'D-148 FU6 — high-assurance audit row emitted before ' +
            'signing identity was wired. `bootSigningIdentity` ' +
            'runs inside cmdServe after the lifecycle lock claim; ' +
            'subcommands that RPC to a running daemon or read ' +
            'local state must not emit HIGH_ASSURANCE_AUDIT_KINDS ' +
            'actions directly.',
        );
      }
      return signingIdentityRef.identity.serverIdentityKey();
    },
  });
  // R13 T4-6.1 — writes refused after drain are counted and persisted
  // out-of-band (the audit store is the thing that can no longer record
  // them); the next boot consumes the marker and surfaces it as one
  // reserve-class `audit_writes_dropped` activity row below.
  const auditDropMarkerPath = droppedWritesMarkerPath(dbPath);
  const drainableAuditLog = createDrainableAuditLog(
    signingAuditLog,
    auditDropMarkerPath
      ? {
          onDroppedWrite: (total) =>
            writeDroppedWritesMarker(auditDropMarkerPath, {
              dropped: total,
              at: Date.now(),
            }),
        }
      : {},
  );
  const auditLog: AuditLogStore = drainableAuditLog.auditLog;
  if (auditDropMarkerPath) {
    const marker = consumeDroppedWritesMarker(auditDropMarkerPath);
    if (marker && marker.dropped > 0) {
      void auditLog
        .logActivity({
          activity_id: `audit.dropped-writes-${Date.now()}`,
          timestamp: Date.now(),
          action: 'audit_writes_dropped',
          target: 'system',
          detail: JSON.stringify({ dropped: marker.dropped, dropped_at: marker.at }),
        })
        .catch(() => { /* surfacing is best-effort; the marker is already consumed */ });
    }
  }
  // D-221 — close the late binding opened at the records-store construction
  // above. Bound to the DRAINABLE log so an import row emitted late in a
  // shutdown still drains with everything else.
  emitRecordsImportAudit = createRecordsImportAuditEmitter(auditLog);
  const drainAuditWrites = drainableAuditLog.closeAndDrain;
  const bootSigningIdentity = async (): Promise<void> => {
    if (signingIdentityRef) return;
    // D-212 slice 5 — the server's own boot is where binding this realm to
    // this machine is a decision someone made, so this is the one caller that
    // opts into sealing the keyfile against a platform secret store.
    const booted = await bootServerIdentity({
      dbPath,
      machineSealing: true,
      // ⛔ Inside a container the only alternative to a passphrase is an unsealed
      // key file in the data volume, so a container's first boot without one is
      // refused rather than warned about. An existing key file is never refused.
      ...(runningInContainer() ? { refuseUnsealed: CONTAINER_UNSEALED_REFUSAL } : {}),
    });
    signingIdentityRef = booted;
    if (booted.created) {
      console.error(
        `[identity] server_identity_key + publisher_identity_key generated at ${booted.filePath} (fingerprint=${booted.identity.serverIdentityKey().public_key_fingerprint})`,
      );
    }
  };

  // D-175 P5 — account-binding manager. Constructed unconditionally
  // (matches the audit-log / RecuedPlan signing-wrapper pattern); the
  // identity + keyStore resolvers throw before `bootSigningIdentity()`
  // populates `signingIdentityRef`, and the manager translates that into
  // a `not_ready` rpc error. The binding credential lands in the SAME
  // identity-keys file as the signing keys (`signingIdentityRef.keyStore`'s
  // `saveAccountBinding`), inheriting its at-rest protection. The auth
  // Worker exchange endpoint shipped (D-175 P5 Worker half); the HTTP
  // client resolves its URL per-call via `resolveAccountBindingExchangeUrl`
  // — defaulting to the prod Worker (`auth.recued.com`; a mirror sets`
  // `RECUED_CLOUD_APEX`) so a fresh self-hosted
  // server binds out-of-the-box, with `RECUED_ACCOUNT_BINDING_EXCHANGE_URL`
  // as the override. An unreachable Worker still degrades to
  // `exchange_unavailable` at the network layer (see exchange-client.ts).
  const requireSigningIdentityForBinding = (): BootedServerIdentity => {
    if (!signingIdentityRef) {
      throw new Error(
        'D-175 P5 — account binding requested before the signing ' +
          'identity was wired. `bootSigningIdentity` runs inside cmdServe ' +
          'after the lifecycle lock claim; account.* rpcs are user-initiated ' +
          'and reach the manager only post-boot.',
      );
    }
    return signingIdentityRef;
  };
  const accountBindingManager: AccountBindingManager = createAccountBindingManager({
    getServerIdentity: () =>
      requireSigningIdentityForBinding().identity.serverIdentityKey(),
    getKeyStore: () => requireSigningIdentityForBinding().keyStore,
    exchangeClient: createHttpAccountBindingExchangeClient({
      // Resolved per-call so a config / env change takes effect without a
      // reconstruct. `cloud.base_url` carries the schema default
      // (`https://api.recued.cloud`) so the prod auth Worker is the
      // out-of-the-box target; a mirror deployment overrides the apex via
      // that variable.
      getEndpointUrl: () =>
        resolveAccountBindingExchangeUrl({
          override: process.env.RECUED_ACCOUNT_BINDING_EXCHANGE_URL,
          cloudBaseUrl: readCloudBaseUrl(runtimeConfig),
        }),
    }),
    ...(auditLog ? { auditLog } : {}),
  });

  // D-175 P8b — Pro convenience provisioner. Reads the binding (secret-
  // free) via the manager's `status()` and gates on the Pro entitlement
  // resolved off the locally stored binding credential. The HTTP source
  // calls the auth Worker's entitlement-mint endpoint, then verifies the
  // returned Ed25519 claim locally before returning `entitled`; missing
  // endpoint/public key/network/bad claim all fail closed as
  // `unavailable`, never fabricated success.
  // D-176 — read the current handle name + its bound DDNS zone label for
  // `<handle>.<suffix>` synthesis. Returned together so the provisioner can
  // confirm the zone belongs to the binding handle before applying it. Lazily
  // construct the read-only store on first use so its `db.prepare` runs after
  // boot has created `server_config` (this composer can run before that table
  // exists). Stateless read of the very row the cert-stack handle state machine
  // writes — a parallel read-only instance is safe.
  let handleStateStoreForZone: HandleStateStore | undefined;
  const readHandleStateForZone = async (): Promise<{
    current_handle: string;
    ddns_zone?: string;
  } | null> => {
    handleStateStoreForZone ??= createSqliteHandleStateStore({ db });
    const state = await handleStateStoreForZone.load();
    if (!state) return null;
    return {
      current_handle: state.current_handle,
      ...(state.ddns_zone !== undefined ? { ddns_zone: state.ddns_zone } : {}),
    };
  };

  // ⛔⛔ THE PRO CARD REPORTED A PLACEHOLDER FOR EVERY ITEM, ALWAYS. `readProvisioned`
  // is the dep that tells `pro_convenience.status` what is actually provisioned —
  // and it was supplied ONLY in tests, so on a real server `snap` was always null,
  // `handle_reserved` always false, and all three items reported
  // `pending / not_provisioned` ("Not set up yet") no matter what the substrate
  // held. The card was not mis-describing one case; its live half was never wired.
  //
  // 🔑 THREE NARROW READS, NO NEW SUBSTRATE. Each is the same stateless
  // read-a-row-the-owner-already-writes shape as `readHandleStateForZone` above:
  //
  //   handle   — the handle state machine's own row, reserved iff a canonical
  //              handle is held and its subscription has not lapsed past grace.
  //   ddns     — the IP state store's cloud-CONFIRMED `last_published_at`, which
  //              is the only stamp that means the record actually landed.
  //   acme     — `expires_at` for the hostname, read directly from `tls_domains`.
  //
  // ⚠ THE CERT READ IS A COLUMN, NOT THE STORE. `SqliteTlsDomainStore.lookup()`
  // decrypts the private key and warms a per-handshake cache; it needs the
  // sub-DEK seam and belongs to the listener path, not to a status read. Building
  // a second instance here to learn one integer would drag key material into a
  // display query. This reads `expires_at` and nothing else.
  let ddnsIpStateStoreForStatus: ReturnType<typeof createSqliteDdnsIpStateStore> | undefined;
  let certExpiryStmt: ReturnType<typeof db.prepare> | undefined;
  const readProvisionedConveniences = async (): Promise<ProvisionedConvenienceSnapshot | null> => {
    const handleState = await readHandleStateForZone();
    const handle = handleState?.current_handle ?? '';
    if (handle.length === 0) return { handle_reserved: false };

    // The zone the handle is actually bound to, not an assumed one: a handle
    // reserved in a non-default zone would otherwise be reported under the wrong
    // hostname, and the cert lookup below would miss.
    const zone = (handleState?.ddns_zone !== undefined
      ? zoneByLabel(handleState.ddns_zone)
      : undefined) ?? defaultDdnsZone();
    const hostname = `${handle}${zone.suffix}`;

    ddnsIpStateStoreForStatus ??= createSqliteDdnsIpStateStore(db);
    const published = ddnsIpStateStoreForStatus.load()?.last_published_at;

    certExpiryStmt ??= db.prepare('SELECT expires_at FROM tls_domains WHERE domain = ?');
    let certExpiry: number | undefined;
    try {
      const row = certExpiryStmt.get(hostname) as { expires_at?: number } | undefined;
      certExpiry = typeof row?.expires_at === 'number' ? row.expires_at : undefined;
    } catch {
      // The table may not exist yet on a server that has never held a cert.
      // Absent reads as "not provisioned", which is the honest answer.
      certExpiry = undefined;
    }

    return buildProvisionedSnapshot({
      handle,
      hostname,
      ...(published !== undefined ? { lastPublishedAt: published } : {}),
      ...(certExpiry !== undefined ? { certExpiresAt: certExpiry } : {}),
    });
  };

  const proConvenienceProvisioner: ProConvenienceProvisioner =
    createProConvenienceProvisioner({
      readBinding: () => accountBindingManager.status(),
      readHandleState: readHandleStateForZone,
      readProvisioned: readProvisionedConveniences,
      // ⛔ Unwired until 2026-09-29, so every entitled card said "Waiting until
      // your server can be reached" forever. The cloud probe's answer for the
      // Pro address — its port, not its certificate, which the card shows as
      // its own item.
      readReachability: async () => publicAddress.proReachability(),
      entitlement: createHttpProEntitlementSource({
        loadBinding: () => requireSigningIdentityForBinding().keyStore.loadAccountBinding(),
        getEndpointUrl: () =>
          // ⚠ `cloudBaseUrl: readCloudBaseUrl(runtimeConfig)` WAS PASSED HERE AND NEVER
          // READ — dropped rather than converted, deliberately. Converting it to
          // `cloudApex` would CHANGE production resolution (a server configured with
          // `cloud.base_url` pointing at a mirror would start resolving that mirror's
          // apex and fail closed instead of silently using the prod key). That may well
          // be the right behaviour, but it is a live-server change and not this one.
          // The apex comes from `RECUED_CLOUD_APEX`; the override above is the escape.
          resolveProEntitlementMintUrl({
            override: process.env.RECUED_PRO_ENTITLEMENT_MINT_URL,
          }),
        getPublicKeyB64: () =>
          resolveProEntitlementPublicKey({
            override: process.env.RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64,
          }),
      }),
    });

  // R27 delta-B — DDNS pause/resume handler deps. The enabled flag + the
  // handle-state target store are plain db reads (safe at compose time). The
  // cloud-pause client is built LAZILY on first use so `readCloudBaseUrl` + the
  // signing identity are resolved post-boot (the signer reuses the same
  // per-call `requireSigningIdentityForBinding` the account binding uses), and
  // memoized thereafter (the cloud base URL is a static deploy config). The
  // handle-state store is a dedicated full instance (the zone-scoped one above
  // exposes only `current_handle`/`ddns_zone`; the handler needs `publisher_id`
  // + `subscription_state`).
  let ddnsPauseClientRef: ReturnType<typeof createDdnsUpdateClient> | undefined;
  const ddnsHandlerDeps: DdnsHandlerDeps = {
    enabledStore: createSqliteDdnsEnabledStore(db),
    handleStateStore: createSqliteHandleStateStore({ db }),
    pauseClient: {
      pause: (args) => {
        ddnsPauseClientRef ??= createDdnsUpdateClient({
            // Schema default `https://api.recued.com` (the prod sync-worker, the
          // same default the DDNS update client documents) when `cloud.base_url`
          // is unset/empty — a fresh self-hoster binds out-of-the-box.
            cloud_base_url: readCloudBaseUrl(runtimeConfig) ?? 'https://api.recued.com',
          signPayload: (canonical) =>
            requireSigningIdentityForBinding().identity.signWithServerIdentity(canonical),
        });
        return ddnsPauseClientRef.pause(args);
      },
    },
  };

  // D-145 PB13 — RecuedPlan signing store. Same lazy-bound signing
  // identity resolver as `createSigningAuditLog` above — the store is
  // constructed unconditionally so the bundle can be wired through the
  // context, but `append` throws if invoked before
  // `bootSigningIdentity()` populates `signingIdentityRef`. The D-173
  // reception compose-propose path persists a `RecuedPlan` per compose
  // request via `executeRecuedRequestPersist`; SQLite backing keeps
  // that signed audit record durable across restart.
  const { recuedPlanStore, executeRecuedRequestPersist } = composeRecuedPlanStore({
    getServerIdentity: () => {
      if (!signingIdentityRef) {
        throw new Error(
          'D-145 PB13 — RecuedPlan signing requested before signing ' +
            'identity was wired. `bootSigningIdentity` runs inside ' +
            'cmdServe after the lifecycle lock claim; callers that ' +
            'invoke `executeRecuedRequest.persist` before the daemon ' +
            'is ready must defer until boot completes.',
        );
      }
      return signingIdentityRef.identity.serverIdentityKey();
    },
    backing: createSQLiteCollection<RecuedPlan>(db, 'recued_plans'),
  });

  ensureAuditIndexes(db);
  ensureMemorySchema(db);
  const commitStore: CommitStore | undefined = createCommitStore(
    createSQLiteCollection<Commit>(db, 'commits'),
  );
  ensureCommitSchema(db);
  const checkpointStore: CheckpointStore | undefined = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  const mcpActionStore = createMcpActionStore(
    createSQLiteCollection<McpActionRecord>(db, MCP_ACTION_TABLE),
    { compareAndSet: createSqliteMcpActionCompareAndSet(db) },
  );
  const gatedActionChangeClock = createSqliteGatedActionChangeClock(db);
  const gatedActionStore = createGatedActionStore(
    createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE),
    {
      compareAndSet: createSqliteGatedActionCompareAndSet(db),
      nextChangeSeq: gatedActionChangeClock.nextChangeSeq,
      changeClock: gatedActionChangeClock.snapshot,
    },
  );
  const settledRunResults = createSettledRunResults();
  const preapprovalStorage = createPreapprovalStorage(db, gatedActionChangeClock, () => getVaultKey?.() ?? null,
    { limits: preapprovalLimitsFromEnvironment(process.env) });
  const mailWorkStore = createMailWorkStore(db, createPreapprovalCodec(() => getVaultKey?.() ?? null));
  // Receipt content stays in the owner-only RPC. The bus frame only wakes
  // paired surfaces so reconnect/replay remains safe and bounded.
  gatedActionStore.subscribe(({ record }) => {
    eventBus.emit({
      kind: 'execution',
      recipe_id: record.recipe_id ?? 'raw-op',
      run_id: record.run_id,
      op: 'action_changed',
      action_ref: record.action_ref,
      approval_ref: record.approval_ref,
      action_revision: record.revision,
    });
  });

  const perPairStores = await composePerPairStores({ db });
  const workEntityStoreRef = perPairStores?.workEntityStore;
  const s2sPreviewStoreRef = perPairStores?.s2sPreviewStore;
  const correctionEventsStoreRef = perPairStores?.correctionEventsStore;
  const publicEndpointRegistryStoreRef = perPairStores?.publicEndpointRegistryStore;
  const receptionRegistryCacheRef = perPairStores?.receptionRegistryCache;
  const receptionRateLimiterRef = perPairStores?.receptionRateLimiter;
  const previewHashStoreRef = perPairStores?.previewHashStore;
  const schedulingFormNonceStoreRef = perPairStores?.schedulingFormNonceStore;
  const intakeFormDefinitionStoreRef = perPairStores?.intakeFormDefinitionStore;
  const intakeRecipePairStoreRef = perPairStores?.intakeRecipePairStore;
  const intakeFormSubmissionStoreRef = perPairStores?.intakeFormSubmissionStore;
  const formResponseStoreRef = perPairStores?.formResponseStore;
  const mailFactStoreRef = perPairStores?.mailFactStore;
  const intakeFormNonceStoreRef = perPairStores?.intakeFormNonceStore;
  const dropBlobStoreRef = perPairStores?.dropBlobStore;
  const dropLinkNonceStoreRef = perPairStores?.dropLinkNonceStore;
  const approvalIntentStoreRef = perPairStores?.approvalIntentStore;
  const approvalLinkNonceStoreRef = perPairStores?.approvalLinkNonceStore;
  const statusProjectionStoreRef = perPairStores?.statusProjectionStore;
  const ipBlockStoreRef = perPairStores?.ipBlockStore;

  backfillRecipeInsights(db, recipeStore);

  // D-139 P6.B — body-content visibility grant store. Created before
  // pre-install so a foundation pack shipping `mcp_body_visibility_grants[]`
  // persists at boot (the `crm-commitment-tracker` pack ships the engagement
  // body grant; it installs via the marketplace path, but the wire is symmetric).
  const mcpBodyVisibilityStore: McpBodyVisibilityStore = createMcpBodyVisibilityStore(db);

  const { preInstallFoundationPacks } = await import('../foundation-pack-pre-install.js');
  const foundationResult = await preInstallFoundationPacks({
    recipeStore,
    mcpBodyVisibilityStore,
    // The live manifest registry resolves a foundation CRM pack's by-ref bundled
    // vendor catalog (e.g. `hubspot-catalog`), so its connection-agnostic op-step
    // recipes rewrite to concrete vendor-bound form before persist (first-party
    // install wiring). Recipe-only foundation packs never consult it.
    getCatalogManifest: (slug) => manifests.get(slug),
    // D-173 D1 — composition-provisioning deps so a pre_install pack that ships
    // its integration as a by-value `composition` (the reception core-packs:
    // `recipes: []`, the review-then-approve recipe COMPILED at install per
    // D-170 N.18) provisions its catalog + compiled recipe + grants at boot —
    // otherwise the reception review→inbox→approve path is a dead-end on a fresh
    // boot (no compiled recipe ⇒ the dispatch seam never fires). These are the
    // SAME handles the `packs.install` rpc threads onto its composition branch
    // (`compose-listeners.ts`): the shared `localManifestStore` + live
    // `manifests` registry (already constructed above), and a `contractStore` /
    // `recipeTrustStore` over the same `db` (both stateless db-backed — the rpc's
    // `app.contractStoreRef` is itself a fresh `createContractStore(db)`). The
    // composition's bound connection profile is left to the boot's own
    // catalog-operation-profile pass (`reconcileConnectionProfile` is unwired
    // here — it composes later); the binding lands now, the profile seeds on that
    // pass before any visitor submission arrives.
    compositionProvision: {
      localManifestStore,
      contractStore: createContractStore(db),
      registry: manifests,
      recipeTrustStore: createTrustStateStore(createSQLiteCollection(db, 'recipe_trust')),
    },
  });
  if (foundationResult.failedCount > 0) {
    console.warn(
      `[d-145.pa10] foundation-pack pre-install: ${foundationResult.installedCount} ok, ${foundationResult.skippedCount} skipped, ${foundationResult.failedCount} failed`,
    );
  }

  const accountStore: ServerAccountStore | undefined = createServerAccountStore(db, {
    onBytesChanged: (delta) => {
      if (gateRegistry) gateRegistry.account_store.addUsed(delta);
    },
  });

  gateRegistry = createGateRegistry({
    config: runtimeConfig,
    initialUsage: computeInitialUsage({ db }),
    // ⛔ AUDIT PULLS ITS OWN TOTAL. `audit-compaction` deletes audit rows
    // through raw SQL and reports nothing to the gate, so the pushed counter
    // over-reported until the hourly retention pass re-anchored it — and the
    // pressure read-out surfaces `used_bytes` to the owner, so that staleness
    // was visible. Threading a gate into every deleter would relocate the
    // obligation; this removes it.
    //
    // ⚠ Affordable only because `readAuditUsageBytes` is an O(1) indexed read
    // over the trigger-maintained counter. Against the old
    // `SUM(length(data))` this would have been a full scan per gate read.
    usageProviders: { audit: () => readAuditUsageBytes(db) },
  });
  const GATE_CONFIG_KEYS = new Set<string>([
    'vault.quota.total_bytes',
    'account.quota.bytes',
    'data.shared.quota.bytes',
    'cache.max_bytes',
    'audit.quota.bytes',
    'scheduler.quota.bytes',
    'storage.reserve_pct',
  ]);
  runtimeConfig.onChange((key) => {
    if (GATE_CONFIG_KEYS.has(key)) gateRegistry!.reconfigureFromConfig();
  });

  /** ⛔ THE FALLBACKS MUST COME FROM THE SCHEMA, NOT BE RETYPED HERE. These
   *  were literal copies of the schema defaults, correct on the day they were
   *  written. D-230 raised `audit.quota.bytes` 50 MB -> 5 GB and this copy
   *  stayed at 50 MB — so any server whose config read threw would have had its
   *  audit trail pruned to a hundredth of its configured ceiling, silently and
   *  oldest-first, on a surface with no upstream to re-sync from.
   *
   *  🔑 A DUPLICATED DEFAULT IS A RULE THAT GOES STALE IN PLACE. Nothing fails
   *  when the schema moves and the copy does not; the copy simply starts
   *  disagreeing. Reading `RUNTIME_SCHEMA_MAP` makes the schema the single
   *  writer, so the next re-scale cannot leave a straggler behind.
   *
   *  ⚠ `retentionDays` keeps its own constant deliberately —
   *  `MEMORY_RETENTION_DEFAULT_DAYS` is the contract for the no-expiry
   *  sentinel, not a copy of a schema number. */
  const schemaFallback = (key: string, ifMissing: number): number => {
    const entry = RUNTIME_SCHEMA_MAP[key];
    return typeof entry?.default === 'number' ? entry.default : ifMissing;
  };
  const auditRetentionConfig = (): AuditRetentionConfig => ({
    retentionDays: (() => {
      try {
        const raw = runtimeConfig.get('audit.retention_days') as number;
        return raw <= 0 ? null : raw;
      }
      catch { return MEMORY_RETENTION_DEFAULT_DAYS; }
    })(),
    quotaBytes: (() => {
      try { return runtimeConfig.get('audit.quota.bytes') as number; }
      catch { return schemaFallback('audit.quota.bytes', 5 * 1024 * 1024 * 1024); }
    })(),
    pruneAtPct: (() => {
      try { return runtimeConfig.get('audit.prune_at_pct') as number; }
      catch { return schemaFallback('audit.prune_at_pct', 70); }
    })(),
    pruneMaxRowsPerRun: (() => {
      try { return runtimeConfig.get('audit.prune_max_rows_per_run') as number; }
      catch { return schemaFallback('audit.prune_max_rows_per_run', 1000); }
    })(),
    reservePct: (() => {
      try { return runtimeConfig.get('audit.reserve_pct') as number; }
      catch { return schemaFallback('audit.reserve_pct', 4); }
    })(),
  });
  const auditRetention: AuditRetention | undefined = createAuditRetention({
    db,
    auditLog,
    gate: gateRegistry.audit,
    config: auditRetentionConfig,
  });

  const pressureState: PressureStateStore | undefined = createPressureStateStore(db);
  reconcilePressureStateAtBoot({
    state: pressureState,
    gates: gateRegistry.all(),
  });

  return {
    db,
    preapprovalStorage,
    mailWorkStore,
    manifests,
    localManifestStore,
    draftStore,
    recipeStore,
    recordsStore,
    eventBus,
    approvalStore,
    fileStack,
    envLlmConfig,
    get vaultStore() { return vaultStore; },
    get baseVault() { return baseVault; },
    initVault,
    pairing,
    serverInstanceId,
    pairedInstances,
    recoveryKeyCheck,
    auditLog,
    drainAuditWrites,
    get signingIdentity() { return signingIdentityRef; },
    bootSigningIdentity,
    accountBindingManager,
    proConvenienceProvisioner,
    ddnsHandlerDeps,
    recuedPlanStore,
    executeRecuedRequestPersist,
    commitStore,
    checkpointStore,
    mcpActionStore,
    gatedActionStore,
    settledRunResults,
    workEntityStoreRef,
    s2sPreviewStoreRef,
    correctionEventsStoreRef,
    publicEndpointRegistryStoreRef,
    receptionRegistryCacheRef,
    receptionRateLimiterRef,
    previewHashStoreRef,
    schedulingFormNonceStoreRef,
    intakeFormDefinitionStoreRef,
    intakeRecipePairStoreRef,
    intakeFormSubmissionStoreRef,
    formResponseStoreRef,
    mailFactStoreRef,
    intakeFormNonceStoreRef,
    dropBlobStoreRef,
    dropLinkNonceStoreRef,
    approvalIntentStoreRef,
    approvalLinkNonceStoreRef,
    statusProjectionStoreRef,
    ipBlockStoreRef,
    accountStore,
    hostnameRegistryStore,
    publicAddress,
    serverTimeZoneStore,
    notificationKindPolicyStore,
    quietHoursStore,
    gateRegistry,
    auditRetention,
    pressureState,
    mcpBodyVisibilityStore,
  };
};
