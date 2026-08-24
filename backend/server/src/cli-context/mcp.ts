import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  createAuditLogStore,
  createCheckpointStore,
  createCommitStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import type { Checkpoint, Commit } from '@recued/contracts';
import {
  D165_CONTRACT_SCHEMA,
  isMcpInboundTokenActive,
  setVendorAliasRegistryResolver,
} from '@recued/contracts';
import { getArg } from '../cli/parse.js';
import {
  createChatInboundTokenStore,
  deriveMcpInboundTokenId,
} from '../storage/chat-inbound-token-store.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { openDatabase } from '../open-database.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createRecordsStore } from '../records/index.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  MCP_ACTION_TABLE,
  createMcpActionStore,
  createSqliteMcpActionCompareAndSet,
  type McpActionRecord,
} from '../mcp-action-store.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import {
  ensureCheckpointSchema,
  ensureCommitSchema,
  ensureMemorySchema,
} from '../memory-schema.js';
import { createEventBus } from '../events/bus.js';
import { createBundleStore } from '../bundle-store.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createKeyManager } from '../key-manager.js';
import { autoUnlockServerVaultFromKeyfile } from '../server-vault-enrollment.js';
import { createFileServerKeyStore } from '../keys/file-store.js';
import {
  IDENTITY_PASSPHRASE_ENV_VAR,
  resolveIdentityKeysPath,
} from '../identity/boot.js';
import { resolveLLMConfigFromEnv } from '../llm-env.js';
import { resolveVaultFromEnv, mergeVault } from '../vault-env.js';
import {
  createServerVaultStore,
  listVaultPublishers,
  loadVaultAsObject,
} from '../server-vault.js';
import { createEncryptedBlobStore } from '../storage/index.js';
import { createSharedStore } from '../storage/shared-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
} from '../storage/crm-record-mirror-store.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';
import { createGatedReadGrantResolver } from '../read-grant-checker.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  deriveBoundCrmMirrorSources,
  liveVendorRegistry,
} from '../connection-convention-families.js';
import {
  createCliReachabilityResolver,
  createCliReachabilityStore,
} from '../storage/cli-reachability-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createSellerStore } from '../storage/seller-store.js';
import { createSellerOrderStore } from '../storage/seller-order-store.js';
import { createFormResponseStore } from '../storage/form-response-store.js';
import { grandfatherPrimitiveGrants, reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import { installRecipeGrantSeed } from '../recipe-grant-seed.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createSeededCatalogOperationProfileStore } from '../connection-operation-profile-boot.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { registerMcpReadonlyMailCollections } from '../mcp-readonly-mail-collections.js';
import {
  createMcpReadonlyBusinessContextReaders,
} from '../mcp-readonly-business-context.js';
import { createLiveMcpTokenToolAuthorizer } from '../mcp-recipe-callback.js';
import { createWatcherDispatcher } from '../watchers/index.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import { startMCPServer } from '../mcp-server.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import { scopedCandidatesForChannelSession } from '../chat-forwarded-sender-index.js';
import { composeChatOrchestrator } from '../composition/bin/wire-chat-orchestrator.js';
import { composeExecuteDeps } from '../composition/bin/wire-execute-deps.js';
import {
  buildOwnerSurfaceLink,
  resolvePublicBaseUrl,
} from '../ask-landing-answer-link.js';
import { composeExecutorConfig } from '../composition/bin/wire-executor-config.js';
import { composeHousekeepingStores } from '../composition/bin/wire-housekeeping-substrate.js';
import { composeLlmSubstrate } from '../composition/bin/wire-llm-substrate.js';

export interface McpProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
}

const ensureServerInstanceId = async (db: Database.Database): Promise<string> => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db
    .prepare(`SELECT value FROM server_config WHERE key = 'instance_id'`)
    .get() as { value: string } | undefined;
  if (row) return row.value;

  const { generateInstanceId } = await import('@recued/instances');
  const instanceId = generateInstanceId();
  db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('instance_id', ?)`)
    .run(instanceId);
  return instanceId;
};

export async function runMcpProfile(options: McpProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  options.bootTrace?.mark('db-opened');

  const manifests = createManifestRegistry();
  const recipeStore = createRecipeStore(undefined, db);
  const recordsStore = createRecordsStore(db);
  const eventBus = createEventBus();
  const serverInstanceId = await ensureServerInstanceId(db);
  const serverDisplayName = env.RECUED_SERVER_NAME ?? hostname() ?? 'recued';

  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  ensureAuditIndexes(db);
  ensureMemorySchema(db);

  const commitStore = createCommitStore(createSQLiteCollection<Commit>(db, 'commits'));
  ensureCommitSchema(db);
  const checkpointStore = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  const mcpActionStore = createMcpActionStore(
    createSQLiteCollection<McpActionRecord>(db, MCP_ACTION_TABLE),
    { compareAndSet: createSqliteMcpActionCompareAndSet(db) },
  );

  const bundleStore = createBundleStore(db);
  const serverBundleStore = createServerBundleStore(dbPath);
  const initialServerBundle = serverBundleStore.load();
  const keys = createKeyManager({
    loadBundle: () => bundleStore.load(),
    saveBundle: (bundle) => bundleStore.save(bundle),
    loadServerBundle: () => serverBundleStore.load(),
    initialServerBundle,
    saveServerBundle: (bundle) => serverBundleStore.save(bundle),
  });
  if (initialServerBundle) {
    const passphrase = env[IDENTITY_PASSPHRASE_ENV_VAR];
    const keyStore = await createFileServerKeyStore({
      filePath: resolveIdentityKeysPath(dbPath),
      ...(passphrase ? { passphrase } : {}),
    });
    await autoUnlockServerVaultFromKeyfile({ keys, keyStore });
  }
  const llmSubstrate = composeLlmSubstrate({
    db,
    keys,
    envLlmConfig: resolveLLMConfigFromEnv(env),
  });

  options.bootTrace?.mark('vault-init-start');
  // An ENROLLED realm's rows are sealed under `sub_dek.vault`, so this profile
  // must key the store the same way the serve path does
  // (`compose-storage-context.ts`) — `keys` is auto-unlocked just above.
  // Constructing it bare instead fell through to the legacy `ensureDek`, which
  // minted a fresh plaintext DEK row and then failed the AES-GCM tag on the
  // first stored credential, killing `recued --mcp` at boot with an unhandled
  // OperationError. Gated on the bundle rather than passed unconditionally: a
  // pre-D-148 realm has no server bundle and keeps its rows under the legacy
  // `server_dek`, and the keyed store has no fallback — it throws outright when
  // the provider yields null, so an unconditional provider would trade this bug
  // for a silent credential blackout on exactly those realms.
  const vaultStore = await createServerVaultStore(db, {
    ...(initialServerBundle
      ? { getEncryptionKey: () => keys.keyProvider('vault')() ?? null }
      : {}),
  });
  const persistedVault = await loadVaultAsObject(
    vaultStore,
    await listVaultPublishers(db),
  );
  const baseVault = mergeVault(persistedVault, resolveVaultFromEnv(env));
  options.bootTrace?.mark('vault-init-complete');

  const housekeepingStores = composeHousekeepingStores({ db });
  const enrichmentStore = createEnrichmentStore(db);
  // D-190 (generic reconciler MS3) — the CRM record mirror deal.search reads.
  // Same db as the serve path's reconciler, so mirror rows are visible here.
  ensureCrmRecordMirrorSchema(db);
  // 🔴 D-192 Slice 6b — REQUIRED here, not optional. `wire-notification-block`
  // builds `createSourceDependencyEntityStore(db)` UNCONDITIONALLY (container-pick
  // resolution), and that store `db.prepare()`s its statements at construction —
  // so without this table `recued --mcp` against a fresh DB dies at boot with
  // `no such table: source_dependency_entity`, exit 1, before serving anything.
  // Slice 6a added the store to the serve path WITH its ensure
  // (compose-app-context.ts:999); Slice 6b copied the consumer into the bin/MCP
  // composition and not the migration. This profile owns its own migration list,
  // so it has to carry every table its composition touches.
  ensureSourceDependencyEntitySchema(db);
  const crmRecordMirror = createCrmRecordMirrorStore(db);
  const connectionStore = createConnectionStore(db);
  // D-182 §10 step 8 / R1 (Fix 2) — installed-manifest store for the run-path R1
  // pre-pass's merged convention-family vendor registry (built-ins +
  // pack-composition vendors), so the agent (MCP → gateway) path binds a connected
  // `acct` / 3rd-party CRM vendor's family too — not just built-in HubSpot/Salesforce.
  const localManifestStore = createLocalManifestStore(db);
  // Register each installed local-composition manifest into the live registry
  // (mirrors the serve boot path's compose-storage-context loop). Without it R1's
  // merged registry would report a pack-composition op runnable while dispatch —
  // which resolves against `manifests` — could not lower it: R1 and dispatch MUST
  // see the same local catalogs, or the agent path clears R1 then fails resolution.
  for (const manifest of localManifestStore.listManifests()) {
    manifests.register(manifest);
  }
  // D-192 unit-3 — bind the pure read-side alias resolvers (`data.crm.*` /
  // `data.<vendor>.*` rewrites) to THIS profile's live registry. The serve path
  // binds in `composeAppContext`; the standalone MCP boot is a separate
  // composition, so without this a pack-CRM ref run through MCP would resolve
  // against the frozen builtin. Lazy thunk → recompute-on-read.
  setVendorAliasRegistryResolver(() => liveVendorRegistry(localManifestStore));
  // D-165/D-166 — seed the contract schema into `contract.schema.*` rows at boot
  // (idempotent; same db as the serve path). Gateway-read-only substrate.
  // D-166 Slice 4d.1: RETAIN the handle (was discarded) for the 4d.4 catalog-gate
  // resolver on this MCP boot path — mirrors the serve path's app.contractStoreRef.
  // Read here by `seedSchema`; 4d.4 adds the resolver closure over this handle.
  const contractStore = createContractStore(db);
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  const sellerStore = createSellerStore(db);
  const sellerOrderStore = createSellerOrderStore(db);
  // D-187 AMENDMENT 3b — materialize the OWNER contract's grant rows (idempotent +
  // atomic), preserving any explicit owner revoke. Same db + boot ordering as the serve
  // path so both surfaces agree on the owner's "fully-granted contract" state.
  reconcileOwnerGrants(contractStore);
  // D-228 slice 5 — same grandfather as the serve path, same ordering. This is
  // the surface that actually dispatches the gated Tier-1 tools, so skipping it
  // here would strip them from every scoped door on the MCP wire.
  grandfatherPrimitiveGrants(contractStore);
  // D-247 D8 — the recipe grant seam, on THIS boot path too. The serve path
  // wires it in `compose-app-context.ts`; wiring it on only one surface is the
  // failure this module's own comments above keep naming — the two boots share a
  // DB, so a recipe saved here would carry no grant row until something happened
  // to open the same file under `serve`, and "which binary started last" is not
  // a thing the owner's catalog should depend on. Idempotent, so both running is
  // a no-op rather than a conflict.
  installRecipeGrantSeed({
    store: recipeStore,
    grants: createContractGrantEntryStore(contractStore),
    now: () => Date.now(),
  });
  // D-165 P3.grant migration — durable user-manual operation-group grants live as
  // `contract.grant` rows, merged into the profile seed below so the MCP (agent →
  // gateway) path honours write grants made via the webclient grant rpc (both
  // surfaces share the same contract store).
  const contractGrantStore = createContractGrantStore(contractStore);
  const pairedInstances = createPairedInstancesStore(db);
  const collectionRegistry = createCollectionRegistry();
  const watcherDispatcher = createWatcherDispatcher({
    auditLog,
    collectionRegistry,
    db,
  });
  const blobRoot = join(dirname(resolve(dbPath)), 'blobs');
  const cacheBlobs = createEncryptedBlobStore(
    blobRoot,
    keys.keyProvider('blob-store'),
  );
  const sharedStore = createSharedStore({
    db,
    blobs: cacheBlobs,
  });
  const formResponseStore = createFormResponseStore(db);
  const annotationStore = createAnnotationStore({
    db,
    blobs: cacheBlobs,
  });
  // The stdio MCP process shares the warehouse DB but must not start a second
  // provider sync loop beside the main server. Register table-backed mail read
  // views plus narrow contact/work/calendar readers, so query recipes can use
  // the local mirrors while all provider/network ownership stays in serve.
  registerMcpReadonlyMailCollections({ db, registry: collectionRegistry });
  const businessContextReaders = createMcpReadonlyBusinessContextReaders(db);

  let executorConfigRef: ServerExecutorConfig | undefined;
  let executeDepsRef: ExecuteHandlerDeps | undefined;
  const chatBundle = composeChatOrchestrator({
    db,
    keys,
    eventBus,
    auditLog,
    serverInstanceId,
    recipeStore,
    llmConfig: llmSubstrate.llmConfig,
    // D-174 R28 Slice A — per-use LIVE config getter for the chat store's
    // source_id resolver (prefer the manager's live SQLite read; fall back to
    // the boot snapshot when absent / locked).
    getLlmConfig: () => {
      try {
        return llmSubstrate.llmManager?.getConfig() ?? llmSubstrate.llmConfig;
      } catch {
        return llmSubstrate.llmConfig;
      }
    },
    // D-250 § D — same owner daily-counter sink as the serve path; the CLI/MCP
    // context runs the same chat turns and must not be the door that spends
    // uncounted.
    addOwnerTokenUsage: (tokens) => { llmSubstrate.llmManager?.addUsage(tokens); },
    llmQuota: llmSubstrate.llmQuota,
    llmAdapterRegistry: llmSubstrate.llmAdapterRegistry,
    emptyTabProbe: llmSubstrate.emptyTabProbe,
    pairedInstances,
    annotationDeps: { store: annotationStore, auditLog },
    sharedStore,
    getContactStore: () => undefined,
    getCollectionRegistry: () => collectionRegistry,
    getEnrichmentStore: () => enrichmentStore,
    getCrmRecordMirror: () => crmRecordMirror,
    getConnectionStore: () => connectionStore,
    getExecutorConfig: () => executorConfigRef,
    getExecuteDeps: () => executeDepsRef,
  });

  const executorConfig = await composeExecutorConfig({
    // D-234 § 234.4 — the inbound peer door needs the notification block, which
    // is composed after this config. Same late-binding seam the container-pick
    // and saga wirings use.
    getExecuteDeps: () => executeDepsRef,
    manifests,
    baseVault,
    llmQuota: llmSubstrate.llmQuota,
    cacheStore: undefined,
    // Reuse the same encrypted CAS reader as the main server. This profile owns
    // no cache eviction or provider loop, but it must hydrate blob-backed mail
    // bodies for read-only recipes invoked through MCP.
    cacheBlobs,
    serverInstanceId,
    watcherDispatcher,
    collectionRegistry,
    recipeStore,
    getScheduleDeps: () => undefined,
    sellerStore,
    sellerOrderStore,
    contractStore,
    inboundTokenStore: chatBundle.inboundTokenStore,
    llmConfig: llmSubstrate.llmConfig,
    resolveLlmConfig: llmSubstrate.resolveLlmConfig,
    llmManager: llmSubstrate.llmManager,
    connectionStore,
    auditLog,
    keys,
    connectionNotificationDeps: undefined,
    fileStack: undefined,
    calendarStack: undefined,
    serviceStack: undefined,
    sharedStore,
    formResponseStore,
    contactStore: undefined,
    businessContextContactStore: businessContextReaders.contacts,
    businessContextWorkEntityStore: businessContextReaders.workEntities,
    businessContextCrmMirrorStore: crmRecordMirror,
    businessContextCalendars: businessContextReaders.calendars,
    getBoundCrmSources: () => deriveBoundCrmMirrorSources(
      'deal',
      connectionStore,
      liveVendorRegistry(localManifestStore),
    ),
    annotationDeps: { store: annotationStore, auditLog },
    db,
    annotationStore,
    enrichmentStore,
    // D-239 — the standalone stdio MCP profile composes no cascade engine
    // (it registers mail READ-ONLY — see `mcp-readonly-mail-collections.ts`,
    // which never opens a provider socket), so there is no write-back to
    // cascade for. Explicit `undefined` rather than an omission: this
    // profile's divergences from the serve path are the kind that go stale
    // silently, and a named field is one a reader can question.
    enrichmentCascade: undefined,
    // D-187 AMENDMENT — the per-(bound contract) read-grant resolver for the
    // recipe-channel dispatchers (wraps this MCP boot path's local contract store;
    // gates to standing policy contracts).
    readGrantResolver: createGatedReadGrantResolver(contractStore),
    notificationChannelDispatchers: undefined,
    housekeepingState: housekeepingStores.stateStore,
    engagementRateControlStore: undefined,
    workEntityDispatchers: undefined,
    // D-173 P1-dispatch — no reception materialize in the MCP CLI context (no
    // per-pair work-entity store wired here); the `reception-materialize`
    // kernel dispatcher stays unwired (kernel adapter → SERVER_NOT_REACHABLE).
    receptionProjectionWorkEntityStore: undefined,
    receptionProjectionContactDeps: undefined,
    // D-210 WS3 — the CLI/MCP context composes no reception intake substrate,
    // so there is no sealed submission to resolve an identity from.
    resolveSealedVisitorEmail: undefined,
    // D-173 P4.3 — no scheduling/calendar materialize in the MCP CLI context
    // (no calendar stack / booking store wired here).
    receptionProjectionBookingStore: undefined,
  });
  executorConfigRef = executorConfig;

  const executeDepsBundle = composeExecuteDeps({
    // D-234 § 234.3 — the stdio profile resolves its own link from the same env
    // var the serving root uses. Wired here too so a peer-admission ask raised
    // on this path is not silently the one without a "read it here" link.
    ...((): { ownerSurfaceLink?: (recipe_id: string) => string } => {
      const link = buildOwnerSurfaceLink(
        resolvePublicBaseUrl(env.RECUED_PUBLIC_BASE_URL),
      );
      return link !== null ? { ownerSurfaceLink: link } : {};
    })(),
    recipeStore,
    recordsStore,
    executorConfig,
    baseVault,
    serverInstanceId,
    serverDisplayName,
    eventBus,
    auditLog,
    sharedStore,
    db,
    enrichmentStore,
    commitStore,
    checkpointStore,
    mcpActionStore,
    annotationStore,
    // D-182 §10 step 8 / R1 (Fix 2) — the merged convention-family vendor registry
    // source, so the agent path's R1 pre-pass binds pack-composition CRM/acct vendors.
    localManifestStore,
    getExecuteDeps: () => executeDepsRef,
    // D-196 R2 — the stdio profile still hosts the canonical inbound-token
    // store for any contracted resume evidence it may encounter. Re-read it at
    // approval time; the checkpoint snapshot is never bearer authority.
    inboundTokenStore: chatBundle.inboundTokenStore,
    sellerCustomerAdmissionStore: sellerStore,
    // D-165 P3.path-picker (Slice 3b) — the connection-RECORD store, so the
    // gateway can resolve `subresource_path` and enforce a catalog operation's
    // `path_scope` on this MCP (agent → gateway) path too — the same surface
    // the catalog pilot validates. Absent ⇒ path scope inert (whole-account).
    connectionStore,
    // D-165 — boot-seed the catalog operation-profile store for enrolled
    // catalog-vendor connections (HubSpot + Salesforce) on THIS surface too.
    // The MCP context IS the "agent -> gateway" path the pilot validates;
    // without a seeded store every catalog operation would fail closed
    // (`no_connection_profile`) even with valid OAuth creds in the vault.
    // D-170 gap #2 — only the seeded profile store is needed here; the MCP
    // (agent → gateway) surface never reaches `ingredient.*` / `packs.*`
    // (reserved prefixes), so the live-reconcile primitive has no caller.
    connectionOperationProfiles: createSeededCatalogOperationProfileStore({
      connectionStore,
      getManifest: (slug) => executorConfig.manifests.get(slug),
      contractGrantStore,
      // D-170 gap #2 — seed local composition-catalog connections on the MCP path too.
      connectionCatalogBindingStore: createConnectionCatalogBindingStore(contractStore),
    }).profileStore,
    // D-182 §7.2 — the cli reachability resolver on the MCP (agent → gateway)
    // path too: a `cli` catalog op authorizes against a per-(principal ×
    // cli-ingredient × risk_tier) allowlist (absent ⇒ denied), NOT a connection
    // profile. Built over the SAME contractStore the grid rpc writes; absent row
    // ⇒ fail closed `cli_reachability_disabled` (reachability defaults OFF). A
    // contracted MCP run resolves to its contract's principal, so an agent only
    // reaches a cli ingredient the owner granted that contract (Codex F-V8).
    cliReachabilityResolver: createCliReachabilityResolver(
      createCliReachabilityStore(contractStore),
    ),
    // D-166 Slice 4d.4 — the local-only `contract.*` store (created + schema-
    // seeded above) feeds the gateway's override-tightening layer on this MCP
    // (agent → gateway) path too, mirroring the serve path's app.contractStoreRef.
    contractStore,
    // D-177 N.11 rule 5 (slice D) — the forwarded-sender candidate lookup,
    // closed over the chat bundle's per-session index. MCP-channel sessions
    // (`mcp:<token>`) deliberately resolve to no candidates (chat-only v1,
    // 5.f) — wired anyway so a chat-session dispatch routed through this
    // context behaves identically to the serve path.
    scopedSenderCandidates: (channel_session_id: string) =>
      scopedCandidatesForChannelSession(
        chatBundle.forwardedSenderIndex,
        channel_session_id,
      ),
  });
  executeDepsRef = executeDepsBundle.executeDeps;

  options.bootTrace?.mark('dispatch-mcp');
  // ⛔⛔ D-228 slice 1 — THIS SURFACE CARRIES A CONTRACT OR IT CARRIES NOTHING.
  //
  // Until now this call supplied no `inboundTokenAuthorize`, and
  // `buildMcpContractSnapshot`'s fallback handed back every slug clearing two
  // hardcoded fences — its own comment called that *"governed by no contract
  // (the owner reads all)"*. But PROXIMITY IS NOT IDENTITY: Claude Desktop is a
  // third-party application, and so is any local process that can reach a stdio
  // server. Running on the owner's machine does not make a caller the owner.
  //
  // A bearer resolves to its inbound-token record and the SAME predicate the
  // HTTP door uses (`isMcpInboundTokenToolAuthorized`) — no second enforcement
  // path. Absent or unknown ⇒ no authorizer ⇒ the snapshot yields an empty
  // catalog, and the reason is printed rather than left as a mystery.
  //
  // ⚠ stderr, never stdout: stdout is the MCP protocol stream on stdio.
  const bearer = getArg(options.args, 'token') ?? env.RECUED_MCP_TOKEN;
  const tokenRecord = bearer !== undefined && bearer.length > 0
    ? createChatInboundTokenStore(db).getTokenById(deriveMcpInboundTokenId(bearer))
    : null;
  if (bearer !== undefined && bearer.length > 0 && tokenRecord === null) {
    console.error(
      '[recued mcp] the supplied token was not recognised — no tools will be offered. '
      + 'Check it against Settings → MCP Tokens.',
    );
  } else if (tokenRecord === null) {
    console.error(
      '[recued mcp] no token supplied, so no tools will be offered. '
      + 'This surface derives its catalog from the contract its caller carries. '
      + 'Pass --token <bearer> or set RECUED_MCP_TOKEN; create one in Settings → MCP Tokens.',
    );
  }
  const initialBoundContractId = tokenRecord?.contract_id ?? null;
  // A stdio MCP process may outlive token-grant edits, revocation, or a
  // contract-door change. Re-read all three axes for every catalog/call check;
  // never let the startup record become a durable authorization snapshot or
  // silently adopt a token that was rebound to a different contract.
  const authorizeCurrentTokenTool = tokenRecord
    ? createLiveMcpTokenToolAuthorizer({
        inboundTokenStore: chatBundle.inboundTokenStore,
        token_id: tokenRecord.token_id,
        initial_contract_id: initialBoundContractId,
        isContractLive: (contract_id) =>
          executeDepsBundle.executeDeps.contractOverlay?.isContractLive(contract_id) === true,
        permitsMcpDoor: (contract_id) =>
          executeDepsBundle.executeDeps.contractOverlay?.permitsDoorType?.(
            contract_id,
            'mcp',
          ) ?? true,
      })
    : undefined;
  startMCPServer({
    ...executeDepsBundle.executeDeps,
    vaultStore,
    ...(housekeepingStores.stateStore
      ? { housekeepingStateStore: housekeepingStores.stateStore }
      : {}),
    internalRegistry: chatBundle.internalRegistry,
    ...(tokenRecord
      ? {
          mcpTokenId: tokenRecord.token_id,
          mcpPrincipalActive: () => {
            try {
              const current = chatBundle.inboundTokenStore.getTokenById(
                tokenRecord.token_id,
              );
              return current !== null && isMcpInboundTokenActive(current, Date.now());
            } catch {
              return false;
            }
          },
          ...(initialBoundContractId !== null
            ? {
                boundContractId: initialBoundContractId,
                boundContractActive: true,
                mcpRecipeCallbackAuthorize: (pointer) =>
                  pointer.target_token_id === tokenRecord.token_id
                  && pointer.target_contract_id === initialBoundContractId
                  && authorizeCurrentTokenTool?.(pointer.query_tool) === true,
              }
            : {}),
          inboundTokenAuthorize: authorizeCurrentTokenTool,
          mcpShutdownDrain: () =>
            chatBundle.inboundTokenStore.drainAuthorityChanges(),
        }
      : {}),
  });
}
