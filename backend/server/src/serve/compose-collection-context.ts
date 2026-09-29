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
import type { ServiceStack } from '../collections/service/compose.js';
import { composeCalendarBoot } from '../composition/bin/wire-calendar-stack.js';
import {
  composeConnectionNotification,
  type ConnectionNotificationBundle,
} from '../composition/bin/wire-connection-notification.js';
import { composeMailBoot } from '../composition/bin/wire-mail-stack.js';
import { createMailFactAnnouncer } from '../mail-facts/announcer.js';
import { createMailFactWriter, sweepGoneEmails, type MailFactWriter } from '../mail-facts/fact-writer.js';
import { createHeldMailFactEvents, type HeldMailFactEvents } from '../mail-facts/held-events.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createBackfillStateLookup } from '../triggers/backfill-state.js';
import { bootEventKeep, createBootEventRecorder, type BootEventRecorder } from '../triggers/boot-events.js';
import {
  createMailFactAiRunner,
  MAIL_FACT_AI_MANIFEST,
  mailFactAiCallThrough,
  readMailFactAiEmail,
  type MailFactAiRunner,
} from '../mail-facts/ai-pass.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { isAiPaused, isByokAllowedForBackground } from '../housekeeping/trust-store.js';
import { composeServiceBoot } from '../composition/bin/wire-service-stack.js';
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
import type { OAuthAppConfigHandlerDeps } from '../oauth-app-config-handler.js';
import type { OAuthProviderConfig } from '../collections/mail/oauth.js';
import { oauthAppIssuerForProvider, resolveServerTimeZone } from '@recued/contracts';
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
import {
  createWebhookWatcherQueue,
  type WebhookWatcherQueue,
} from '../watchers/webhook-watcher.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
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
   *  token. Read by two seams that must never hold the handle themselves: the
   *  engine (`ExecutionContext.uploadStaging`, which stages + disposes) and the
   *  `connection.api` adapter (`readUploadChunk`, one range per APPEND).
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
  serviceStack: ServiceStack | undefined;
  /** Supervision feature — cli-daemon keep-alive stack. Undefined on a db-less
   *  boot. Its cli executor is late-bound at the collection/execution
   *  convergence point. */
  supervisionStack: SupervisionStack | undefined;
  webhookWatcherQueue: WebhookWatcherQueue;
  collectionRegistry: CollectionRegistry;
  watcherDispatcher: WatcherDispatcher;
  workEntityDispatchers: WorkEntityDispatchers | undefined;
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
    tokenUrl: string,
  ): OAuthProviderConfig | null => {
    const issuer = oauthAppIssuerForProvider(provider);
    const storedId = oauthAppConfigStore?.getClientId(issuer) ?? null;
    const storedSecret = storedId ? oauthAppConfigStore!.getClientSecret(issuer) : null;
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
    resolveOAuthConfig: (adapter) =>
      resolveOAuthProviderConfig(adapter, adapter === 'gcal' ? GCAL_TOKEN_URL : GRAPH_CAL_TOKEN_URL),
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

  const mailStack = composeMailBoot({
    db,
    cacheBlobs,
    warehouseBus,
    ...(auditLog ? { auditLog } : {}),
    ...(contactStore ? { contactStore } : {}),
    // D-315 — every upsert is read for mail facts, through the one writer.
    ...(mailFactWriter ? { mailFactWriter } : {}),
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
    resolveOAuthConfig: (provider) =>
      resolveOAuthProviderConfig(provider, provider === 'gmail' ? GMAIL_TOKEN_URL : GRAPH_TOKEN_URL),
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

  const serviceStack = composeServiceBoot({
    db,
    dataPath: dirname(dbPath),
    manifests,
    runtime: {
      defaultQuotaBytes: runtimeConfig.get('collection.service.default.quota_bytes') as number,
      minDiskFreeBytes: runtimeConfig.get('collection.service.min_disk_free_bytes') as number,
      invokeSlackBytes: runtimeConfig.get('collection.service.invoke_slack_bytes') as number,
      duSampleIntervalS: runtimeConfig.get('collection.service.du_sample_interval_s') as number,
      // D-179 P5 — invoke guard knobs.
      invokeTimeoutCeilingMs: runtimeConfig.get('collection.service.invoke_timeout_ceiling_ms') as number,
      maxConcurrentInvokes: runtimeConfig.get('collection.service.max_concurrent_invokes') as number,
      maxConcurrentInvokesPerInstance: runtimeConfig.get('collection.service.max_concurrent_invokes_per_instance') as number,
    },
    baseVault,
    ...(auditLog ? { auditLog } : {}),
  });

  // Supervision feature — cli-daemon keep-alive. Rides the serviceStack
  // lifecycle (boot startAll / shutdown disposeAll / ws-server rpc). The cli
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

  const webhookWatcherQueue = createWebhookWatcherQueue();
  const watcherDispatcher = createWatcherDispatcher({
    auditLog,
    collectionRegistry,
    ...(calendarStack ? { calendarWatcherCursors: calendarStack.watcherCursors } : {}),
    webhookQueue: webhookWatcherQueue,
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
  });

  // The owner's zone, for judging a date-only deadline by its day.
  const serverZoneStore = db ? createServerTimeZoneStore(db) : undefined;
  const workEntityDispatchers = workEntityStore
    ? createWorkEntityDispatchers({
        store: workEntityStore,
        resolver: createWorkEntityResolver(workEntityStore),
        timeZone: () => resolveServerTimeZone(
          serverZoneStore?.read(),
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
        bus: warehouseBus,
        ...(enrichmentCascade ? { cascade: enrichmentCascade } : {}),
        ...(options.getWorkEntityWriteExecutor
          ? { getWriteExecutor: options.getWorkEntityWriteExecutor }
          : {}),
      })
    : undefined;

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
    ? { store: oauthAppConfigStore }
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

    if (serviceStack) {
      await serviceStack.startAll();
    }

    if (supervisionStack) {
      // Boot reconcile — adopt surviving daemons / relaunch the enabled,
      // boot-persistent ones. The cli executor is already bound by now (compose
      // runs before boot).
      await supervisionStack.startAll();
    }
  };

  return {
    inboundFileCollection,
    uploadService,
    downloadService,
    archiveUploadService,
    uploadStagingRegistry,
    calendarStack,
    mailStack,
    mailFactWriter,
    mailFactTriggerRoom,
    mailFactAiSettled: (email: MailFactEmailRef) => mailFactAi?.untilSettled(email) ?? Promise.resolve(0),
    mailFactEvents,
    bootEvents,
    serviceStack,
    supervisionStack,
    webhookWatcherQueue,
    collectionRegistry,
    watcherDispatcher,
    notificationDeps,
    notificationHandler,
    channelDispatchers,
    workEntityDispatchers,
    oauthClientConfigDeps,
    ...(oauthAppConfigDeps ? { oauthAppConfigDeps } : {}),
    startCollectionAdapters,
  };
};
