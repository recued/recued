import { createCollectionAuthenticationService } from '../collection-authentication-service.js';
import { createCollectionOAuthAppSwitchService } from '../collection-oauth-app-switch.js';
import { createOAuthPermissionCleanupService } from '../oauth-permission-cleanup.js';
import { dirname, resolve } from 'node:path';

import type Database from 'better-sqlite3';
import type { RuntimeConfigStore } from '@recued/config';
import type { AuditLogStore } from '@recued/storage';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { ServerAccountStore } from '../account-store.js';
import { GCAL_TOKEN_URL } from '../collections/calendar/gcal-provider.js';
import { GRAPH_CAL_TOKEN_URL } from '../collections/calendar/graph-provider.js';
import {
  registerCalendarCollections,
  type CalendarStack,
} from '../collections/calendar/compose.js';
import type { MailStack } from '../collections/mail/compose.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';
import { GMAIL_TOKEN_URL } from '../collections/mail/gmail-provider.js';
import { GRAPH_TOKEN_URL } from '../collections/mail/graph-provider.js';
import { registerMailCollections } from '../collections/mail/compose.js';
import { createCollectionRegistry, type CollectionRegistry } from '../collections/registry.js';
import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { attachFile } from '../collections/file/attach-file.js';
import type { RemoteFileReadDeps } from '../collections/file/remote-file-byte-resolver.js';
import {
  createInboundFileCollection,
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';
import {
  createUploadStagingRegistry,
  type UploadStagingRegistry,
} from '../collections/file/upload-staging.js';
import { composeCalendarBoot } from '../composition/bin/wire-calendar-stack.js';
import {
  composeConnectionNotification,
  type ConnectionNotificationBundle,
} from '../composition/bin/wire-connection-notification.js';
import { composeMailBoot } from '../composition/bin/wire-mail-stack.js';
import {
  createLateEmailAnswerHook,
  type LateEmailAnswerHook,
} from '../composition/bin/wire-inbound-email-answer.js';
import { createMailFactAnnouncer } from '../mail-facts/announcer.js';
import { createMailChatDoorStore, type MailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { createMailChatSentProof, type MailChatSentProof } from '../mail-chat-door/sent-proof.js';
import { createMailChatConversations, type MailChatConversations } from '../mail-chat-door/conversations.js';
import {
  createMailChatConversationMail,
  MAIL_CHAT_OWNER_ROWS_SQL,
  type MailChatConversationMail,
} from '../mail-chat-door/conversation-mail.js';
import { collectionTableName, setCollectionReaderExclusion } from '../collections/table.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { createMailFactWriter, sweepGoneEmails, type MailFactWriter } from '../mail-facts/fact-writer.js';
import { createHeldMailFactEvents, type HeldMailFactEvents } from '../mail-facts/held-events.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createBackfillStateLookup } from '../triggers/backfill-state.js';
import { bootEventKeep, createBootEventRecorder, type BootEventRecorder } from '../triggers/boot-events.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';
import { situationSubscriberId } from '../triggers/dispatcher.js';
import {
  createMailFactAiRunner,
  MAIL_FACT_AI_MANIFEST,
  mailFactAiCallThrough,
  readMailFactAiEmail,
  type MailFactAiRunner,
} from '../mail-facts/ai-pass.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { isAiPaused, isByokAllowedForBackground } from '../housekeeping/trust-store.js';
import {
  composeSupervisionStack,
  type SupervisionStack,
} from '../supervision/compose-supervision-stack.js';
import type { EventBus } from '../events/bus.js';
import type { KeyManager } from '../key-manager.js';
import type { VaultStateBus } from '../vault-state-bus.js';
import type { ManifestRegistry } from '../manifest-loader.js';
import type { OAuthClientConfigDeps } from '../oauth-client-config-handler.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { oauthAppUses, type OAuthAppConfigHandlerDeps } from '../oauth-app-config-handler.js';
import { createOAuthPermissionService } from '../oauth-permission-consolidation.js';
import { createOAuthAppUsageService } from '../oauth-app-usage-service.js';
import { createOAuthAppRenewalService } from '../oauth-app-renewal-service.js';
import type { OAuthProviderConfig } from '../collections/mail/oauth.js';
import { contactExcludedFromProactive, oauthAppIssuerForProvider, resolveServerTimeZone } from '@recued/contracts';
import { createServerTimeZoneStore } from '../storage/server-timezone-store.js';
import type { IngredientManifest, MailFactEmailRef } from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { CascadeEngine } from '../storage/enrichment-cascade.js';
import type { BlobStore } from '../storage/index.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { WorkEntitySourceWriteExecutor } from '../work-entity-write-executor.js';
import type { GateRegistry } from '../storage-gates.js';
import { createWatcherDispatcher } from '../watchers/index.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService, type AssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createOwnerCompletionWriter } from '../situations/owner-completion.js';
import { createAssetReminderService, type AssetReminderService } from '../situations/asset-reminder-service.js';
import { createHouseholdHomeAssistant, type HouseholdHomeAssistant } from '../situations/household-home-assistant.js';
import { createProactiveLearning, type ProactiveLearning } from '../situations/learning-runtime.js';
import { createProactiveRetention, type ProactiveRetention } from '../situations/proactive-retention.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { decodeAuthFromStorage } from '../connection-auth-storage.js';
import { createOccasionClockService } from '../situations/occasion-clock-service.js';
import { declaredOccasions } from '../situations/declared-occasions.js';
import { createEpisodeRuntime, type EpisodeRuntime } from '../situations/episode-runtime.js';
import { parseWatchedFileRecordId } from '../collections/file/watched-folder-collection.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';
import { selectOwnerNotificationConnection } from '../situations/reminder-destinations.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createNotificationSettingsStore, type NotificationSettings } from '@recued/notification';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createYoursService, type YoursService } from '../situations/yours-service.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { shouldSuppressForQuietHours } from '@recued/contracts';
import { createSituationStore, type SituationStore } from '../storage/situation-store.js';
import { occasionRuleSituation, resolveRuleSituation, ruleSituation } from '../situations/rule-situation.js';
import { createClusterSummary } from '../situations/cluster-summary.js';
import { createScheduledSituations, type ScheduledSituations } from '../situations/scheduled-situations.js';
import { handleNotificationSend } from '../notification-handler.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationNamedPeople } from '../situations/named-people.js';
import { recordDigestResponse } from '../situations/measures.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createAssetClassStore } from '../situations/asset-classes.js';
import { relateTravelDocuments, travelDocumentsVisible } from '../situations/travel-document-relations.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createCollectionTable } from '../collections/table.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  createWebclientUploadService,
  type WebclientUploadService,
} from '../upload/webclient-upload-service.js';
import {
  createWebclientDownloadService,
  type WebclientDownloadService,
} from '../download/webclient-download-service.js';
import {
  createArchiveUploadService,
  type ArchiveUploadService,
} from '../archive/archive-upload-service.js';

type WatcherDispatcher = ReturnType<typeof createWatcherDispatcher>;
type WorkEntityDispatchers = ReturnType<typeof createWorkEntityDispatchers>;

export interface ComposeCollectionContextOptions {
  oauthAppNativePermissionNeeds?: (row: import('../collections/instance-store.js').CollectionInstanceRecord) => import('@recued/contracts').OAuthPermissionNeeds;
  oauthAppPermissionNeeds?: (name: string) => import('@recued/contracts').OAuthPermissionNeeds;
  oauthAppConnectionUses?: (name: string) => { uses: readonly import('@recued/contracts').ManagedOAuthConnectionUse[]; complete: boolean };
  managedOAuthConsumers?: import('../managed-oauth-consumers.js').ManagedOAuthConsumers;
  db: Database.Database | undefined;
  dbPath: string;
  runtimeConfig: RuntimeConfigStore;
  manifests: ManifestRegistry;
  baseVault: Record<string, unknown>;
  auditLog: AuditLogStore | undefined;
  cacheBlobs: BlobStore | undefined;
  warehouseBus: WarehouseEventBus;
  contactStore: ContactStore | undefined;
  /** D-315 — mail facts. Undefined on a dbless boot: mail is then not read
   *  for facts, and nothing else changes. */
  mailFactStore: MailFactStore | undefined;
  gateRegistry: GateRegistry | undefined;
  accountStore: ServerAccountStore | undefined;
  eventBus: EventBus;
  keys: KeyManager | undefined;
  /** Vault-state bus — drives the mail/calendar poll loops'
   *  pause-while-locked / resume-on-unlock (parity with the autonomous
   *  executors, `vault-gated-executors.ts`). Absent ⇒ no gating (the stacks
   *  default to always-sync). */
  vaultStateBus?: VaultStateBus;
  connectionStore: ConnectionStoreSqlite | undefined;
  workEntityStore: WorkEntityStore | undefined;
  enrichmentCascade: CascadeEngine | undefined;
  /** D-192 P4b — late-bound getter over the app context's write-
   *  executor ref (populated post-listener once the gateway fetch deps
   *  exist). Threaded into the work-entity dispatchers. */
  getWorkEntityWriteExecutor?: () => WorkEntitySourceWriteExecutor | null;
  annotationDeps?: AnnotationRpcDeps;
  /** D-192 remote byte-fetch — the shared `remote` bundle so a `MailCollection.send`
   *  attachment `file:remote:*` ref resolves the mirrored vendor's bytes instead of
   *  `MAIL_SEND_ATTACHMENT_UNRESOLVABLE`. Read lazily; undefined ⇒ a remote ref 501s
   *  (the pre-byte-fetch posture). */
  getRemoteFileReadDeps?: () => RemoteFileReadDeps | undefined;
  /** D-315 §4.3 — one model call through the chat's privacy layer. Absent ⇒
   *  the mail facts' AI pass cannot call a model, and says so on each fact. */
  privateAiCall?: ExecuteChatAiCall;
  /** D-315 §4.3 — the owner's daily token budget has reached the point where
   *  background work stops. Absent ⇒ never. */
  backgroundAiBudgetSpent?: () => boolean;
}

export interface CollectionContext extends ConnectionNotificationBundle {
  collectionAuthentication?: import('../collection-authentication-service.js').CollectionAuthenticationService;
  collectionOAuthAppSwitch?: import('../collection-oauth-app-switch.js').CollectionOAuthAppSwitchService;
  inboundFileCollection: InboundFileCollection | undefined;
  // D-172 resumable uploads — the webclient upload service (chunk-core + finalize
  // policy). Present iff `inboundFileCollection` + CAS are wired; backs the
  // `upload.*` rpc + the binary `/ws/upload` socket + the housekeeping sweeper.
  uploadService: WebclientUploadService | undefined;
  // M4 archive download — streams a finished export file off disk over the
  // binary `/ws/download` socket. Needs only the data dir (exports live there),
  // so it's present on any db boot, independent of the CAS / file collection.
  downloadService: WebclientDownloadService | undefined;
  // M4b.1 archive upload (no-SSH migrate) — accepts a resumable archive upload
  // over the binary `/ws/archive-upload` socket + STAGES it under `exports/` for
  // `server.archive.import`. Needs db (shared upload_session store) + the data
  // dir; present on any db boot (independent of the CAS / file collection).
  archiveUploadService: ArchiveUploadService | undefined;
  /** D-217 slice 2b-ii — staged plaintext for chunked EGRESS, addressed by
   *  token. Read through two `connection.api` adapter deps that never hold the
   *  handle themselves: `uploadStaging` (stages + disposes) and
   *  `readUploadChunk` (one range per APPEND).
   *  Present iff the CAS file collection is; absent ⇒ a chunked upload fails
   *  closed. */
  uploadStagingRegistry: UploadStagingRegistry | undefined;
  calendarStack: CalendarStack | undefined;
  mailStack: MailStack | undefined;
  /** D-315 — the one mail-fact writer: the ingest's, and a backfill's (§6.3).
   *  Undefined on a dbless boot. */
  mailFactWriter: MailFactWriter | undefined;
  /** D-315 §4.3 — the trigger queue's room, bound once the trigger dispatcher
   *  is composed (after this context): an AI answer that may start recipes
   *  waits for it. Unbound, nothing waits. */
  mailFactTriggerRoom: { current?: () => Promise<void> };
  /** D-318 P23 — the email-approval reply check's holder. The mail stack calls
   *  it on every upsert; the listeners' composition binds it once the
   *  notification block exists, and until then it keeps the approval-tagged
   *  mail a boot scan reads. */
  emailAnswerHook: LateEmailAnswerHook;
  /** D-318 step 1 — the email chat door's settings, which name the chat mailbox.
   *  ONE store per server: the mail stack, the trigger dispatcher and the rpc
   *  read this one. Undefined on a dbless boot. */
  mailChatDoor: MailChatDoorStore | undefined;
  /** D-318 step 2 — proof (a): each message in the chat mailbox checked against
   *  the owner's own Sent record. The mail stack records them as they land; the
   *  listeners' composition binds the owner's notice and starts the checks,
   *  once every mailbox is registered. Undefined on a dbless boot. */
  mailChatProof: MailChatSentProof | undefined;
  /** D-318 §4.13 — the door's conversations, Recued's own ids by Message-ID:
   *  the proof asks whether a reply continues one (step 4), the turns record
   *  each request in one (step 3). One store per server. Undefined on a dbless
   *  boot. */
  mailChatConversations: MailChatConversations | undefined;
  /** D-318 step 5 — what in the owner's other mailboxes is the conversation
   *  with the chat mailbox (answers, and the Sent copies of requests): left out
   *  of contacts, mail facts, mail recipes and housekeeping, as the chat
   *  mailbox's own mail is. Undefined on a dbless boot. */
  mailChatConversationMail: MailChatConversationMail | undefined;
  /** D-318 audit — did Recued send mail under this reconciliation id (its send
   *  claims)? Only then is a message carrying one Recued's own: the mail facts
   *  and the conversation leave out what this says, never what a header says.
   *  Undefined on a dbless boot. */
  isOwnSend: ((reconciliation_id: string) => boolean) | undefined;
  /** D-315 §6.3 — resolves once no AI call holding news waits on an email,
   *  with the events its answers told: a backfill that runs recipes waits
   *  for it before the next email. With no AI pass, at once. */
  mailFactAiSettled: (email: MailFactEmailRef) => Promise<number>;
  /** D-315 §5 — the fact writer's events, held until the trigger dispatcher
   *  subscribes: the mailboxes start, and a restart's scan reads the mail that
   *  came meanwhile, before it does. Opened by the listeners' composition. */
  mailFactEvents: HeldMailFactEvents;
  /** D-124 — what the collections' boot scans find reaches the bus before the
   *  trigger dispatcher subscribes: the events a trigger would have been told
   *  of (`BOOT_EVENT_KINDS`), recorded for it. Sealed and replayed by the
   *  listeners' composition. */
  bootEvents: BootEventRecorder;
  /** Supervision feature — cli-daemon keep-alive stack. Undefined on a db-less
   *  boot. Its cli executor is late-bound at the collection/execution
   *  convergence point. */
  supervisionStack: SupervisionStack | undefined;
  collectionRegistry: CollectionRegistry;
  watcherDispatcher: WatcherDispatcher;
  workEntityDispatchers: WorkEntityDispatchers | undefined;
  assetOccurrences?: AssetOccurrenceService;
  assetReminders?: AssetReminderService;
  yours?: YoursService;
  scheduledSituations?: ScheduledSituations;
  episodeRuntime?: EpisodeRuntime;
  proactiveLearning?: ProactiveLearning;
  proactiveRetention?: ProactiveRetention;
  situationStore?: SituationStore;
  querySituation?: ReturnType<typeof createSituationQuery>;
  spheres?: ReturnType<typeof createSphereStore>;
  oauthClientConfigDeps: OAuthClientConfigDeps;
  /** BYO OAuth app config rpc deps (get/set/clear). Absent on a db-less boot. */
  oauthAppConfigDeps?: OAuthAppConfigHandlerDeps;
  startCollectionAdapters: () => Promise<void>;
}

export const composeCollectionContext = (
  options: ComposeCollectionContextOptions,
): CollectionContext => {
  const {
    db,
    dbPath,
    runtimeConfig,
    manifests,
    baseVault,
    auditLog,
    cacheBlobs,
    warehouseBus,
    contactStore,
    mailFactStore,
    gateRegistry,
    accountStore,
    eventBus,
    keys,
    vaultStateBus,
    connectionStore,
    workEntityStore,
    enrichmentCascade,
    annotationDeps,
    getRemoteFileReadDeps,
    privateAiCall,
    backgroundAiBudgetSpent,
  } = options;

  // Vault-lock predicate for the mail/calendar poll loops — LOCKED (or
  // uninitialized) defers each live sync at boot; the vault→unlocked edge
  // (below) resumes it. No `keys` (dbless / harness) ⇒ always-unlocked (no
  // vault to seal), so behaviour is unchanged there.
  const isVaultUnlocked = (): boolean => !keys || keys.state() === 'unlocked';

  // D-172 P2 — created up-front (ahead of the calendar/mail boots) so the
  // mail stack's lazy `fileReadDeps` closure can reference it; the
  // registry has no dependency on any stack, so the early declaration is
  // order-safe.
  const collectionRegistry = createCollectionRegistry();

  const inboundFileCollection = (() => {
    if (!db || !cacheBlobs || !gateRegistry) return undefined;
    const gateName = 'collection:file:received';
    const gate = gateRegistry.get(gateName) ?? gateRegistry.register(gateName, {
      quota: 512 * 1024 * 1024,
      reservePct: 10,
      initialUsage: 0,
    });
    const collection = createInboundFileCollection({
      db,
      blobs: cacheBlobs,
      gate,
      bus: warehouseBus,
      slug: 'received',
      ...(auditLog ? { auditLog } : {}),
    });
    gate.setUsed(collection.totalBytes());
    collectionRegistry.register(collection);
    return collection;
  })();

  // D-172 resumable uploads — the webclient consumer's upload service. All four
  // deps are co-located here (db, the CAS BlobStore, the data dir for the
  // scratch root, and the just-built finalize target). The scratch tree is a
  // data-volume sibling of the CAS objects (`upload_blobs`), mirroring the
  // reception `drop_blobs` root + the messenger media scratch dir. Present iff
  // the file collection itself is wired (same db/CAS gate).
  const uploadService = (() => {
    if (!db || !cacheBlobs || !inboundFileCollection) return undefined;
    // The effective per-create size cap is bounded by the finalize surface's
    // user-content capacity (D-172 size-cap alignment): a single file that can
    // never fit the `collection:file:received` surface is rejected at create.
    // `available` = quota - reserve (the user-content ceiling) and is read live
    // so a reconfigured quota takes effect. This is a per-FILE ceiling, NOT a
    // usage-aware total-budget check — total-storage pressure is the gate's
    // accounting + pressure job (the file ingest path accounts, never rejects),
    // uniform across every ingest source (mail / reception / messenger).
    const fileGate = gateRegistry?.get('collection:file:received');
    return createWebclientUploadService({
      db,
      blobs: cacheBlobs,
      uploadsRoot: resolve(dirname(dbPath), 'upload_blobs'),
      inboundFileCollection,
      ...(fileGate ? { availableBytes: () => fileGate.info().available } : {}),
    });
  })();

  // D-217 slice 2b-ii — the chunked-upload staging registry. Built HERE
  // because this is the one place the three things it needs are already
  // co-located: the CAS blob store (to decrypt from), the data dir (where the
  // scratch file lands, and the same dir the boot sweep walks), and the file
  // collection (to resolve a `file_ref` to its carrier). Present iff the file
  // collection is — a boot with no CAS has no plaintext to stage, and a
  // chunked upload there fails closed rather than sending an empty body.
  const uploadStagingRegistry = (db && cacheBlobs && inboundFileCollection)
    ? createUploadStagingRegistry({
        blobs: cacheBlobs,
        dataPath: dirname(dbPath),
        files: inboundFileCollection,
      })
    : undefined;

  // M4 archive download — only needs the data dir (exports live in
  // `<dataPath>/exports/`, the same dir the archive runtime resolves from),
  // independent of the CAS / file collection the upload service requires. Gated
  // on `db` so a db-less harness doesn't expose the `/ws/download` socket — the
  // archive export rpc that produces these files is db-gated too.
  const downloadService = db
    ? createWebclientDownloadService({ dataPath: dirname(dbPath) })
    : undefined;

  // M4b.1 archive upload (no-SSH migrate) — the upload → stage-to-path service.
  // Shares the one `upload_session` store + `upload_blobs` scratch root with the
  // webclient consumer (so the existing `upload-session-sweep` reaps its
  // sessions too) and stages finalized archives under `<dataPath>/exports/`. Db-
  // gated like the download service: the archive import rpc it feeds is db-gated.
  const archiveUploadService = db
    ? createArchiveUploadService({
        db,
        uploadsRoot: resolve(dirname(dbPath), 'upload_blobs'),
        dataPath: dirname(dbPath),
      })
    : undefined;

  // BYO OAuth app credentials (per-issuer, UI-entered). The store persists the
  // owner's Google/Microsoft client_id + client_secret (secret encrypted under
  // the same `server-data` sub-DEK the LLM config + cache use); the resolver is
  // what BOTH read seams consult — stored credentials win, the `RECUED_*` env
  // consts are the fallback. Resolving PER CALL (not at boot) means a credential
  // saved at runtime is picked up by the next exchange + token refresh without a
  // restart.
  const oauthAppConfigStore =
    db !== undefined
      ? createOAuthAppConfigStore(db, {
          // Pass the LIVE key closure whenever a key manager exists — it
          // resolves the sub-DEK PER CALL (returns null until unlocked), so it
          // is safe to obtain even when the vault is still uninitialized at
          // boot. Gating on `state() !== 'uninitialized'` (Codex F1) would hand
          // a brand-new server — vault set up AFTER this compose runs — a
          // key-LESS store that then writes fresh secrets in PLAINTEXT. With
          // the closure, an unlocked vault encrypts and a locked/uninitialized
          // one makes setSensitive throw `locked` instead.
          ...(keys ? { getEncryptionKey: keys.keyProvider('server-data') } : {}),
        })
      : undefined;

  /** THE per-use credential fetch (no boot binding, no cache). Returns the
   *  effective `{ clientId, clientSecret, tokenUrl }` for a provider from the
   *  encrypted store (all-or-nothing per issuer), else `null`. The provider's
   *  fixed `tokenUrl` — a protocol constant, the only OAuth thing still shipped
   *  in the binary — is supplied by the caller. Touches the secret (decrypts —
   *  may throw on a locked server), so it's called only at the moment of use
   *  (enroll/refresh), when the vault is unlocked. The client_id-only authorize
   *  read below does NOT use this (no secret, never throws).
   *
   *  There is NO fallback tier behind the store: the six `RECUED_*` OAuth env
   *  vars were deleted 2026-07-28 (plaintext process-env secret + it bypassed
   *  the vault lock). Unconfigured ⇒ `null` ⇒ enroll surfaces
   *  `not_configured`, which the Accounts UI renders as its setup step. */
  const resolveOAuthProviderConfig = (
    provider: 'gmail' | 'gcal' | 'graph',
    tokenUrl: string, appId?: string,
  ): OAuthProviderConfig | null => {
    const issuer = oauthAppIssuerForProvider(provider);
    const storedId = oauthAppConfigStore?.getClientId(issuer, appId) ?? null;
    const storedSecret = storedId ? oauthAppConfigStore!.getClientSecret(issuer, appId) : null;
    // A stored issuer is used ONLY when BOTH id + secret are present (Codex F2):
    // a half-written row (id-without-secret — only reachable if a write failed)
    // must not post a secretless code-exchange against the real provider. The
    // store writes both atomically, so this is belt-and-braces.
    if (storedId && storedSecret !== null) {
      return { tokenUrl, clientId: storedId, clientSecret: storedSecret };
    }
    return null;
  };

  const calendarStack = composeCalendarBoot({
    ...(options.managedOAuthConsumers ? { managedOAuth: options.managedOAuthConsumers } : {}),
    db,
    cacheBlobs,
    warehouseBus,
    // Same lazy rationale as mail's below — makes a post-boot calendar enroll
    // readable without a restart.
    getCollectionRegistry: () => collectionRegistry,
    ...(auditLog ? { auditLog } : {}),
    ...(contactStore ? { contactStore } : {}),
    gateRegistry,
    ...(accountStore ? { accountStore } : {}),
    isVaultUnlocked,
    // Per-use credential resolver (store-only). The calendar factories always
    // register; this decides availability at enroll + on each refresh.
    resolveOAuthConfig: (adapter, appId) =>
      resolveOAuthProviderConfig(adapter, adapter === 'gcal' ? GCAL_TOKEN_URL : GRAPH_CAL_TOKEN_URL, appId),
  });

  // D-315 — the fact writer: the mail ingest reads every upsert through it and
  // a backfill re-reads past mail through it (§6.3). It emits on the bus the
  // mail rows do, and tells the Mail facts screens, at most once a second,
  // that facts or a template's health moved.
  // The AI pass (§4.3) is built once the mailboxes exist, below; the writer
  // starts it after a commit that queued a call.
  let mailFactAi: MailFactAiRunner | undefined;
  const mailFactTriggerRoom: { current?: () => Promise<void> } = {};
  const mailFactLogger = { warn: (message: string, detail?: unknown) => console.log(`[mail-facts] ${message}`, detail ?? '') };
  // A fact announces once: its events wait until a trigger can hear them.
  const mailFactEvents = createHeldMailFactEvents((event) => warehouseBus.emit(event), mailFactLogger);
  // D-124 — the collections start, and their boot scans read what came while
  // the server was down, before the trigger dispatcher subscribes: what a
  // trigger would have been told of is recorded for the dispatcher, kept as
  // the dispatcher itself would take it — a first scan finds what was already
  // there, which fires nothing (Phase 2.2).
  const bootBackfillState = db !== undefined ? createBackfillStateLookup({ instances: createInstanceStore({ db }) }) : undefined;
  const bootEvents = createBootEventRecorder({
    bus: warehouseBus,
    pattern: '**',
    keep: bootEventKeep(bootBackfillState),
    logger: { warn: (message, detail) => console.warn(`[event-triggers] ${message}`, detail ?? '') },
  });
  const mailFactWriter: MailFactWriter | undefined = mailFactStore
    ? createMailFactWriter({
        store: mailFactStore,
        emit: mailFactEvents.emit,
        now: () => Date.now(),
        logger: mailFactLogger,
        onChanged: createMailFactAnnouncer((subkind) => {
          eventBus.emit({ kind: 'mail_fact', subkind });
        }).announce,
        onAiQueued: () => mailFactAi?.kick(),
      })
    : undefined;

  const emailAnswerHook = createLateEmailAnswerHook();
  const mailChatDoor = db !== undefined ? createMailChatDoorStore(db) : undefined;
  const mailChatConversations = db !== undefined ? createMailChatConversations(db) : undefined;
  // D-318 audit — every reader of the owner's mail that lists the mail tables
  // (housekeeping producers, the contact backfill, the CRM twin join) leaves out
  // a chat-only mailbox's table — its mail is the conversation, strangers' too —
  // and, in the owner's mailboxes, the rows marked as the conversation. ⛔ One
  // mailbox (§8.18): a chat mailbox that is one of the owner's own too is their
  // mail, and only its marked rows are left out.
  if (db !== undefined && mailChatDoor !== undefined) {
    setCollectionReaderExclusion(db, {
      tables: (platform, table) => {
        const chat = mailChatDoor.get().chat_mailbox;
        return platform === 'mail' && chat !== null && mailChatDoor.isChatOnlyMailbox(chat)
          && table === collectionTableName('mail', chat);
      },
      rows: { mail: MAIL_CHAT_OWNER_ROWS_SQL },
    });
  }
  // D-318 audit — what Recued itself sent: a reconciliation id its own send
  // claims hold, never a header any sender can write.
  const isOwnSend = db !== undefined
    ? (() => {
        const claims = createMailSendClaimStore(db);
        return (reconciliation_id: string): boolean => claims.get(reconciliation_id) !== null;
      })()
    : undefined;
  // Typed: it and the proof below each ask the other, late.
  const mailChatConversationMail: MailChatConversationMail | undefined = mailChatDoor !== undefined
    ? createMailChatConversationMail({
        door: mailChatDoor,
        mailbox: (slug) => collectionRegistry.get('mail', slug) as MailCollection | undefined,
        ...(isOwnSend ? { isOwnAnswer: isOwnSend } : {}),
        // One mailbox (§8.18) — a reply in a conversation is the conversation,
        // as the proof reads it. Late: the proof is made just below, and mail
        // syncs only once the mail stack starts.
        continues: (slug, references) => mailChatProof?.continuesConversation(slug, references) === true,
        // ...and an email delivered on its provider's word stops being the
        // conversation once the proof refutes it.
        refuted: (slug, rfc_message_id) => mailChatProof?.refuted(slug, rfc_message_id) === true,
      })
    : undefined;
  const mailChatProof: MailChatSentProof | undefined = db !== undefined && mailChatDoor !== undefined
    ? createMailChatSentProof({
        db,
        door: mailChatDoor,
        ...(mailChatConversations ? { conversations: mailChatConversations } : {}),
        mailboxes: () => collectionRegistry.list()
          .filter((collection): collection is MailCollection => collection.platform === 'mail'),
        ...(auditLog ? { auditLog } : {}),
        isUnlocked: isVaultUnlocked,
        // One mailbox (§8.18) — an email the proof refutes is the owner's mail again.
        ...(mailChatConversationMail
          ? { onNotProven: (slug: string, record_id: string) => mailChatConversationMail.unmark(slug, record_id) }
          : {}),
        log: (level, msg, data) => {
          const fn = level === 'warn' ? console.warn : console.log;
          fn(`[mail-chat] ${msg}`, data ?? '');
        },
      })
    : undefined;
  let episodeRuntime: EpisodeRuntime | undefined;
  const mailStack = composeMailBoot({
    ...(options.managedOAuthConsumers ? { managedOAuth: options.managedOAuthConsumers } : {}),
    db,
    cacheBlobs,
    warehouseBus,
    ...(auditLog ? { auditLog } : {}),
    ...(contactStore ? { contactStore } : {}),
    // D-315 — every upsert is read for mail facts, through the one writer.
    ...(mailFactWriter ? { mailFactWriter } : {}),
    ...(db && workEntityStore && mailFactStore ? { onBeforeRetention: async (slug: string, cutoff: number) => {
      if (!episodeRuntime) throw new Error('History capture must be ready before mail retention');
      await episodeRuntime.captureBeforeRetention(slug, cutoff);
    } } : {}),
    // D-318 P23 — and checked for a proven reply to an emailed ask.
    emailAnswerHook: (msg, ctx) => emailAnswerHook.run(msg, ctx),
    // D-318 step 1 — a chat-only mailbox's mail is the conversation: no contacts, no facts.
    ...(mailChatDoor ? { isChatOnlyMailbox: (slug: string) => mailChatDoor.isChatOnlyMailbox(slug) } : {}),
    // Step 5 — nor its answers and requests in the owner's other mailboxes.
    ...(mailChatConversationMail ? { isChatConversationMail: mailChatConversationMail.isConversationMessage } : {}),
    // The audit — Recued's own mail is known by its send claims.
    ...(isOwnSend ? { isOwnSend } : {}),
    // D-318 step 2 — and each message that lands in it recorded, to be proven
    // the owner's by their own Sent record.
    ...(mailChatProof ? { chatRequestHook: mailChatProof.onMessageStored } : {}),
    // Step 4 — and its files recorded once stored, so its turn carries them.
    ...(mailChatProof ? { chatFilesHook: mailChatProof.onMessageUpserted } : {}),
    // The audit — a deleted mailbox is forgotten by the door.
    onMailboxDeleted: (slug: string) => { mailChatDoor?.forgetMailbox(slug); episodeRuntime?.forgetSource(slug); },
    gateRegistry,
    ...(accountStore ? { accountStore } : {}),
    isVaultUnlocked,
    // Same lazy rationale as `fileReadDeps` below — `collectionRegistry` is
    // declared above this const but the closure only runs when a collection goes
    // live. Supplying it is what makes a post-boot enroll readable without a
    // restart; `startCollectionAdapters` alone registered only what existed AT
    // boot.
    getCollectionRegistry: () => collectionRegistry,
    // Per-use credential resolver (store-only), for the initial exchange
    // (enroll) + token refresh (via buildProvider's per-use resolver).
    resolveOAuthConfig: (provider, appId) =>
      resolveOAuthProviderConfig(provider, provider === 'gmail' ? GMAIL_TOKEN_URL : GRAPH_TOKEN_URL, appId),
    // D-172 P2 — lazy file-read deps so MailCollection.send can resolve
    // outbound `attachments` refs into bytes via the Gateway-gated
    // file.read (handleFileRead). Lazy because `collectionRegistry` is
    // declared below; the closure is only invoked at send time (long
    // after this const is initialized), so there is no TDZ hazard. Yields
    // undefined on dbless / no-CAS boots — attachment sends then throw
    // MAIL_SEND_ATTACHMENT_UNRESOLVABLE rather than silently dropping.
    fileReadDeps: () => {
      if (!cacheBlobs) return undefined;
      // D-192 — an attachment `file:remote:*` ref resolves the mirrored vendor's
      // bytes via the shared bundle; a CAS ref takes the existing path.
      const remote = getRemoteFileReadDeps?.();
      return {
        registry: collectionRegistry,
        blobs: cacheBlobs,
        ...(auditLog ? { auditLog } : {}),
        ...(remote ? { remote } : {}),
      };
    },
    inboundAttachmentDeps: () =>
      inboundFileCollection && annotationDeps
        ? {
            fileIngestor: inboundFileCollection,
            attach: attachFile,
            attachDeps: { annotationDeps, registry: collectionRegistry },
          }
        : undefined,
  });

  // D-315 §4.3 — the AI pass: queued, one call at a time, through the chat's
  // privacy layer, reading the stored copy of each email. What a restart left
  // queued is read once the mailboxes are live (`startCollectionAdapters`):
  // kicked any sooner, it would find no mailbox and settle every job as gone.
  if (db && mailFactStore && mailFactWriter && cacheBlobs) {
    const flag = (read: () => boolean): boolean => {
      try {
        return read();
      } catch {
        return false; // no housekeeping config yet: not paused, no background BYOK
      }
    };
    mailFactAi = createMailFactAiRunner({
      store: mailFactStore,
      writer: mailFactWriter,
      readEmail: readMailFactAiEmail({
        blobs: cacheBlobs,
        mailboxes: () => collectionRegistry.list()
          .filter((collection): collection is MailCollection => collection.platform === 'mail'),
      }),
      call: mailFactAiCallThrough(privateAiCall, MAIL_FACT_AI_MANIFEST),
      isPaused: () => flag(() => isAiPaused(db, Date.now())),
      byokAllowed: () => flag(() => isByokAllowedForBackground(db)),
      ...(backgroundAiBudgetSpent !== undefined ? { budgetSpent: () => flag(backgroundAiBudgetSpent) } : {}),
      // A job whose mailbox is not live yet waits for it.
      mailboxLive: (slug) => collectionRegistry.get('mail', slug) !== undefined,
      // An answer that may start recipes waits for room in the trigger queue.
      triggerRoom: () => mailFactTriggerRoom.current?.() ?? Promise.resolve(),
      now: () => Date.now(),
      logger: mailFactLogger,
    });
  }

  // Supervision feature — cli-daemon keep-alive: started at boot (startAll),
  // disposed at shutdown, read by the ws-server rpc. The cli
  // executor it launches through is built later in `compose-execution-context`,
  // so it's bound post-compose via `bindExecutor` (see the convergence point in
  // `start-post-app-collection-execution-runtime`). Absent on a db-less boot.
  const supervisionStack = db
    ? composeSupervisionStack({
        db,
        dataPath: dirname(dbPath),
        getManifest: (slug) => manifests.get(slug) ?? undefined,
        // Discovery source for `supervision.list` — read live off the registry
        // so an install/uninstall is reflected without a reseed.
        getManifests: () =>
          manifests.slugs()
            .map((slug) => manifests.get(slug))
            .filter((m): m is IngredientManifest => m !== null),
        // Live-state push — fan a `supervision` broadcast on a daemon state
        // transition (crash / auto-restart / ceiling) so paired clients re-list
        // the pack-detail controls without polling. The bus stamps the cursor.
        broadcast: (change) => eventBus.emit({ kind: 'supervision', ...change }),
        // D-120 audit — one reserve-class row per daemon lifecycle transition.
        ...(auditLog ? { auditLog } : {}),
      })
    : undefined;

  // The owner's zone (D-269): for judging a date-only deadline by its day, and
  // for reading a `core.watch.time` window on the same clock as cron schedules.
  const serverZoneStore = db ? createServerTimeZoneStore(db) : undefined;
  const serverTimeZone = (): string => resolveServerTimeZone(
    serverZoneStore?.read(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const watcherDispatcher = createWatcherDispatcher({
    collectionRegistry,
    serverTimeZone,
    ...(db ? { db } : {}),
    ...(workEntityStore ? { workEntityStore } : {}),
  });

  const {
    notificationDeps,
    notificationHandler,
    channelDispatchers,
  } = composeConnectionNotification({
    connectionStore,
    keys,
    eventBus,
    collectionRegistry,
    // D-325 P31/P43 — the brief, day-of notes and plain reminders send through
    // the connection the owner named in Settings, never a household one.
    ...(db ? { selectConnection: async (channel: string, rows: readonly import('@recued/contracts').ConnectionRow[]) => selectOwnerNotificationConnection({
      settings: await createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')).get(),
      channel, rows, isHousehold: row => createHouseholdDeliveryStore(db).isHousehold(row) }) } : {}),
  });

  const situationStore = db ? createSituationStore(db, warehouseBus) : undefined;
  let assetOccurrences: AssetOccurrenceService | undefined;
  let assetReminders: AssetReminderService | undefined;
  let householdHomeAssistant: HouseholdHomeAssistant | undefined;
  const householdCatalogBindings = db ? createConnectionCatalogBindingStore(createContractStore(db)) : undefined;
  const proactiveHistory = db ? createProactiveHistoryStore(db, createProactiveProposalStore(db)) : undefined;
  const situationCalendars = new Map<string, ReturnType<typeof createCalendarTable>>();
  const situationMailboxes = new Map<string, ReturnType<typeof createCollectionTable>>();
  const localSituationMailboxes = () => db ? collectionRegistry.list().filter(collection => collection.platform === 'mail').map(collection => {
    let table = situationMailboxes.get(collection.slug);
    if (!table) { table = createCollectionTable({ db, platform: 'mail', slug: collection.slug }); situationMailboxes.set(collection.slug, table); }
    return { slug: collection.slug, table };
  }) : [];
  const localSituationCalendars = () => db ? collectionRegistry.list().filter(collection => collection.platform === 'calendar').map(collection => {
    let table = situationCalendars.get(collection.slug);
    if (!table) { table = createCalendarTable({ db, slug: collection.slug }); situationCalendars.set(collection.slug, table); }
    return { slug: collection.slug, table };
  }) : [];
  const workEntityDispatchers = workEntityStore
    ? createWorkEntityDispatchers({
        store: workEntityStore,
        ...(db ? { ownerCompletionWrite: createOwnerCompletionWriter(db, workEntityStore) } : {}),
        resolver: createWorkEntityResolver(workEntityStore),
        timeZone: serverTimeZone,
        bus: warehouseBus,
        annotationCascadeOnDelete: (collection, id) => options.annotationDeps?.store.cascadeDelete(collection, id),
        onAssetChanged: async (asset) => {
          try {
            if (['sold', 'lost', 'retired'].includes(asset.status)) await assetOccurrences?.retireAsset(asset.id);
            else await assetOccurrences?.reconcileAsset(asset.id);
          } catch (error) { console.warn('[assets] immediate clock reconcile failed; the minute service will retry', error); }
        },
        onAssetDeleted: async (asset) => {
          try { await assetOccurrences?.retireAsset(asset.id); }
          catch (error) { console.warn('[assets] retirement reconcile failed; the minute service will retry', error); }
        },
        ...(enrichmentCascade ? { cascade: enrichmentCascade } : {}),
        ...(options.getWorkEntityWriteExecutor
          ? { getWriteExecutor: options.getWorkEntityWriteExecutor }
          : {}),
      })
    : undefined;
  if (db && workEntityStore && workEntityDispatchers && situationStore) {
    assetOccurrences = createAssetOccurrenceService({ db, work: workEntityStore, dispatchers: workEntityDispatchers,
      timeZone: serverTimeZone, isVaultUnlocked: () => keys === undefined || keys.state() === 'unlocked',
      withdraw: async id => { assetReminders?.withdraw(id); },
      emitRule: async input => { situationStore.save(ruleSituation(input), { source: `asset-rule:${input.occurrence.id}` }, Date.now()); },
      cycleEnded: occurrence => { resolveRuleSituation(situationStore, occurrence.id, `asset-rule:${occurrence.id}`, Date.now()); },
      outcome: async input => {
        resolveRuleSituation(situationStore, input.occurrence.id, `commitment:${input.commitment.id}`, input.commitment.lifecycle_changed_at);
        situationStore.measure('clock.closure', 1, { outcome: input.commitment.lifecycle_state,
          class: input.asset.class_id ?? 'unclassified', rule_kind: input.rule?.when.kind ?? 'unknown' }, input.commitment.lifecycle_changed_at, `clock-close:${input.occurrence.id}`);
      },
    });
    const quiet = createQuietHoursStore(db);
    householdHomeAssistant = createHouseholdHomeAssistant({ db, work: workEntityStore, occurrences: assetOccurrences, isVaultUnlocked,
      connections: () => (connectionStore?.list({ kind: 'api' }) ?? []).filter(row => householdCatalogBindings?.catalogsForConnection(row.name).includes('home-assistant')),
      credential: async row => { const auth = await decodeAuthFromStorage(row.auth_ciphertext, { kind: row.kind, name: row.name }, keys?.keyProvider('connection'));
        return auth.type === 'bearer' && typeof auth.token === 'string' && auth.token ? auth.token : null; },
    });
    assetReminders = createAssetReminderService({ db, work: workEntityStore, dispatchers: workEntityDispatchers,
      occurrences: assetOccurrences, timeZone: serverTimeZone,
      projectHousehold: () => householdHomeAssistant!.tick(),
      householdDestinations: async () => createHouseholdDeliveryStore(db).destinations(connectionStore?.list({ kind: 'notification' }) ?? []),
      additionalSubjects: createOccasionClockService({ db, work: workEntityStore, dispatchers: workEntityDispatchers,
        timeZone: serverTimeZone, isVaultUnlocked: () => keys === undefined || keys.state() === 'unlocked',
        withdraw: id => assetReminders?.withdraw(id),
        declared: () => declaredOccasions({ ...(contactStore ? { contacts: contactStore } : {}), calendars: localSituationCalendars,
          timeZone: serverTimeZone, place: value => proactiveHistory!.place(value), sphere: (ref, source) => spheres?.resolve(ref, source).sphere }),
        excludedPerson: id => { const contact = contactStore?.getByContactIdResolved(id) ?? contactStore?.get(id); return !!contact && contactExcludedFromProactive(contact); },
        emitRule: input => { situationStore.save(occasionRuleSituation(input), { source: `occasion-rule:${input.occurrence.id}` }, Date.now()); },
        cycleEnded: occurrence => { resolveRuleSituation(situationStore, occurrence.id, `occasion-rule:${occurrence.id}`, Date.now()); },
        outcome: input => {
          resolveRuleSituation(situationStore, input.occurrence.id, `commitment:${input.commitment.id}`, input.commitment.lifecycle_changed_at);
          situationStore.measure('clock.closure', 1, { outcome: input.commitment.lifecycle_state,
          class: input.occasion.class_id ?? 'occasion', rule_kind: 'annual' }, input.commitment.lifecycle_changed_at, `clock-close:${input.occurrence.id}`); },
      }),
      isVaultUnlocked: () => keys === undefined || keys.state() === 'unlocked',
      isQuiet: instant => shouldSuppressForQuietHours({ policy: quiet.read(), instant, timeZone: serverTimeZone() }),
      measure: (...args) => { situationStore.measure(...args); },
      ownerResponse: (refs, at) => recordDigestResponse(situationStore, refs, at),
    });
  }
  const spheres: ReturnType<typeof createSphereStore> | undefined = db && workEntityStore ? createSphereStore(db, workEntityStore, id =>
    (contactStore?.getByContactIdResolved(id) ?? contactStore?.get(id))?.relationship, ref => {
      if (ref.collection === 'episode' || ref.collection === 'history_trace') {
        const sphere = episodeRuntime?.referenceSphere(ref); if (sphere) return { sphere };
      }
      if (ref.collection === 'calendar') {
        const colon = ref.id.indexOf(':'); if (colon < 1) return undefined;
        const slug = ref.id.slice(0, colon);
        if (!collectionRegistry.list().some(row => row.platform === 'calendar' && row.slug === slug)) return undefined;
        let table = situationCalendars.get(slug); if (!table) { table = createCalendarTable({ db, slug }); situationCalendars.set(slug, table); }
        const row = table.getByRecordId(ref.id.slice(colon + 1)); return row ? { source: `calendar:${slug}:${row.hot.calendar_id}` } : undefined;
      }
      if (ref.collection === 'mail_fact' && options.mailFactStore) {
        const facts = options.mailFactStore.factsForThing(ref.id);
        const slugs = [...new Set(facts.map(fact => fact.email.slug))];
        if (slugs.length === 1) return { source: `mail:${slugs[0]}` };
        const known = facts.map(fact => spheres?.resolve({ collection: 'mail', id: `${fact.email.slug}:${fact.email.record_id}` }).sphere);
        return known.length && known.every(value => value !== undefined && value === known[0]) ? { sphere: known[0] } : undefined;
      }
      return undefined;
    }) : undefined;
  if (db && workEntityStore && situationStore) episodeRuntime = createEpisodeRuntime({ db, work: workEntityStore, situations: situationStore,
    ...(mailFactStore ? { mailFacts: mailFactStore } : {}), ...(contactStore ? { contacts: contactStore } : {}),
    calendars: localSituationCalendars, mailboxes: localSituationMailboxes, timeZone: serverTimeZone, isVaultUnlocked,
    photoFilePath: id => {
      const parsed = parseWatchedFileRecordId(id); if (!parsed || !collectionRegistry.get('file', parsed.slug)?.get(id)) return undefined;
      const root = createInstanceStore({ db }).get('file', parsed.slug)?.config.path;
      if (typeof root !== 'string' || !root || parsed.path.split('/').includes('..')) return undefined;
      return resolve(root, parsed.path);
    },
    ...(spheres ? { sphere: (ref, source) => spheres.resolve(ref, source).sphere } : {}),
  });
  const proactiveLearning = db && workEntityStore && spheres && situationStore ? createProactiveLearning({ db, work: workEntityStore, spheres, situations: situationStore,
    ...(episodeRuntime ? { episodes: episodeRuntime } : {}), timeZone: serverTimeZone, isVaultUnlocked,
    kindName: kind => options.mailFactStore?.getCustomType(kind)?.name,
    excludedPerson: id => { const contact = contactStore?.getByContactIdResolved(id) ?? contactStore?.get(id); return !!contact && contactExcludedFromProactive(contact); },
    tripExists: ref => {
      if (ref.collection === 'mail_fact' && options.mailFactStore) {
        const thing = options.mailFactStore.getThing(ref.id); const facts = options.mailFactStore.factsForThing(ref.id);
        return !!thing && !['cancelled', 'returned', 'refund_issued'].includes(String(thing.variables.state)) && facts.some(fact =>
          collectionRegistry.list().some(source => source.platform === 'mail' && source.slug === fact.email.slug));
      }
      if (ref.collection === 'calendar') {
        const colon = ref.id.indexOf(':'); if (colon < 1) return false;
        const source = localSituationCalendars().find(source => source.slug === ref.id.slice(0, colon));
        const event = source?.table.getByRecordId(ref.id.slice(colon + 1)); return !!event && event.hot.status !== 'cancelled';
      }
      return false;
    },
  }) : undefined;
  const querySituation = db && workEntityStore ? createSituationQuery({
    sourceForCollection: situationSourceAccess,
    ...(contactStore ? { namedPeople: createSituationNamedPeople(contactStore) } : {}),
    relate: (facts, _query, context) => [...relateTravelDocuments(facts, createAssetClassStore(db).list().flatMap(preset => preset.travel_validity ?? []), serverTimeZone(),
      travelDocumentsVisible(context, situationSourceAccess('asset'))), ...(proactiveLearning?.related(facts) ?? [])],
    ...(proactiveLearning ? { rank: fact => proactiveLearning.rank(fact), relationClasses: () => proactiveLearning.relationClasses() } : {}),
    sources: [...buildSituationSources({ db, work: workEntityStore, reminders: createReminderStore(db),
      ...(contactStore ? { contacts: contactStore } : {}), ...(options.mailFactStore ? { mailFacts: options.mailFactStore } : {}),
      timeZone: serverTimeZone,
      place: value => proactiveHistory!.place(value),
      ...(spheres ? { sphere: (ref, source) => spheres.resolve(ref, source).sphere } : {}),
      calendars: localSituationCalendars,
    }), ...(episodeRuntime ? [episodeRuntime.source] : [])],
  }) : undefined;
  const yours = db && workEntityStore && workEntityDispatchers && situationStore && assetOccurrences
    ? createYoursService({ db, work: workEntityStore, dispatchers: workEntityDispatchers, situations: situationStore,
      occurrences: assetOccurrences, ...(assetReminders ? { reminders: assetReminders } : {}), ...(spheres ? { spheres } : {}),
      ...(options.mailFactStore ? { mailFacts: options.mailFactStore } : {}), ...(annotationDeps ? { annotations: annotationDeps.store } : {}),
      ...(episodeRuntime ? { episodeRuntime } : {}),
      ...(proactiveLearning ? { learning: proactiveLearning } : {}),
      sphereSources: () => [...collectionRegistry.list().filter(row => row.platform === 'mail' || row.platform === 'calendar').map(row => ({ source: `${row.platform}:${row.slug}`, name: `${row.platform}: ${row.slug}` })),
        ...workEntityStore.listSources().map(row => ({ source: `work:${row.id}`, name: row.id }))],
      connections: () => connectionStore?.list({ kind: 'notification' }) ?? [],
      // Not the chat-only mailbox: its mail is the conversation, never read for facts.
      mailboxes: () => collectionRegistry.list().filter(row => row.platform === 'mail' && !mailChatDoor?.isChatOnlyMailbox(row.slug))
        .flatMap(row => { const address = (row as MailCollection).accountEmail; return typeof address === 'string' && address ? [{ slug: row.slug, address }] : []; }),
      ...(householdHomeAssistant ? { homeAssistant: householdHomeAssistant } : {}),
      isVaultUnlocked, timeZone: serverTimeZone }) : undefined;

  const scheduledSituations = db && workEntityStore && situationStore && querySituation && yours
    ? createScheduledSituations({ db, work: workEntityStore, store: situationStore, query: querySituation, timeZone: serverTimeZone,
        isVaultUnlocked, isQuiet: at => shouldSuppressForQuietHours({ policy: createQuietHoursStore(db).read(), instant: at, timeZone: serverTimeZone() }),
        ...(privateAiCall ? { summarize: createClusterSummary({ call: privateAiCall, ready: () => {
          if (!isVaultUnlocked()) return undefined;
          try { if (isAiPaused(db, Date.now()) || backgroundAiBudgetSpent?.()) return undefined;
            return isByokAllowedForBackground(db) ? 'any' : 'free';
          } catch { return undefined; }
        } }) } : {}),
        overview: () => yours.overview(), send: message => handleNotificationSend({ dispatchers: channelDispatchers ?? {} }, message),
        ...(episodeRuntime ? { retainCited: clusters => episodeRuntime!.retainCited(clusters), memoryAllowed: cluster => episodeRuntime!.memoryAllowed(cluster) } : {}),
        ...(contactStore ? { personName: (id: string) => { const contact = contactStore.getByContactIdResolved(id) ?? contactStore.get(id); return contact ? contact.name ?? contact.email : undefined; } } : {}),
        mailHealth: () => collectionRegistry.list().filter(collection => collection.platform === 'mail').map(collection => {
          const health = collection.health(); return { name: collection.slug, last_success_at: health.last_indexed_at,
            needs_attention: health.error_count_24h > 0 || health.last_indexed_at === 0 || Date.now() - health.last_indexed_at > 86_400_000 || health.auth_state === 'expired' || health.auth_state === 'unauthorized' };
        }),
      }) : undefined;
  if (scheduledSituations) yours!.bindScheduled(scheduledSituations);
  let feedSubscribers: EventTriggersStore | undefined;
  const proactiveRetention = db && situationStore ? createProactiveRetention({ db, situations: situationStore, isVaultUnlocked,
    subscribers: () => (feedSubscribers ??= createEventTriggersStore(db)).list().map(trigger => situationSubscriberId(trigger.trigger_id)),
    ...(scheduledSituations ? { overview: scheduledSituations } : {}), ...(workEntityStore ? { work: workEntityStore } : {}),
    ...(mailFactStore ? { mailFacts: mailFactStore } : {}) }) : undefined;

  // The authorize-URL read: client_id ONLY, never the secret, so it stays safe
  // on a locked server (`getClientId` does not decrypt). Store-only since the
  // `RECUED_*` OAuth env vars were deleted — which also closes the divergence
  // this path used to have with `resolveOAuthProviderConfig` above, where a
  // stored-id-without-secret row put the authorize URL on the stored app while
  // the token exchange fell back to the env app (`unauthorized_client`).
  // Both seams now read exactly one source.
  const oauthClientConfigDeps: OAuthClientConfigDeps = {
    getClientId: (provider) =>
      oauthAppConfigStore?.getClientId(oauthAppIssuerForProvider(provider)) ?? null,
  };

  // BYO OAuth app config rpc deps (server.{get,set,clear}OAuthAppConfig). Absent
  // on a db-less boot (no store) → that rpc slice stays unwired. The store is
  // the only credential source, so the handler derives `source` from it alone.
  const oauthAppConfigDeps: OAuthAppConfigHandlerDeps | undefined = oauthAppConfigStore
    ? { ...(db && connectionStore ? { permissions: createOAuthPermissionService({ apps: oauthAppConfigStore, instances: createInstanceStore({ db }),
      rows: () => connectionStore.list(), ...(accountStore ? { accountStore } : {}), ...(keys ? { key: keys.keyProvider('connection') } : {}),
      ...(options.oauthAppConnectionUses ? { connectionUses: options.oauthAppConnectionUses } : {}),
      ...(options.oauthAppPermissionNeeds ? { requirements: options.oauthAppPermissionNeeds } : {}),
      ...(options.oauthAppNativePermissionNeeds ? { nativeRequirements: options.oauthAppNativePermissionNeeds } : {}) }) } : {}),
      store: oauthAppConfigStore, uses: (issuer, id) => oauthAppUses(createInstanceStore({ db: db! }), issuer, id),
      ...(db && connectionStore ? { renewal: createOAuthAppRenewalService({ db, apps: oauthAppConfigStore, connections: connectionStore,
        instances: createInstanceStore({ db }), ...(accountStore ? { accountStore } : {}), ...(keys ? { key: keys.keyProvider('connection') } : {}),
        ...(options.oauthAppConnectionUses ? { connectionUses: options.oauthAppConnectionUses } : {}) }) } : {}),
      ...(db && connectionStore ? { usage: createOAuthAppUsageService({ db, apps: oauthAppConfigStore, connections: connectionStore,
        instances: createInstanceStore({ db }), ...(keys ? { key: keys.keyProvider('connection') } : {}),
        ...(options.oauthAppConnectionUses ? { connectionUses: options.oauthAppConnectionUses } : {}) }) } : {}) }
    : undefined;

  const startCollectionAdapters = async (): Promise<void> => {
    if (calendarStack) {
      await calendarStack.startAll();
      registerCalendarCollections(calendarStack, collectionRegistry);
    }

    if (mailStack) {
      await mailStack.startAll();
      registerMailCollections(mailStack, collectionRegistry);
      // D-315 §4.3 — now the mailboxes are live: resume the AI calls a
      // restart left queued.
      mailFactAi?.kick();
      // D-315 §5.3 — and drop the facts of emails a live mailbox no longer
      // holds: a delete or move hook that failed is never run again.
      if (mailFactWriter) {
        void sweepGoneEmails(
          mailFactWriter,
          collectionRegistry.list().filter((collection): collection is MailCollection => collection.platform === 'mail'),
          mailFactLogger,
        );
      }
    }

    // R21.1 parity — keep the mail/calendar poll loops in step with the vault
    // lock state. `startAll` above already DEFERRED each live sync if the vault
    // is currently locked; this owns the later edges: a manual unlock after a
    // locked boot (→ resumeSync starts the deferred loops) and an auto-lock
    // re-lock mid-life (→ pauseSync stops polling before the next tick can drop
    // a CAS item). Reads keep working throughout — only the provider FETCH loop
    // is gated. On an always-unlocked server no edge fires, so this is inert.
    if (vaultStateBus && (mailStack || calendarStack)) {
      // `.catch` mirrors `vault-gated-executors.ts` — this callback runs inside
      // `KeyManager.transition()`, so a rejection must never escape it. The
      // resume/pause helpers already swallow per-collection errors; this guards
      // a future refactor that could reject at the top level.
      vaultStateBus.subscribe((next) => {
        if (next === 'unlocked') {
          void mailStack?.resumeSync()?.catch(() => {});
          void calendarStack?.resumeSync()?.catch(() => {});
        } else {
          void mailStack?.pauseSync()?.catch(() => {});
          void calendarStack?.pauseSync()?.catch(() => {});
        }
      });
    }

    if (supervisionStack) {
      // Boot reconcile — adopt surviving daemons / relaunch the enabled,
      // boot-persistent ones. The cli executor is already bound by now (compose
      // runs before boot).
      await supervisionStack.startAll();
    }
  };

  const collectionAuthentication = db && mailStack && calendarStack && options.managedOAuthConsumers?.authentication
    ? createCollectionAuthenticationService({ db, instances: createInstanceStore({ db }), sources: options.managedOAuthConsumers.authentication,
      mail: mailStack.enrollDeps, calendar: calendarStack.enrollDeps }) : undefined;
  const collectionOAuthAppSwitch = db && mailStack && calendarStack && oauthAppConfigStore && accountStore
    ? createCollectionOAuthAppSwitchService({ db, instances: createInstanceStore({ db }), apps: oauthAppConfigStore,
      accountStore, mail: mailStack.enrollDeps, calendar: calendarStack.enrollDeps }) : undefined;
  if (db && mailStack && calendarStack && oauthAppConfigStore && accountStore && keys && oauthAppConfigDeps?.permissions) {
    oauthAppConfigDeps.cleanup = createOAuthPermissionCleanupService({ db, instances: createInstanceStore({ db }), apps: oauthAppConfigStore,
      permissions: oauthAppConfigDeps.permissions, accountStore, mail: mailStack.enrollDeps, calendar: calendarStack.enrollDeps,
      key: keys.keyProvider('server-data'), ...(connectionStore ? { connections: connectionStore, connectionKey: keys.keyProvider('connection') } : {}) });
  }

  return {
    inboundFileCollection,
    uploadService,
    downloadService,
    archiveUploadService,
    uploadStagingRegistry,
    calendarStack,
    mailStack,
    ...(collectionAuthentication ? { collectionAuthentication } : {}),
    ...(collectionOAuthAppSwitch ? { collectionOAuthAppSwitch } : {}),
    mailFactWriter,
    mailFactTriggerRoom,
    emailAnswerHook,
    mailChatDoor,
    mailChatProof,
    mailChatConversations,
    mailChatConversationMail,
    isOwnSend,
    mailFactAiSettled: (email: MailFactEmailRef) => mailFactAi?.untilSettled(email) ?? Promise.resolve(0),
    mailFactEvents,
    bootEvents,
    supervisionStack,
    collectionRegistry,
    watcherDispatcher,
    notificationDeps,
    notificationHandler,
    channelDispatchers,
    workEntityDispatchers,
    ...(assetOccurrences ? { assetOccurrences } : {}),
    ...(assetReminders ? { assetReminders } : {}),
    ...(yours ? { yours } : {}),
    ...(scheduledSituations ? { scheduledSituations } : {}),
    ...(episodeRuntime ? { episodeRuntime } : {}),
    ...(proactiveLearning ? { proactiveLearning } : {}),
    ...(proactiveRetention ? { proactiveRetention } : {}),
    ...(situationStore ? { situationStore } : {}),
    ...(spheres ? { spheres } : {}),
    ...(querySituation ? { querySituation } : {}),
    oauthClientConfigDeps,
    ...(oauthAppConfigDeps ? { oauthAppConfigDeps } : {}),
    startCollectionAdapters,
  };
};
