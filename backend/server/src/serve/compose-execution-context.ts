import { hostname } from 'node:os';

import { canBindHostname } from '@recued/contracts';
import type { BridgeSink, Channel, NotificationBlock, RemoteChannel } from '@recued/notification';

import type { CollectionRegistry } from '../collections/registry.js';
import {
  composeExecuteDeps,
} from '../composition/bin/wire-execute-deps.js';
import { createSeededCatalogOperationProfileStore } from '../connection-operation-profile-boot.js';
import type { ConnectionOperationProfileStore } from '../connection-operation-profile.js';
import {
  createCliReachabilityResolver,
  createCliReachabilityStore,
} from '../storage/cli-reachability-store.js';
import { createGatedReadGrantResolver } from '../read-grant-checker.js';
import {
  composeExecutorConfig,
} from '../composition/bin/wire-executor-config.js';
import { scopedCandidatesForChannelSession } from '../chat-forwarded-sender-index.js';
import {
  buildAskLandingAnswerLink,
  resolvePublicBaseUrl,
} from '../ask-landing-answer-link.js';
import { buildMessengerRemoteChannels } from '../composition/bin/messenger-transport-leaves.js';
import { composeEmailChannel } from '../composition/bin/wire-email-channel.js';
import type { PreflightResumer } from '@recued/gateway';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ScheduleHandlerDeps } from '../schedule-handler.js';
import type { ConnectionLookup } from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { BridgeDispatcher } from '../bridges/dispatcher.js';
import { resolveLlmGatewayRoute } from '../ports/llm-gateway/handler.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import { createReceptionSealedVisitorEmailSeam } from '../ports/reception/projection/reception-sealed-visitor-email.js';
import { createFormResponsePromotion } from '../ports/reception/form-response-promotion.js';
import { resolveReceptionInboxFanoutModeFromStore } from '../ports/reception/handlers/trust-footer.js';
import { createPaidDocumentDirectCheckoutReviewAdmission } from '../paid-document-direct-checkout-review-admission.js';
import { emitFormResponseCreatedEvents } from '../form-response-events.js';
import { createScopedWebhookEventReader } from '../webhook-recipe-consumer.js';
import type {
  AppContext,
  AppContextChatLateBoundGetters,
} from './compose-app-context.js';
import type {
  CollectionContext,
} from './compose-collection-context.js';
import type {
  StorageContext,
} from './compose-storage-context.js';

export interface ExecutionLateBoundRefs extends AppContextChatLateBoundGetters {
  publishCollectionRegistry: (registry: CollectionRegistry) => void;
  publishExecutorConfig: (config: ServerExecutorConfig) => void;
  publishExecuteDeps: (deps: ExecuteHandlerDeps) => void;
  /** D-193 — schedule_recipe is wired in the executor config before
   *  maintenance constructs the real schedule store. This live ref is
   *  published immediately after maintenance composition so the kernel
   *  dispatcher can create schedules without boot-order inversion. */
  publishScheduleDeps: (deps: ScheduleHandlerDeps | undefined) => void;
  getScheduleDeps: () => ScheduleHandlerDeps | undefined;
  /** D-169 P0 follow-on — published by the boot site once
   *  `createWebSocketUpgrade` returns and the live bridge dispatcher is
   *  available. The executor's `bridgeDispatcherRef` thunk reads through
   *  this ref so the DOM-runner adapter picks up the live dispatcher on
   *  every call. Stays undefined until publish — DOM ingredient calls
   *  before publish surface `ROLE_RESTRICTION`. */
  publishBridgeDispatcher: (dispatcher: BridgeDispatcher | undefined) => void;
  getBridgeDispatcher: () => BridgeDispatcher | undefined;
}

export const createExecutionLateBoundRefs = (): ExecutionLateBoundRefs => {
  let collectionRegistryRef: CollectionRegistry | undefined;
  let executorConfigRef: ServerExecutorConfig | undefined;
  let executeDepsRef: ExecuteHandlerDeps | undefined;
  let scheduleDepsRef: ScheduleHandlerDeps | undefined;
  let bridgeDispatcherRef: BridgeDispatcher | undefined;

  return {
    getCollectionRegistry: () => collectionRegistryRef,
    getExecutorConfig: () => executorConfigRef,
    getExecuteDeps: () => executeDepsRef,
    getScheduleDeps: () => scheduleDepsRef,
    getBridgeDispatcher: () => bridgeDispatcherRef,
    publishCollectionRegistry: (registry) => {
      collectionRegistryRef = registry;
    },
    publishExecutorConfig: (config) => {
      executorConfigRef = config;
    },
    publishExecuteDeps: (deps) => {
      executeDepsRef = deps;
    },
    publishScheduleDeps: (deps) => {
      scheduleDepsRef = deps;
    },
    publishBridgeDispatcher: (dispatcher) => {
      bridgeDispatcherRef = dispatcher;
    },
  };
};

export interface ComposeExecutionContextOptions {
  storage: Pick<
    StorageContext,
    | 'db'
    | 'manifests'
    | 'recipeStore'
    | 'eventBus'
    | 'serverInstanceId'
    | 'auditLog'
    | 'commitStore'
    | 'checkpointStore'
    | 'fileStack'
    | 'workEntityStoreRef'
    // Accepted intake responses are promoted in the shared preflight-resume
    // funnel before any optional downstream reception workflow continues.
    | 'intakeFormSubmissionStoreRef'
    | 'formResponseStoreRef'
    // D-182 §10 step 8 / R1 (Fix 2) — installed-manifest store so the run-path
    // R1 pre-pass binds pack-composition CRM/acct vendors (`liveVendorRegistry`).
    | 'localManifestStore'
    | 'hostnameRegistryStore'
    // D-210 Phase C — the `reception_page` singleton carries the owner's
    // global inbox device-fanout mode, read fresh at each preflight raise.
    | 'publicEndpointRegistryStoreRef'
  >;
  app: Pick<
    AppContext,
    | 'llmQuota'
    | 'cacheStore'
    | 'cacheBlobs'
    // D-192 remote byte-fetch — shared `remote` file-read bundle for the
    // recipe `data-file-read` + ai-* multimodal channels.
    | 'getRemoteFileReadDeps'
    | 'llmConfig'
    | 'resolveLlmConfig'
    | 'llmManager'
    | 'connectionStoreRef'
    | 'contractGrantStoreRef'
    | 'connectionCatalogBindingStoreRef'
    | 'contractStoreRef'
    | 'sellerStoreRef'
    | 'sellerOrderStoreRef'
    | 'sellerClaimStoreRef'
    | 'chatInboundTokenStoreRef'
    | 'clientTokensRef'
    | 'keys'
    | 'sharedStoreRef'
    | 'contactStoreRef'
    | 'annotationDeps'
    | 'annotationStoreRef'
    | 'enrichmentStoreRef'
    | 'housekeepingStateRef'
    | 'engagementRateControlStoreRef'
    // D-192 Slice 6c — the boot-singleton work-entity write executor ref, for the
    // create-plan approve dispatcher's `executeCreatePlan`.
    | 'workEntityWriteExecutorRef'
    // D-179 P4 — run-outcome events emit onto the trigger-source bus.
    | 'warehouseBus'
    // D-177 N.11 rule 5 (slice D) — the chat forwarded-sender index for the
    // gateway's scoped-grant candidate lookup.
    | 'chatForwardedSenderIndexRef'
    // D-188 — the master pause flag feeds the op-admission gate's pause-deny.
    | 'serverState'
  > & Partial<Pick<
    AppContext,
    | 'webhookConsumerStoreRef'
    | 'webhookDeliveryStoreRef'
  >>;
  /** D-163 Slice B — Bridge OS-notification sink. Currently no production
   *  transport exists for sending `BridgeCommand`s for OS notifications
   *  outside D-148 P3 tests; a future slice wires this once the
   *  dispatcher reaches `ws-server`. Until then the Bridge channel's
   *  `deliverNotify` collapses to a silent no-op via the wire helper's
   *  built-in fallback. */
  bridgeSink?: BridgeSink;
  collection: Pick<
    CollectionContext,
    | 'watcherDispatcher'
    | 'collectionRegistry'
    | 'notificationDeps'
    | 'calendarStack'
    | 'serviceStack'
    | 'channelDispatchers'
    | 'workEntityDispatchers'
    | 'inboundFileCollection'
  >;
  baseVault: Record<string, unknown>;
  lateBound: ExecutionLateBoundRefs;
  env?: Record<string, string | undefined>;
}

export interface ExecutionContext {
  executorConfig: ServerExecutorConfig;
  executeDeps: ExecuteHandlerDeps;
  notificationBlock: NotificationBlock | undefined;
  /** D-210 Phase C — the DECORATED preflight resumer, surfaced so the Reception
   *  inbox can release a hold that carries no durable ask (notify-mode fanout,
   *  and the pre-existing raise-failed accident). Same instance every other
   *  approval surface uses — see `ExecuteDepsBundle.preflightResumer`. */
  preflightResumer: PreflightResumer | undefined;
  /** D-207 slice 1c — the contract substrate the reception door is minted into, surfaced
   *  so the boot site can hand the SAME instances to the door bind. A second store over
   *  the same table would let the mint write grants the gate cannot see. */
  contractDefinitionStore: ContractDefinitionStore | undefined;
  grantEntryStore: ContractGrantEntryStore | undefined;
  /** D-192 CORE #6 seam 7 (Group D) — the `vendor → RemoteChannel` messenger
   *  registry (slack / telegram / …), built ONCE and surfaced for
   *  `composeInboundAnswerDispatcher`'s `parseInboundReply` seam. These are the
   *  SAME handles the notification block registered in its fan-out array, so the
   *  ask_id correlation map each channel keeps in-memory is the one the inbound
   *  callback maps back through (D-163 lock-step invariant). Empty when
   *  `app.connectionStoreRef` is absent (daemon-only / dbless harness) — no
   *  channels were constructed in that mode. Replaces the per-vendor
   *  `slackChannel` / `telegramChannel` fields. */
  messengerChannels: Record<string, RemoteChannel>;
  /** D-158 P2b — the email `Channel` surfaced for symmetry with the
   *  `messengerChannels` registry (email is a notification channel, not a chat
   *  transport, so it stays a discrete field). Undefined when there is no
   *  connection store (daemon-only / dbless harness) or no mail-rpc
   *  (no send-capable mail collection wired), otherwise the same handle
   *  the block registered. */
  emailChannel: Channel | undefined;
  serverDisplayName: string;
  /** D-165 follow-on — the live operation-profile store the gateway resolves
   *  against (seeded + grant-merged). `composeListeners` wires the
   *  `grant/revoke/listOperationGroup` rpcs to mutate THIS instance. Undefined
   *  when `app.connectionStoreRef` is absent (daemon-only / dbless harness). */
  connectionOperationProfileStore: ConnectionOperationProfileStore | undefined;
  /** D-170 gap #2 live-reconcile — (re)derive ONE connection's operation profile
   *  immediately by name. `composeListeners` threads it into the
   *  `ingredient.install` / `ingredient.uninstall` + `packs.install` /
   *  `packs.uninstall` deps so a composition install/uninstall takes effect at
   *  dispatch at once (not only on the next connect/boot). Backed by the SAME
   *  closure as `connectionOperationProfileStore`. Undefined when that store is. */
  reconcileConnectionProfile: ((connectionName: string) => void) | undefined;
}

const resolveServerDisplayName = (
  env: Record<string, string | undefined>,
): string => env.RECUED_SERVER_NAME ?? hostname() ?? 'recued';

/** Claim links are emailed, so they use the strict public-host filter from the
 * ask-link path. Candidate precedence still matches Reception itself: explicit
 * public base URL, then a live verified/enabled hostname-registry binding. */
const resolveSellerClaimPublicBaseUrl = (
  configured: string | undefined,
  hostnameRegistryStore: Pick<StorageContext['hostnameRegistryStore'], 'list'>,
): string | null => {
  const configuredBaseUrl = resolvePublicBaseUrl(configured);
  if (configuredBaseUrl !== null) return configuredBaseUrl;

  for (const registered of hostnameRegistryStore.list()) {
    if (!canBindHostname(registered)) continue;
    const port = registered.listener_ports.includes(443)
      ? 443
      : registered.listener_ports[0];
    if (port === undefined) continue;
    const candidate = port === 443
      ? `https://${registered.hostname}`
      : `https://${registered.hostname}:${port}`;
    const resolved = resolvePublicBaseUrl(candidate);
    if (resolved !== null) return resolved;
  }
  return null;
};

export const composeExecutionContext = async (
  options: ComposeExecutionContextOptions,
): Promise<ExecutionContext> => {
  const {
    storage,
    app,
    collection,
    baseVault,
    lateBound,
    env = process.env,
  } = options;
  // Chat bootstraps before collection / executor / executeDeps. Publish
  // each live handle in boot order so the chat tool getters keep the
  // same late-bound behavior they had in serve-entry.
  lateBound.publishCollectionRegistry(collection.collectionRegistry);

  const executorConfig = await composeExecutorConfig({
    manifests: storage.manifests,
    baseVault,
    llmQuota: app.llmQuota,
    cacheStore: app.cacheStore,
    cacheBlobs: app.cacheBlobs,
    serverInstanceId: storage.serverInstanceId,
    watcherDispatcher: collection.watcherDispatcher,
    collectionRegistry: collection.collectionRegistry,
    // D-192 remote byte-fetch — the recipe `data-file-read` + ai-* multimodal
    // channels resolve a `file:remote:*` id through the shared bundle.
    getRemoteFileReadDeps: app.getRemoteFileReadDeps,
    recipeStore: storage.recipeStore,
    getScheduleDeps: lateBound.getScheduleDeps,
    sellerStore: app.sellerStoreRef,
    sellerOrderStore: app.sellerOrderStoreRef,
    contractStore: app.contractStoreRef,
    inboundTokenStore: app.chatInboundTokenStoreRef,
    sellerClaimStore: app.sellerClaimStoreRef,
    getSellerPublicBaseUrl: () => {
      const publicBaseUrl = resolveSellerClaimPublicBaseUrl(
        env.RECUED_PUBLIC_BASE_URL,
        storage.hostnameRegistryStore,
      );
      if (publicBaseUrl === null) {
        throw new Error('seller customer claim public base URL is unavailable');
      }
      return publicBaseUrl;
    },
    llmConfig: app.llmConfig,
    resolveLlmConfig: app.resolveLlmConfig,
    llmManager: app.llmManager,
    connectionStore: app.connectionStoreRef,
    auditLog: storage.auditLog,
    keys: app.keys,
    connectionNotificationDeps: collection.notificationDeps,
    fileStack: storage.fileStack,
    calendarStack: collection.calendarStack,
    serviceStack: collection.serviceStack,
    sharedStore: app.sharedStoreRef,
    formResponseStore: storage.formResponseStoreRef,
    // D-210 Phase C (§4b) — the resolved-pointer write-back on approve-resume.
    ...(storage.intakeFormSubmissionStoreRef
      ? { intakeFormSubmissionStore: storage.intakeFormSubmissionStoreRef }
      : {}),
    webhookEventReader: app.webhookConsumerStoreRef && app.webhookDeliveryStoreRef
      ? createScopedWebhookEventReader(
          app.webhookConsumerStoreRef,
          app.webhookDeliveryStoreRef,
        )
      : undefined,
    contactStore: app.contactStoreRef,
    annotationDeps: app.annotationDeps,
    db: storage.db,
    annotationStore: app.annotationStoreRef,
    enrichmentStore: app.enrichmentStoreRef,
    // D-187 AMENDMENT — the per-(bound contract) read-grant resolver (wraps the real
    // contract store; no SQL at construction; gates to standing policy contracts) for the
    // recipe-channel enrichment-list + timeline-read dispatchers.
    readGrantResolver: app.contractStoreRef
      ? createGatedReadGrantResolver(app.contractStoreRef)
      : undefined,
    notificationChannelDispatchers: collection.channelDispatchers,
    housekeepingState: app.housekeepingStateRef,
    engagementRateControlStore: app.engagementRateControlStoreRef,
    workEntityDispatchers: collection.workEntityDispatchers,
    // D-173 P1-dispatch — the reception projection's local materialize deps.
    // The SAME per-pair work-entity store + contact path `composeListeners`
    // binds its inbox-side `projectReception` effect over (R2 INT-3), so the
    // gate-held catalog op (re-dispatched on approve-resume) materialises
    // through the identical Source-routed write path.
    receptionProjectionWorkEntityStore: storage.workEntityStoreRef,
    receptionProjectionContactDeps: app.contactStoreRef
      ? { store: app.contactStoreRef }
      : undefined,
    // D-173 P4.3 — pair with `calendarStack` to build the calendar-event
    // create seam (a scheduling booking materializes a local calendar event).
    // D-210 A.8 slice 4b-ii — the merged store; a booking is a
    // `reception_form_submission` row with a slot.
    receptionProjectionBookingStore: storage.intakeFormSubmissionStoreRef,
    // D-210 slice 3 — the booking-entity mint that runs beside a reservation's
    // calendar event. Same underlying store as the projection above, threaded
    // SEPARATELY because a booking is not a projection destination: it is a
    // companion row, and the projection's Pick says so by omitting it.
    receptionBookingMintStore: storage.workEntityStoreRef,
    receptionEndpointRegistryStore: storage.publicEndpointRegistryStoreRef,
    // D-210 WS3 — the `contact` branch's sealed-email resolver. An intake
    // targeting a contact carries NO email in its held payload (the address
    // must not enter step state), so the projection resolves it here from the
    // submission id in its provenance. Built where the submission store and
    // the form-PII key already meet — the same pair the approve-time promotion
    // uses. Absent (no store / no KeyManager) ⇒ an intake→contact projection
    // fail-closes rather than writing an unkeyed identity.
    resolveSealedVisitorEmail:
      storage.intakeFormSubmissionStoreRef && app.keys
        ? createReceptionSealedVisitorEmailSeam({
            submissionStore: storage.intakeFormSubmissionStoreRef,
            getFormSubmissionPiiKey: () =>
              deriveFormSubmissionPiiKeyFromSubDek(app.keys!.getSubDEK('reception')),
          })
        : undefined,
    // D-210 §7 — the booking-PII key source for the `notify-booking-visitor`
    // dispatcher's server-side open of the sealed visitor email. Same
    // derivation as `getFormSubmissionPiiKey` below (the reception sub-DEK);
    // `undefined` when the FileVault has no KeyManager, and the dispatcher
    // then stays unwired.
    // ⚠ D-210 A.8 slice 4b-ii — the FORM key, derived from the SAME reception
    // sub-DEK but under a different HKDF info label. A booking row is a
    // `reception_form_submission` row and its readers open with the form key;
    // handing the booking key here would decrypt nothing (`booking-blob.ts`).
    getFormSubmissionPiiKey: app.keys
      ? () => deriveFormSubmissionPiiKeyFromSubDek(app.keys!.getSubDEK('reception'))
      : undefined,
    // D-169 P0 follow-on — late-bound bridge dispatcher accessor. The
    // executor builds before `createWebSocketUpgrade` returns; the boot
    // site publishes the live dispatcher onto `lateBound` post-WS-build.
    // Reads through the ref every call so the DOM-runner sees the live
    // handle without needing the executor to be rebuilt.
    getBridgeDispatcher: lateBound.getBridgeDispatcher,
  });
  lateBound.publishExecutorConfig(executorConfig);

  const serverDisplayName = resolveServerDisplayName(env);
  // D-192 CORE #6 seam 7 (Group D) — pre-build the `vendor → RemoteChannel`
  // messenger registry ONCE (slack / telegram / … from the messenger-vendor
  // registry + the transport/recipient leaves), and thread that ONE map to both
  // the notification block (fan-out array) and the inbound-answer dispatcher
  // (parseInboundReply), so `closeAsk` and `parseInboundReply` act on the same
  // instances (D-163 lock-step invariant). Each channel's `resolveCredential`
  // re-reads `keys.state()` per dispatch, so a mid-process unlock transparently
  // switches decode paths (see `composeRemoteChannel` for the rationale). Empty
  // when there is no connection store (daemon-only / dbless harness).
  const messengerChannels: Record<string, RemoteChannel> = app.connectionStoreRef
    ? buildMessengerRemoteChannels({
        connectionStore: app.connectionStoreRef,
        ...(app.keys ? { keys: app.keys } : {}),
      })
    : {};
  // D-158 P2b email-adapter slice — OUTBOUND server-wiring for the
  // `channels/email.ts` leaf. Unlike Slack/Telegram it is not a
  // transport-backed `RemoteChannel`; it reuses the SAME `mailRpc`
  // (`handleCollectionMailSend`) the D-127 `connection.notification.email`
  // subhandler already wired (`collection.notificationDeps.mailRpc`), so
  // there is no second mail-send closure. Requires both a connection store
  // (to resolve the `connection.notification.email` record) and a mail rpc
  // (a send-capable mail collection); absent either ⇒ undefined, and the
  // readiness probe keeps the email Settings row `not_ready`.
  const emailMailRpc = collection.notificationDeps?.mailRpc;
  // D-158 P2b-ii — the one-click `answerLink` rides ONLY on a publicly-
  // reachable server. Presence is a boot-time decision (the leaf's
  // `answerLink?` is binary at construction): resolve the public base URL
  // from `RECUED_PUBLIC_BASE_URL`; null (non-public / local) ⇒ no answerLink
  // ⇒ text-only asks (answerable on `ui` + by reply). When present, the
  // `/ask/<ask_id>` route serves the landing page (mounted in
  // `composeListeners`).
  const askAnswerLink =
    buildAskLandingAnswerLink(resolvePublicBaseUrl(env.RECUED_PUBLIC_BASE_URL)) ??
    undefined;
  const emailChannel = app.connectionStoreRef && emailMailRpc
    ? composeEmailChannel({
        connectionStore: app.connectionStoreRef,
        mailRpc: emailMailRpc,
        ...(askAnswerLink ? { answerLink: askAnswerLink } : {}),
      })
    : undefined;
  // D-165 — boot-seed the catalog operation-profile store for enrolled
  // catalog-vendor connections (HubSpot + Salesforce; read-tier auto-granted;
  // write+ stays OFF until an explicit group grant). D-165 follow-on: MERGE
  // durable operation-group grants so a granted write group survives the re-seed
  // a token-refresh upsert triggers. Hoisted out of the deps literal so the SAME instance is shared
  // between the gateway (executeDeps.connectionOperationProfiles) and the grant
  // rpcs (connectionDeps.operationGrants.profileStore, via the returned
  // context) — a grant must mutate the very profile the gateway resolves.
  const seededOperationProfiles = app.connectionStoreRef
    ? createSeededCatalogOperationProfileStore({
        connectionStore: app.connectionStoreRef,
        getManifest: (slug) => executorConfig.manifests.get(slug),
        ...(app.contractGrantStoreRef
          ? { contractGrantStore: app.contractGrantStoreRef }
          : {}),
        // D-170 gap #2 — seed local composition-catalog connections too (their
        // catalog resolves via the binding, not config.vendor).
        ...(app.connectionCatalogBindingStoreRef
          ? { connectionCatalogBindingStore: app.connectionCatalogBindingStoreRef }
          : {}),
      })
    : undefined;
  const connectionOperationProfileStore = seededOperationProfiles?.profileStore;
  // D-182 §7.2 — the per-contract cli reachability resolver, the AUTHORITATIVE
  // `cli` authorization source (increment 3). A `cli` catalog op authorizes
  // against a per-(principal × cli-ingredient × risk_tier) allowlist
  // (`contract.cli_reachability`, absent ⇒ denied), NOT a connection profile, so
  // a connection-less by-value cli pack never hits `no_connection_profile`.
  // Built from the SAME local `contract.*` store the `cli.reachability.*` grid
  // rpc writes, so a freshly-granted cell authorizes the next dispatch with no
  // reseed. Absent contract store (dbless) ⇒ undefined ⇒ cli ops fail closed
  // `cli_reachability_disabled` (reachability defaults OFF).
  const cliReachabilityResolver = app.contractStoreRef
    ? createCliReachabilityResolver(createCliReachabilityStore(app.contractStoreRef))
    : undefined;
  // D-170 gap #2 live-reconcile — the install/uninstall rpc deps drive this to
  // (re)derive a bound connection's profile the moment a composition installs /
  // uninstalls (the upsert observer alone fires only on a connection-row change, so
  // a connect-BEFORE-install would otherwise wait for the next reconnect/boot).
  const reconcileConnectionProfile = seededOperationProfiles?.reconcileConnectionProfile;
  // D-177 N.11 rule 5 (slice D) — narrowed const so the closure below
  // captures the index non-undefined (the conditional spread alone would
  // not narrow the `app` property access inside the lambda).
  const forwardedSenderIndex = app.chatForwardedSenderIndexRef;
  // D-196 R2 — approval resume must prove the CURRENT configured model route,
  // not the route that existed when the model first raised the held tool call.
  // Match the public LLM gateway's live-config preference and fail closed on a
  // locked/unreadable manager or unavailable slot/pool.
  const isLlmGatewayRouteReady = (): boolean => {
    let config = app.llmConfig;
    try {
      config = app.llmManager?.getConfig() ?? app.llmConfig;
    } catch {
      return false;
    }
    return config !== undefined
      && resolveLlmGatewayRoute(config, { quota: app.llmQuota }).ok;
  };
  // Canonical intake acceptance sits on the shared resumer rather than the
  // Inbox RPC: approvals from Inbox, the global queue, a batch, or boot
  // recovery all pass here. The hook is present whenever the audit anchor is
  // available. Missing stores / key material are carried as absent deps so an
  // actual intake approval fails closed, while unrelated approvals remain a
  // strict no-op.
  const beforePreflightResume = storage.auditLog
    ? createFormResponsePromotion({
        auditLog: storage.auditLog,
        ...(storage.intakeFormSubmissionStoreRef
          ? { submissionStore: storage.intakeFormSubmissionStoreRef }
          : {}),
        ...(storage.formResponseStoreRef
          ? { formResponseStore: storage.formResponseStoreRef }
          : {}),
        onCreated: (response) => emitFormResponseCreatedEvents({
          realtimeBus: storage.eventBus,
          warehouseBus: app.warehouseBus,
        }, response),
        ...(app.keys
          ? {
              getFormSubmissionPiiKey: () =>
                deriveFormSubmissionPiiKeyFromSubDek(app.keys!.getSubDEK('reception')),
            }
          : {}),
        ...(app.sharedStoreRef
          ? {
              admitPaidDirectCheckoutReview:
                createPaidDocumentDirectCheckoutReviewAdmission(app.sharedStoreRef),
            }
          : {}),
      })
    : undefined;
  const executeDepsBundle = composeExecuteDeps({
    // D-210 A.8 slice 3d — the SAME resolved link the email channel got above,
    // deliberately not re-resolved: one public-base-URL decision, so a
    // deployment can never end up with a link on one surface and not the other.
    ...(askAnswerLink ? { askAnswerLink } : {}),
    recipeStore: storage.recipeStore,
    executorConfig,
    baseVault,
    serverInstanceId: storage.serverInstanceId,
    serverDisplayName,
    eventBus: storage.eventBus,
    // D-179 P4 — run-outcome trigger-source events emit onto the same
    // warehouse bus the event-trigger dispatcher subscribes.
    warehouseBus: app.warehouseBus,
    auditLog: storage.auditLog,
    sharedStore: app.sharedStoreRef,
    db: storage.db,
    enrichmentStore: app.enrichmentStoreRef,
    commitStore: storage.commitStore,
    checkpointStore: storage.checkpointStore,
    annotationStore: app.annotationStoreRef,
    // D-182 §10 step 8 / R1 (Fix 2) — installed-manifest store so the run-path R1
    // pre-pass builds the merged convention-family vendor registry (built-ins +
    // pack-composition vendors), binding a connected `acct` / 3rd-party CRM vendor.
    localManifestStore: storage.localManifestStore,
    // D-177 N.11 rule 1 — contact store for the open-projection walk's
    // per-row stored-cleanliness gate (dotted-email record resolution).
    ...(app.contactStoreRef ? { contactStore: app.contactStoreRef } : {}),
    // Document-toolkit — hand the inbound data.file collection to the cli
    // executor so an `output_capture` op (docling parse-in) lands its produced
    // file as a `tool_output` data.file and returns `result.file_ref`.
    ...(collection.inboundFileCollection
      ? { inboundFileCollection: collection.inboundFileCollection }
      : {}),
    // D-188 — the master pause flag so the op-admission gate freezes every
    // governed dispatch (owner-AI + doors) while paused. Read live per
    // dispatch off the same server-state store the rpc + heartbeat consult.
    ...(app.serverState
      ? { isServerPaused: (): boolean => app.serverState!.isPaused() }
      : {}),
    // D-202 task 4a — the persisted Switch A/B quality kill-switch reader, so the
    // gateway's ask-branch can skip a per-artifact review for a quality-delegated
    // `(recipe, op)`. Read live per dispatch off the same server-state store the
    // `server.getQualitySwitches` rpc + the #contracts toggle consult, so a pause
    // takes effect on the next ask. (Returns `QualityGateSwitchStatus`, structurally
    // a `QualityGateSwitches`.)
    ...(app.serverState
      ? { qualityGateSwitches: () => app.serverState!.getQualityGateSwitches() }
      : {}),
    getExecuteDeps: lateBound.getExecuteDeps,
    ...(beforePreflightResume ? { beforePreflightResume } : {}),
    // D-210 Phase C — the device-fanout thunk. A THUNK because the setting
    // is editable and this composes once at boot; absent store ⇒ omitted
    // ⇒ every hold raises the actionable ask (pre-Phase-C behaviour).
    ...(storage.publicEndpointRegistryStoreRef
      ? {
          resolveInboxFanoutMode: () =>
            resolveReceptionInboxFanoutModeFromStore(
              storage.publicEndpointRegistryStoreRef!,
            ),
        }
      : {}),
    // D-192 Slice 6c — the lazy write-executor accessor for the create-plan approve
    // dispatcher. The ref is populated post-listener; the thunk derefs at answer
    // time (long after boot), so the create-plan handler reaches the live executor.
    getWorkEntityWriteExecutor: () => app.workEntityWriteExecutorRef.current,
    // D-163 Slice B — `ChannelReadinessProbe` backings, plumbed
    // straight from the AppContext stores. `connectionStore` backs the
    // credential-backed `slack` / `telegram` / `email` probe paths;
    // `clientTokens` backs the pair-presence `bridge` probe. Both are
    // optional in the wire helper (absent ⇒ corresponding rows
    // `not_ready`), but the daemon path passes both whenever the
    // post-storage db is wired. `bridgeSink` is an explicit slot for a
    // future slice that wires the production OS-notification transport
    // — until then the wire helper substitutes a no-op fallback so the
    // Bridge channel still constructs for Settings rendering.
    ...(app.connectionStoreRef ? { connectionStore: app.connectionStoreRef } : {}),
    ...(app.clientTokensRef ? { clientTokens: app.clientTokensRef } : {}),
    ...(app.chatInboundTokenStoreRef
      ? {
          inboundTokenStore: app.chatInboundTokenStoreRef,
          isLlmGatewayRouteReady,
        }
      : {}),
    ...(options.bridgeSink ? { bridgeSink: options.bridgeSink } : {}),
    // D-192 CORE #6 seam 7 (Group D) — the vendor→RemoteChannel registry
    // (empty when no connection store) threaded through to the notification
    // block. `composeExecuteDeps` conditionally forwards it (empty object is
    // truthy, so a non-empty registry always propagates).
    messengerChannels,
    ...(emailChannel ? { emailChannel } : {}),
    // D-165 P1 — hand the seeded operation-profile store (built above) to the
    // gateway. Done at this layer (not inside composeExecuteDeps) so the deps
    // composer stays side-effect-free.
    ...(connectionOperationProfileStore
      ? { connectionOperationProfiles: connectionOperationProfileStore }
      : {}),
    // D-182 §7.2 — the cli reachability resolver (the AUTHORITATIVE cli
    // authorization source; built above from the contract store). Absent ⇒ cli
    // ops fail closed `cli_reachability_disabled` (reachability defaults OFF).
    ...(cliReachabilityResolver ? { cliReachabilityResolver } : {}),
    // D-166 Slice 4d.4 — hand the local-only `contract.*` store to the gateway's
    // override-tightening layer. The SAME handle the contract rpcs write override
    // rows through (4d.1 retained it on `app`), so a freshly-written override is
    // read live by the next dispatch. Absent (no db / daemon-lite) ⇒ no override
    // layer; the connection-keyed profile floor is authoritative.
    ...(app.contractStoreRef ? { contractStore: app.contractStoreRef } : {}),
    // D-196 — seller-customer admission is re-checked for held raw MCP ops at
    // approval resume time, after expiry/grace/status may have changed.
    ...(app.sellerStoreRef ? { sellerCustomerAdmissionStore: app.sellerStoreRef } : {}),
    // D-177 N.11 rule 5 (slice D) — the forwarded-sender candidate lookup,
    // closed over the chat bundle's per-session index (`chat:<session_id>`
    // mapped by `scopedCandidatesForChannelSession`; non-chat sessions
    // resolve empty). Absent index ⇒ scoped grants never match (fail closed).
    ...(forwardedSenderIndex
      ? {
          scopedSenderCandidates: (channel_session_id: string) =>
            scopedCandidatesForChannelSession(
              forwardedSenderIndex,
              channel_session_id,
            ),
        }
      : {}),
  });

  const executeDeps = executeDepsBundle.executeDeps;
  lateBound.publishExecuteDeps(executeDeps);

  return {
    executorConfig,
    executeDeps,
    notificationBlock: executeDepsBundle.notificationBlock,
    preflightResumer: executeDepsBundle.preflightResumer,
    // D-207 slice 1c — the contract substrate a reception door is minted into. Surfaced
    // from the SAME bundle the Gateway's verdict path was built from, so the mint's grant
    // rows and the gate's reads are the same instances (see `ExecuteDepsBundle`).
    contractDefinitionStore: executeDepsBundle.contractDefinitionStore,
    grantEntryStore: executeDepsBundle.grantEntryStore,
    messengerChannels,
    emailChannel,
    serverDisplayName,
    // D-165 follow-on — the live operation-profile instance the gateway
    // resolves against. Exposed so `composeListeners` can wire the grant rpcs
    // to mutate THIS instance (grant → write→ask reachable on next dispatch).
    connectionOperationProfileStore,
    // D-170 gap #2 live-reconcile — exposed so `composeListeners` can thread it
    // into the install/uninstall deps (immediate profile (re)derive on a
    // composition install/uninstall, which leaves the connection row untouched).
    reconcileConnectionProfile,
  };
};
