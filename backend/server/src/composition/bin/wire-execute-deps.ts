/** D-157 / executeDeps surgical extraction — boot composer that
 *  produces the `ExecuteHandlerDeps` object literal AND the optional
 *  notification block that threads onto it as `preflightNotifier`.
 *
 *  Two pieces fold together because they are tightly bound at boot:
 *    1. The D-158 notification block (conditionally composed when
 *       `db && auditLog && checkpointStore && annotationStore` are all
 *       present) supplies `executeDeps.preflightNotifier`.
 *    2. `executeDeps` itself is a single object literal with conditional
 *       spreads (`db`, `enrichmentStore`,
 *       `commitStore`, `checkpointStore`, `preflightNotifier`) and three
 *       direct-but-optional fields (`auditLog`, `sharedStore`, plus the
 *       always-present `instanceId` / `serverName` aliases).
 *
 *  The resumer inside the notification block closes over a
 *  `getExecuteDeps` thunk so it can dereference `executeDepsRef` at
 *  answer time — well AFTER `executeDepsRef = bundle.executeDeps` has
 *  run on the caller side. The helper passes the caller's thunk through
 *  unchanged so the late-bound dance survives the move.
 *
 *  Failure-graceful posture preserved field-by-field:
 *    - `db === undefined` ⇒ `executeDeps.db` key absent; provenance link
 *      emission skipped, no notification block, daemon-only mode.
 *    - `auditLog === undefined` ⇒ key present with `undefined` value
 *      (matching pre-extraction); execute-handler skips audit append.
 *    - notification-block prereqs partial ⇒ block stays unwired and
 *      `preflightNotifier` key is omitted (graceful degradation; paused
 *      runs persist a durable checkpoint but no user-facing ask fires).
 */

import type Database from 'better-sqlite3';
import type { PreflightRunSettled } from '../../preflight-resumer.js';
import { createPeerAskOutboxStore } from '../../storage/peer-ask-outbox-store.js';
import { journalOwnsClaimedPeerDispatch } from '../../peer-ask-delivery-recovery.js';
import { createPeerAdmissionStore } from '../../storage/peer-admission-store.js';
import type {
  BatchAskRecord,
  Checkpoint,
  ExecutionLane,
  OwnerOperationPolicyInput,
  PreflightOverrideOffer,
  QualityGateSwitches,
  ScopedSenderCandidate,
} from '@recued/contracts';
import {
  OWNER_OPERATION_SCOPE,
  isCatalogForm,
  operationSpecHash,
} from '@recued/contracts';
import type {
  AuditLogStore,
  CheckpointStore,
  CommitStore,
} from '@recued/storage';
import type {
  BridgeSink,
  Channel,
  NotificationBlock,
  RemoteChannel,
} from '@recued/notification';
import type { PreflightAskContext, PreflightResumer } from '@recued/gateway';
import { resolveServerTimeZone, type ReceptionInboxFanoutMode } from '@recued/contracts';
import { createServerTimeZoneStore } from '../../storage/server-timezone-store.js';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { McpActionStore } from '../../mcp-action-store.js';
import type { GatedActionStore } from '../../gated-action-store.js';
import type { SettledRunResults } from '../../settled-run-results.js';
import type { WorkEntitySourceWriteExecutor } from '../../work-entity-write-executor.js';
import type { EventBus } from '../../events/bus.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { RecordsStore } from '../../records/index.js';
import type { ServerExecutorConfig } from '../../server-executor.js';
import type { SharedStore } from '../../storage/shared-store.js';
import type { UserMemoryStore } from '../../user-memory-store.js';
import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { AnnotationStore } from '../../storage/annotation-store.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { ClientTokenStore } from '../../pairing/client-tokens.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { LocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { createDishStore } from '../../dish-store.js';
import { createDishGroupStore } from '../../dish-group-store.js';
import { createDishContextStore } from '../../dish-context-store.js';
import { createLaneSemaphore } from '../../execution/lane-semaphore.js';
import { createOpDurationClassifier } from '../../execution/op-duration-classifier.js';
import {
  createInFlightRegistry,
  type InFlightRegistry,
} from '../../execution/in-flight-registry.js';
import {
  createCliInvocationExecutor,
  type ToolOutputFileIngestInput,
} from '../../cli-invocation-executor.js';
import type { InboundFileCollection } from '../../collections/file/inbound-file-collection.js';
import {
  resolveRemoteFileBytes,
  type RemoteFileReadDeps,
} from '../../collections/file/remote-file-byte-resolver.js';
import { parseRemoteFileRecordId } from '../../file-view-resolver.js';
import type { UploadStagingRegistry } from '../../collections/file/upload-staging.js';
import { composeNotificationBlock } from './wire-notification-block.js';
import {
  createInMemoryConnectionOperationProfileStore,
  type ConnectionOperationProfileStore,
} from '../../connection-operation-profile.js';
import {
  createContractScanFn,
  type ContractStore,
} from '../../storage/contract-store.js';
import { createCliReachabilityStore } from '../../storage/cli-reachability-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../../storage/contract-definition-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../../storage/contract-grant-entry-store.js';
import { createQualityDelegationSignalStore } from '../../storage/quality-delegation-signal-store.js';
import { createOpAdmissionGate } from '../../op-admission-gate.js';
import { createContractOverlayResolver } from '../../policy-contract-overlay.js';
import { createSessionGrantResolver } from '../../session-grant-resolver.js';
import { createQualityGateResolver } from '../../quality-gate-resolver.js';
import type { SellerCustomerAccessAdmissionStore } from '../../seller/customer-access-admission.js';
import type { BatchApprovalCoordinator } from '../../batch-approval.js';
import { createApprovalResumeAuthorityResolver } from '../../approval-resume-authority.js';
import { upsertOwnerOperationOverride } from '../../contract-handler.js';

/** Inputs to compose the executeDeps surface.
 *
 *  Always-required fields (helper crashes without them) are non-optional;
 *  every other field is `T | undefined` so the caller passes the same
 *  let-binding refs it holds today without pre-narrowing. The helper
 *  reproduces the bin.ts pattern verbatim: direct assignment for the
 *  three "optional but always keyed" fields (`auditLog`, `sharedStore`,
 *  and the always-defined `instanceId` / `serverName` aliases) and
 *  conditional spread for the "key absent when undefined" fields
 *  (`db`, `enrichmentStore`, `commitStore`,
 *  `checkpointStore`, plus the resumer-derived `preflightNotifier`). */

/** The owner's zone, read per call: the owner's setting when there is one,
 *  else the host's (`resolveServerTimeZone`). */
const ownerTimeZoneOf = (db: Database.Database): (() => string) => {
  const store = createServerTimeZoneStore(db);
  return () => resolveServerTimeZone(store.read(), Intl.DateTimeFormat().resolvedOptions().timeZone);
};

export interface ComposeExecuteDepsDeps {
  /** D-137 — late-bound chat sink for a run that settled after its turn.
   *  A GETTER because chat composes in the app context and this in the
   *  execution context; the sink does not exist when this runs. */
  readonly getRunSettledSink?: () =>
    ((settled: PreflightRunSettled) => void) | undefined;
  /** Forwarded to the notification block: keeps what an owner's page-started
   *  run answered once its approval let it finish, for `execution.get`. */
  readonly settledRunResults?: SettledRunResults;

  /** D-210 A.8 slice 3d — forwarded verbatim to the notification block so
   *  `inline` channel asks carry the `/ask/<ask_id>` link. Pass-through only;
   *  nothing here resolves it (the public base URL is not in scope at this
   *  layer). */
  askAnswerLink?: (ask_id: string) => string | undefined;
  /** D-234 § 234.3 — resolve a recipe's `metadata.owner_surface` to an absolute
   *  webclient link, so the peer-admission entry ask can carry "read it here".
   *  Like `askAnswerLink`, it answers nothing while the server has no public
   *  address, so the ask goes out with no link rather than an unopenable one. */
  ownerSurfaceLink?: (recipe_id: string) => string | undefined;
  recipeStore: RecipeStore;
  /** D-221 — server-local Records authority. The engine reaches it only after
   * the ordinary catalog policy, operation-grant, and approval gates admit. */
  recordsStore?: RecordsStore;
  executorConfig: ServerExecutorConfig;
  baseVault: Record<string, unknown>;
  serverInstanceId: string;
  serverDisplayName: string;
  eventBus: EventBus;
  /** D-179 P4 — warehouse bus (emit side). When provided, the execute
   *  handler emits `run.<recipe_id>.<dish_id>.<completed|failed>`
   *  run-outcome trigger-source events at terminal outcome. Optional —
   *  daemon-lite / unit paths skip outcome events. */
  warehouseBus?: Pick<import('@recued/warehouse-events').WarehouseEventBus, 'emit'>;
  auditLog: AuditLogStore | undefined;
  sharedStore: SharedStore | undefined;
  /** D-231 — backs `{{data.memory.<memory_id>}}`. Undefined on db-less
   *  daemon paths; the namespace then reads undefined, like `sharedStore`. */
  userMemoryStore?: UserMemoryStore | undefined;
  db: Database.Database | undefined;
  enrichmentStore: EnrichmentStore | undefined;
  commitStore: CommitStore | undefined;
  checkpointStore: CheckpointStore | undefined;
  mcpActionStore?: McpActionStore;
  gatedActionStore?: GatedActionStore;
  /** Notification-block prereq beyond the four executeDeps shares above
   *  (db / auditLog / checkpointStore). Helper composes the block only
   *  when all four are present together. ALSO forwarded onto
   *  `executeDeps.annotationStore` (D-177 rule-1 follow-on fix): the
   *  engine's per-record annotation/link prefetch and the
   *  stored-cleanliness gate both read it there — previously the
   *  literal never forwarded it, so inline
   *  `{{data.<col>.<id>.annotations.<key>}}` refs silently resolved
   *  undefined on the daemon + mcp paths. */
  annotationStore: AnnotationStore | undefined;
  /** D-177 N.11 rule 1 — contact store for the open-projection walk's
   *  per-row stored-cleanliness gate. Optional; absent ⇒ contact-record
   *  roots stay tainted-pinned. */
  contactStore?: ContactStore;
  /** Lazy accessor for `executeDeps` itself. The notification block's
   *  preflight resumer closes over this thunk and dereferences it at
   *  answer time — by then the caller has assigned
   *  `executeDepsRef = bundle.executeDeps`. Pre-publish reads (impossible
   *  to hit on the happy path) surface as `execution_error` in the
   *  resumer's downstream `handleExecute` call. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** Approval-time durable effects that must finish before an approved
   * checkpoint resumes. Threaded into the notification block's shared
   * single/batch resumer wrapper. */
  beforePreflightResume?: (
    checkpoint: Checkpoint,
    context: PreflightAskContext,
  ) => Promise<void>;
  /** D-210 Phase C — the owner's inbox device-fanout mode, forwarded onto
   *  `executeDeps` for the preflight raise branch AND onto the boot sweep
   *  (so a deliberately ask-less notify hold is not re-raised). A thunk:
   *  the setting is live and this composes once. */
  resolveInboxFanoutMode?: () => ReceptionInboxFanoutMode;
  /** D-192 Slice 6c — lazy accessor for the boot-singleton work-entity write
   *  executor (populated post-listener). Threaded onto the notification block so
   *  the create-plan answer dispatcher can run `executeCreatePlan`, and onto
   *  executeDeps as the `createPlanNotifier`. Absent ⇒ the create-plan ask +
   *  handler are not wired. */
  getWorkEntityWriteExecutor?: () => WorkEntitySourceWriteExecutor | null;
  /** D-163 Slice B — credential-backed `ChannelReadinessProbe` source
   *  for the `slack` / `telegram` / `email` channels. Optional; absent ⇒
   *  those rows read `not_ready`. Threaded straight into the
   *  notification block's wire helper. */
  connectionStore?: ConnectionStoreSqlite;
  /** D-182 §10 step 8 / R1 (Fix 2) — installed-manifest store, forwarded onto
   *  `ExecuteHandlerDeps.localManifestStore` so the run-path R1 pre-pass builds
   *  the merged convention-family vendor registry (`liveVendorRegistry`:
   *  built-ins + pack-composition vendors). Without it the run path saw only
   *  built-in HubSpot/Salesforce, so a connected `acct` vendor never made a
   *  `core.acct.*` recipe runnable. Absent (dbless / unit) ⇒ built-ins only
   *  (the fail-safe). */
  localManifestStore?: Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'>;
  /** D-163 Slice B — pair-presence `ChannelReadinessProbe` source for
   *  the `bridge` channel. Lifted from `composeClientSecurityContext`
   *  to `composeAppContext` so the probe consults the same SQLite
   *  rows the cert-stack reads (D-163 § N.5). Absent ⇒ Bridge row
   *  reads `not_ready`, matching the install-CTA posture. */
  clientTokens?: ClientTokenStore;
  /** D-196 R2 — canonical inbound door bearer store. Approval resume looks the
   * token up again by the id persisted in `ExecutionSource`; the old snapshot
   * never substitutes for a missing/revoked/rebound row. */
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById'>;
  /** D-196 R2 — live Settings -> LLM route probe, evaluated only for an
   * `llm_gateway:*` approval source immediately before its resumed effect. */
  isLlmGatewayRouteReady?: () => boolean;
  /** D-163 Slice B — Bridge OS-notification sink. A future slice
   *  injects the production transport once the `BridgeCommand`
   *  dispatcher reaches `ws-server`; today the slot is plumbed but
   *  unwired, so the Bridge channel's `deliverNotify` is a silent
   *  no-op until then. */
  bridgeSink?: BridgeSink;
  /** D-192 CORE #6 seam 7 (Group D) — the `vendor → RemoteChannel` messenger
   *  registry (slack / telegram / …), built ONCE in `compose-execution-context`
   *  against the same `connectionStore` the probe consults, so each adapter and
   *  its credential row stay in lock-step. Threaded straight through to
   *  `composeNotificationBlock`. Absent / empty ⇒ that vendor stays out of the
   *  fan-out set and its Settings row reads `not_ready` (Slice B's fail-closed
   *  posture). Replaces the per-vendor `slackChannel` / `telegramChannel`. */
  messengerChannels?: Record<string, RemoteChannel>;
  /** D-158 P2b — pre-built email `Channel` (not a `RemoteChannel`; email
   *  rides the BYO mail account, not `@recued/transport`). Built by
   *  `composeEmailChannel` against the same `connectionStore` the probe
   *  consults. Absent ⇒ email stays out of the fan-out set and the
   *  Settings row reads `not_ready`. */
  emailChannel?: Channel;
  /** D-165 P1 — caller-provided per-connection operation-profile store,
   *  already boot-seeded for enrolled provider connections (build it with
   *  `createSeededCatalogOperationProfileStore`). The catalog gateway resolves
   *  grants against it. Absent ⇒ `composeExecuteDeps` falls back to an empty
   *  in-memory store (every catalog op fails closed — matches the P0 posture
   *  + the dbless / unit-test path). Seeding is done at the caller layer so
   *  this composer stays side-effect-free (no store I/O at compose time). */
  connectionOperationProfiles?: ConnectionOperationProfileStore;
  /** D-182 §7.2 — caller-provided cli reachability resolver (built at the boot
   *  layer from the local `contract.*` store, e.g.
   *  `createCliReachabilityResolver`). The AUTHORITATIVE `cli` authorization
   *  source (increment 3): a `cli` catalog op authorizes against this
   *  per-(principal × cli-ingredient × risk_tier) allowlist instead of a
   *  connection profile. Absent (dbless / unit) ⇒ cli ops fail closed
   *  `cli_reachability_disabled` (reachability defaults OFF). Forwarded verbatim
   *  onto the execute deps. */
  cliReachabilityResolver?: ExecuteHandlerDeps['cliReachabilityResolver'];
  /** D-166 Slice 4d.4 — caller-provided local-only `contract.*` store (the
   *  serve path's `app.contractStoreRef` / the MCP boot path's local handle).
   *  The composer wraps it once with `createContractScanFn` and exposes the
   *  resulting `ScanFn` as `executeDeps.contractScan`, which the catalog gateway
   *  uses to TIGHTEN a resolution with the user's `contract.override` rows.
   *  Absent ⇒ no `contractScan` dep ⇒ the override layer is skipped (the
   *  connection-keyed profile floor is authoritative — dbless / unit paths). */
  contractStore?: ContractStore;
  /** D-196 seller-customer admission store. Forwarded onto execute deps so a
   *  held raw-op approval can re-check customer status/grace before dispatch. */
  sellerCustomerAdmissionStore?: SellerCustomerAccessAdmissionStore;
  /** D-177 N.11 rule 5 (slice D) — the per-channel-session forwarded-sender
   *  candidate lookup, closed over the chat bundle's
   *  `SessionForwardedSenderIndex` (`scopedCandidatesForChannelSession`).
   *  Threaded verbatim onto `executeDeps.scopedSenderCandidates` so the
   *  gateway grant hooks can evaluate a `'scoped'` grant's 5.d containment.
   *  Absent (no chat surface — dbless / daemon-lite) ⇒ scoped grants never
   *  match (fail closed). */
  scopedSenderCandidates?: (
    channel_session_id: string,
  ) => ReadonlyArray<ScopedSenderCandidate>;
  /** Document-toolkit — the inbound `data.file.received` collection. When
   *  present, a foreground cli op that declares `binding.output_capture` lands
   *  its produced file here (origin `tool_output`) and the resulting record_id
   *  becomes `result.file_ref`. Absent (dbless / no-CAS harness) ⇒ an
   *  output_capture op fails closed in the executor. */
  inboundFileCollection?: InboundFileCollection;
  /** D-241 P4 — the D-192 remote byte bundle, so the cli executor's
   *  `input_materialize` reader can answer for a `file:remote:*` id (a File
   *  Source mirror row) and not just a CAS blob.
   *
   *  ⛔ **This is what stood between a synced Dropbox / Box / Notion document
   *  and a converter, and it was never a missing capability — the per-vendor
   *  resolvers have shipped since D-192 and already serve three other read
   *  channels.** The cli reader simply had one branch: CAS or refuse. A
   *  converter wants BYTES on a temp path, not a CAS record, so routing a
   *  remote id to `resolveRemoteFileBytes` is the whole fix.
   *
   *  Undefined ⇒ a remote id refuses exactly as it did before (the standalone
   *  MCP boot composes no file-source stores). */
  getRemoteFileReadDeps?: (() => RemoteFileReadDeps | undefined) | undefined;
  /** D-217 slice 2b-ii — staged plaintext for a chunked upload's egress. The
   *  engine stages once per walk and disposes in a `finally`; the connection
   *  adapter reads one range per APPEND against the same registry, addressed by
   *  the token the engine put on the wire. Absent (dbless / no-CAS harness) ⇒ a
   *  chunked upload fails closed before any byte leaves. */
  uploadStagingRegistry?: UploadStagingRegistry;
  /** Single supervised-daemon entry point. Present on the full server compose;
   *  absent in db-less/MCP-only harnesses, where legacy executor behavior is
   *  retained. */
  startSupervisedDaemon?: (call: import('@recued/engine').CliInvocationCall) => Promise<unknown>;
  /** D-188 — the master "Pause server" flag (server-state `isPaused`).
   *  When provided, the op-admission gate FREEZES every governed dispatch
   *  (owner-AI + doors) with a `server_paused` deny while paused; the
   *  contract-free owner HID + system channels bypass it (see
   *  `op-admission-gate.ts isFrozenByPause`). Absent (dbless / unit) ⇒ the
   *  gate leaves pause unenforced (the scheduler-pause + webhook-closure
   *  halves still apply where they're wired). */
  isServerPaused?: () => boolean;
  /** D-202 task 4a — read the persisted Switch A/B quality kill-switch state
   *  (server-state `getQualityGateSwitches`). When provided alongside a contract
   *  store, the quality-gate resolver is built and the commit Gateway's
   *  ask-branch can skip a per-artifact review for a quality-delegated
   *  `(recipe, op)` (un-paused). Absent (dbless / unit) ⇒ no resolver ⇒ every ask
   *  holds exactly as pre-D-202 (additive). */
  qualityGateSwitches?: () => QualityGateSwitches;
}

/** Bundle returned to the caller. `notificationBlock` is undefined when
 *  any of the four block prereqs (`db` / `auditLog` / `checkpointStore`
 *  / `annotationStore`) is missing — matching the pre-extraction
 *  graceful-degradation posture. `bin.ts` retains both handles: the
 *  block is referenced again at boot recovery (`recoverNotificationBlockAtBoot`
 *  + `raiseInDoubtForSweptCommits`); `executeDeps` is what every
 *  downstream surface (scheduler, auto-run, MCP transport, chat tool
 *  registry, etc.) dispatches through. */
export interface ExecuteDepsBundle {
  executeDeps: ExecuteHandlerDeps;
  notificationBlock: NotificationBlock | undefined;
  /** Narrow LIVE batch-membership read (`NotificationBlockBundle.getBatch`).
   *  The `/ask` landing needs the CURRENT member count before it may render a
   *  batch-registered hold's values as the approval. Undefined alongside
   *  `notificationBlock`. */
  getBatch:
    | ((batch_id: string) => Promise<Pick<BatchAskRecord,
      'state' | 'current_ask_id' | 'members' | 'answer_option'> | null>)
    | undefined;
  reconcileOpenBatch:
    | BatchApprovalCoordinator['reconcileOpenBatch']
    | undefined;
  /** D-210 Phase C — the DECORATED preflight resumer (the one
   *  `withBeforePreflightResume` wrapped), surfaced so the Reception inbox
   *  can release a hold that carries no durable ask.
   *
   *  It has to be this instance, not a freshly-composed one: the intake
   *  acceptance hook rides the decoration, and keeping every approval
   *  surface — Inbox, the global queue, batch, boot recovery — on one
   *  resumer is what stops the no-ask path from developing quietly
   *  different approval semantics. Undefined alongside `notificationBlock`
   *  (same four prereqs). */
  preflightResumer: PreflightResumer | undefined;
  /** D-181 slice 4 — the live in-flight execution registry, surfaced so the
   *  boot site can wire the owner-only `execution.{active,kill,cancel,promote}`
   *  rpc handlers against the SAME instance the execute-handler + cli executor
   *  feed. */
  inFlightRegistry: InFlightRegistry;
  /** D-207 slice 1c — the contract substrate the reception door is minted into.
   *
   *  Surfaced (not rebuilt at the boot site) so the door's grant rows are written through
   *  the SAME stores the Gateway reads them back from. A second instance over the same
   *  table would work today and rot the first time either side grows a cache: the mint
   *  would write grants the gate could not see, and the door would deny everything it had
   *  just been told to allow. Absent ⇒ no contract store (dbless) ⇒ no doors can be hung. */
  contractDefinitionStore: ContractDefinitionStore | undefined;
  grantEntryStore: ContractGrantEntryStore | undefined;
}

/** Compose the notification block (optional) + executeDeps. */
export const composeExecuteDeps = (
  deps: ComposeExecuteDepsDeps,
): ExecuteDepsBundle => {
  // D-166 / D-177 — the contract-definition substrate is built FIRST
  // (moved above the block composition in P5a): the session-grant
  // resolver threads into the notification-block composer so the
  // batch-approval coordinator can mint `grant_mode: 'batch'` grants
  // from answered snapshots (N.10). Pure construction — no reads run
  // until a dispatch / answer fires, so the reorder is order-only.
  const contractScan = deps.contractStore
    ? createContractScanFn(deps.contractStore)
    : undefined;
  // D-182 §8 door-cli authorization path — a per-principal lister over the SAME
  // `contract.*` cli-reachability rows the engine's `cliReachabilityResolver`
  // (above) and the `cli.reachability.*` grid rpc read/write. Returns the
  // distinct cli ingredient slugs a principal has an `allowed: true` grant for
  // (any op). The MCP snapshot builder (`buildMcpContractSnapshot`) unions these
  // into `allowed_tools` so a door-triggered recipe with a cli step clears the
  // `tool_not_in_contract` policy gate; the resolver still enforces the exact
  // granted OPERATION. Absent contract store (dbless / unit) ⇒ undefined ⇒ no union.
  const cliReachableSlugsForPrincipal = deps.contractStore
    ? ((store) =>
        (principal: string): string[] =>
          Array.from(
            new Set(
              store
                .listForPrincipal(principal)
                .filter((row) => row.allowed)
                .map((row) => row.ingredient_id),
            ),
          ))(createCliReachabilityStore(deps.contractStore))
    : undefined;
  const contractDefinitionStore = deps.contractStore
    ? createContractDefinitionStore(deps.contractStore)
    : undefined;
  const sessionGrantResolver = contractDefinitionStore
    ? createSessionGrantResolver({
        definitionStore: contractDefinitionStore,
        ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
        broadcast: (event) => deps.eventBus.emit(event),
      })
    : undefined;
  // D-202 task 4a — the quality-delegation resolver (the second gate axis). Built
  // only when both a contract store (the `listQualityDelegations` source) AND the
  // persisted Switch A/B reader are present; absent either ⇒ the Gateway's quality
  // dep is omitted and every ask holds exactly as pre-D-202.
  const qualityGateResolver =
    contractDefinitionStore && deps.qualityGateSwitches
      ? createQualityGateResolver({
          definitionStore: contractDefinitionStore,
          getSwitches: deps.qualityGateSwitches,
        })
      : undefined;
  // D-202 Slice 1b — the durable quality VERDICT store (the reject-driven
  // learner's write side). Built over the same contract store as the resolver
  // above and threaded to the host resumer via the notification block, so a
  // resolved quality-relevant ask records a `QualityDelegationSignal`. Absent no
  // contract store ⇒ no signal (byte-identical to pre-1b).
  const qualityDelegationSignalStore = deps.contractStore
    ? createQualityDelegationSignalStore(deps.contractStore)
    : undefined;
  const preflightOverrideWriter = deps.contractStore
    ? async (offer: PreflightOverrideOffer): Promise<void> => {
        const manifest = deps.executorConfig.manifests.get(offer.ingredient_id);
        const currentOperation = manifest === null
          ? undefined
          : isCatalogForm(manifest)
            ? Object.values(manifest.operations ?? {}).find(
                (operation) => operation.operation_id === offer.operation_id,
              )
            : manifest.slug === offer.operation_id
              ? { operation_id: manifest.slug, risk_tier: manifest.risk_tier }
              : undefined;
        if (
          currentOperation === undefined
          || operationSpecHash(currentOperation) !== offer.op_hash
        ) {
          throw new Error(
            `standing owner action for '${offer.operation_id}' is stale because the `
              + 'operation changed or was removed; review a fresh ask',
          );
        }
        const segments = [offer.ingredient_id, offer.operation_id];
        const prior = (
          deps.contractStore!.get(OWNER_OPERATION_SCOPE, segments)?.value ?? {}
        ) as unknown as Readonly<Record<string, unknown>>;
        // `op_hash` is server-owned and gets freshly stamped by the rpc core.
        // Preserve the other global operation facet while changing approval.
        const { op_hash: _priorOpHash, ...priorPolicy } = prior;
        const policy: OwnerOperationPolicyInput = {
          ...(priorPolicy as OwnerOperationPolicyInput),
          approval: offer.approval,
        };
        await upsertOwnerOperationOverride(
          {
            store: deps.contractStore!,
            getManifest: (slug) => deps.executorConfig.manifests.get(slug),
            listManifests: () => deps.executorConfig.manifests
              .slugs()
              .flatMap((slug) => {
                const manifest = deps.executorConfig.manifests.get(slug);
                return manifest === null ? [] : [manifest];
              }),
            ...(deps.auditLog !== undefined ? { auditLog: deps.auditLog } : {}),
          },
          {
            ingredient_id: offer.ingredient_id,
            operation_id: offer.operation_id,
            policy,
          },
        );
      }
    : undefined;

  // One process-wide handle for both execute and reconciliation. Construct it
  // before the notification block so an answered approval that finds its
  // receipt already dispatching can prove an exact staged peer checkpoint and
  // avoid replaying around the journal.
  const peerAskOutbox = deps.db
    ? createPeerAskOutboxStore(deps.db)
    : undefined;
  const preserveClaimedPeerDispatch = peerAskOutbox
    && deps.auditLog
    && deps.checkpointStore
    ? (record: Parameters<typeof journalOwnsClaimedPeerDispatch>[0]) =>
        journalOwnsClaimedPeerDispatch(record, {
          outbox: peerAskOutbox,
          auditLog: deps.auditLog!,
          checkpoints: deps.checkpointStore!,
        })
    : undefined;

  // D-157 server-wiring — compose the D-158 notification block ahead of
  // executeDeps so the block can thread as `preflightNotifier`.
  // Construction needs four pieces: `db` (SQLite collections),
  // `auditLog` (paused-anchor lookup), `checkpointStore` (resume
  // payload load), `annotationStore` (in-doubt reconciliation writer).
  // Absent any of them, the block stays unwired and the preflight /
  // in-doubt paths degrade gracefully — `preflightNotifier: undefined`
  // reduces to "checkpoint persists, no user-facing ask"; absent in-
  // doubt handler leaves swept commits without a surfaced reconciliation
  // prompt (matching pre-wire posture).
  let notificationBlock: NotificationBlock | undefined;
  let getBatch:
    | ((batch_id: string) => Promise<Pick<BatchAskRecord,
      'state' | 'current_ask_id' | 'members' | 'answer_option'> | null>)
    | undefined;
  let reconcileOpenBatch: BatchApprovalCoordinator['reconcileOpenBatch'] | undefined;
  let batchApprovals: BatchApprovalCoordinator | undefined;
  // D-210 Phase C — retained for the inbox's no-ask release path.
  let preflightResumer: PreflightResumer | undefined;
  if (deps.db && deps.auditLog && deps.checkpointStore && deps.annotationStore) {
    const bundle = composeNotificationBlock({
      db: deps.db,
      auditLog: deps.auditLog,
      checkpointStore: deps.checkpointStore,
      ...(deps.mcpActionStore ? { mcpActionStore: deps.mcpActionStore } : {}),
      ...(deps.gatedActionStore ? { gatedActionStore: deps.gatedActionStore } : {}),
      ...(preserveClaimedPeerDispatch !== undefined
        ? { preserveClaimedDispatch: preserveClaimedPeerDispatch }
        : {}),
      annotationStore: deps.annotationStore,
      eventBus: deps.eventBus,
      getExecuteDeps: deps.getExecuteDeps,
      // D-137 — pass the getter, not the sink: chat publishes it later.
      ...(deps.getRunSettledSink !== undefined
        ? { getRunSettledSink: deps.getRunSettledSink }
        : {}),
      ...(deps.settledRunResults !== undefined
        ? { settledRunResults: deps.settledRunResults }
        : {}),
      ...(deps.askAnswerLink !== undefined ? { askAnswerLink: deps.askAnswerLink } : {}),
      ...(deps.beforePreflightResume
        ? { beforePreflightResume: deps.beforePreflightResume }
        : {}),
      ...(preflightOverrideWriter !== undefined
        ? { upsertOverride: preflightOverrideWriter }
        : {}),
      // D-192 Slice 6c — the write-executor accessor for the create-plan approve
      // dispatcher (runs `executeCreatePlan` at answer time).
      ...(deps.getWorkEntityWriteExecutor ? { getWriteExecutor: deps.getWorkEntityWriteExecutor } : {}),
      // D-163 Slice B — optional probe + sink slots threaded through.
      // Absent ⇒ Bridge stays not-ready in Settings and `deliverNotify`
      // becomes a silent no-op (the channel still installs).
      ...(deps.connectionStore ? { connectionStore: deps.connectionStore } : {}),
      ...(deps.clientTokens ? { clientTokens: deps.clientTokens } : {}),
      ...(deps.bridgeSink ? { bridgeSink: deps.bridgeSink } : {}),
      // D-192 CORE #6 seam 7 (Group D) — the messenger channel registry passed
      // through to the block. Conditional-spread discipline preserved: omitted
      // entirely when absent (the bin-wiring ratchet asserts it never rides as
      // `undefined`); an empty registry keeps every messenger vendor's Settings
      // row `not_ready`.
      ...(deps.messengerChannels ? { messengerChannels: deps.messengerChannels } : {}),
      // D-158 P2b email-adapter slice — same conditional-spread shape.
      // Absent ⇒ email adapter-presence gate keeps Settings `not_ready`
      // even with a `connection.notification.email` credential enrolled.
      ...(deps.emailChannel ? { emailChannel: deps.emailChannel } : {}),
      // D-177 P5a — the batch-approval coordinator mints through the
      // resolver built above. Absent (no contract store — dbless) ⇒ batch
      // approves degrade to plain marker resumes.
      ...(sessionGrantResolver !== undefined ? { sessionGrantResolver } : {}),
      // D-202 Slice 1b — the quality VERDICT store for the answer-path resumer.
      // Absent ⇒ no reject-driven learner signal is recorded.
      ...(qualityDelegationSignalStore !== undefined
        ? { qualityDelegationSignalStore }
        : {}),
    });
    notificationBlock = bundle.block;
    getBatch = bundle.getBatch;
    reconcileOpenBatch = bundle.reconcileOpenBatch;
    batchApprovals = bundle.batchApprovals;
    preflightResumer = bundle.resumer;
  }

  // D-165 P0/P1 — per-connection operation-profile store (LOCAL-ONLY). The
  // catalog gateway fails closed on a missing profile (`no_connection_profile`
  // deny, Invariant 3). Boot-seeds it for enrolled catalog-vendor connections —
  // but the SEEDING (which scans the connection store + registers observers)
  // happens at the CALLER layer via `createSeededCatalogOperationProfileStore`,
  // matching the vendor-boot wires and keeping this composer side-effect-free
  // (it must not call `.list()` on a store a unit-test caller may have
  // stubbed). When the caller hands a seeded store we use it; otherwise we
  // fall back to an empty store (every catalog call fails closed — the dbless
  // / unit-test path + the P0 posture). Never synced cloud (D-090/D-097).
  const connectionOperationProfiles =
    deps.connectionOperationProfiles
    ?? createInMemoryConnectionOperationProfileStore();

  // D-166 Slice 4d.4 — wrap the caller's local-only contract store as a `ScanFn`
  // ONCE (the closure reads the store live on each call, so a freshly-written
  // override takes effect mid-session — no stale snapshot). Absent store ⇒
  // undefined, and the dep is omitted below so the gateway's override layer is a
  // no-op (the connection-keyed profile floor stands). NO empty fallback: an
  // empty in-memory profile store fails CLOSED (operations default OFF), but an
  // empty override scan would just resolve no override rows — same as no seam —
  // so a real-but-empty store and no store are equivalent; a missing handle
  // needs no synthetic stand-in.
  // (P5a relocation note) `contractScan` / `contractDefinitionStore` /
  // `sessionGrantResolver` are constructed at the TOP of this composer —
  // the session-grant resolver now precedes the notification-block
  // composition so the batch-approval coordinator can mint through it.
  // D-166 contract_definition — the use-resolution overlay resolver wraps
  // the SAME lifecycle store + scan, so both halves of the gate (static
  // pre-run walk + per-call probe) gate the `.<contract_id>` overlay on
  // `isContractActive(now)` + `contractScopeMatches`, then `recordUse`.
  // Absent store ⇒ undefined ⇒ no overlay layer (additive).
  // D-187 AMENDMENT / slice 5 — the unified per-contract grant store wraps the SAME
  // `ContractStore`. Injected into the overlay so a door dispatch resolves its bound
  // contract's `contract.contract_grant.<contract_id>.*` rows — BOTH the read-grant
  // checker (topic + collection reads) AND the execute-path collection fence (the
  // door scope, derived from the `data.<collection>` grant rows — slice 5 re-homed it
  // off the retired `policy_matrix` overlay cell). Absent store ⇒ the overlay's
  // read-grant checker is author-default-only + its door scope is admit-all.
  const grantEntryStore = deps.contractStore
    ? createContractGrantEntryStore(deps.contractStore)
    : undefined;
  const contractOverlay = contractDefinitionStore
    ? createContractOverlayResolver({
        definitionStore: contractDefinitionStore,
        ...(grantEntryStore ? { grantEntryStore } : {}),
      })
    : undefined;
  // D-187 AMENDMENT 3b — the op-admission gate over the SAME unified grant store +
  // definition store. The engine admit path queries it so the dispatched op's `op`
  // grant entry gates the verb (the owner's AI is gated by the owner contract's op
  // grants; a standing contract's `scope.operation_ids` folds here). Absent store ⇒
  // undefined ⇒ no op gate (additive — the baseline/snapshot decision stands).
  const opAdmissionGate =
    grantEntryStore && contractDefinitionStore
      ? createOpAdmissionGate({
          grantEntryStore,
          definitionStore: contractDefinitionStore,
          // D-188 — inject the master pause flag so a paused server freezes
          // every governed dispatch at this one boundary.
          ...(deps.isServerPaused ? { isPaused: deps.isServerPaused } : {}),
        })
      : undefined;
  // D-196 R2 — one act-time authority resolver over the SAME live stores used
  // by fresh MCP/LLM gateway dispatch. It is composed only when a bearer store
  // exists; daemon-lite/unit compositions without a bearer surface remain
  // byte-identical. The resolver reads every dependency on each resume.
  const approvalResumeAuthority =
    deps.inboundTokenStore || deps.clientTokens
      ? createApprovalResumeAuthorityResolver({
          manifests: deps.executorConfig.manifests,
          ...(deps.inboundTokenStore
            ? { inboundTokenStore: deps.inboundTokenStore }
            : {}),
          ...(deps.clientTokens ? { clientTokens: deps.clientTokens } : {}),
          ...(contractOverlay ? { contractOverlay } : {}),
          ...(deps.sellerCustomerAdmissionStore
            ? { sellerStore: deps.sellerCustomerAdmissionStore }
            : {}),
          ...(opAdmissionGate ? { opAdmissionGate } : {}),
          ...(cliReachableSlugsForPrincipal
            ? { cliReachableSlugsForPrincipal }
            : {}),
          ...(deps.isLlmGatewayRouteReady
            ? { isLlmGatewayRouteReady: deps.isLlmGatewayRouteReady }
            : {}),
        })
      : undefined;

  // D-179 P1 — dish resolution + per-dish continuity on the execute
  // path. Stores are stateless prepared-statement wrappers over the
  // same SQLite tables the `dishes.*` rpc deps use (both creators are
  // CREATE-IF-NOT-EXISTS), so constructing a second handle here keeps
  // this composer free of another threading layer. Absent db ⇒ a
  // `dish_id` on the request fails closed in the execute-handler.
  const dishStore = deps.db ? createDishStore(deps.db) : undefined;
  const dishGroupStore = deps.db ? createDishGroupStore(deps.db) : undefined;
  const dishContextStore = deps.db ? createDishContextStore(deps.db) : undefined;

  // D-181 Slice 2/4/follow-up#2 — one shared closure fans every long-op
  // governor delta onto the D-121 execution bus: the lane semaphore emits the
  // queue-lifecycle ops (`queued` / `slot_acquired`), the registry emits the
  // control + progress ops (`stalled` / `promoted` / `cancelled` / `killed`).
  // A subscribed client reconstructs its active list from an `execution.active`
  // snapshot + these live deltas — no client-side catch-up poll (slice-4
  // follow-up #2 retired the 5b/6c polls). Each caller wraps this in a
  // best-effort `tryEmit`, so a thrown bus emit never blocks a slot or a kill.
  const emitExecutionDelta = (args: {
    recipe_id: string;
    run_id: string;
    op: 'queued' | 'slot_acquired' | 'stalled' | 'promoted' | 'cancelled' | 'killed' | 'retired';
    queued_call_id?: string;
    lane?: ExecutionLane;
  }): void => {
    deps.eventBus.emit({
      kind: 'execution',
      recipe_id: args.recipe_id,
      run_id: args.run_id,
      op: args.op,
      ...(args.queued_call_id !== undefined ? { queued_call_id: args.queued_call_id } : {}),
      ...(args.lane !== undefined ? { lane: args.lane } : {}),
    });
  };

  // D-181 Slice 2 — one two-lane long-op governor for the whole server, sized
  // at boot (local-heavy ≈ cores−1 capped by RAM headroom; external-io generous).
  // The emit hook fans `queued` / `slot_acquired` so a queue change mid-run is
  // live (the `start` delta + the engine `complete`/`error` cover the run edges).
  const laneGovernor = createLaneSemaphore({ emit: emitExecutionDelta });

  // D-181 §10 — the duration-threshold classifier (default-gated): one in-memory
  // per-process singleton. The engine records each successful governed call's
  // duration into it and consults it at `resolveCallClass` to demote a
  // proven-fast op (< 5s) off the lane. Behaviour-neutral until an op has run
  // successfully at least once; a restart re-gates everything (the safe path).
  const opDurationClassifier = createOpDurationClassifier();

  // D-181 slice 4 — the in-flight execution registry over that governor: the
  // live active-list read-model + run-level kill authority. Fed by the
  // execute-handler (run register/complete + abort handle), the semaphore (slot
  // / queue read model), and the cli executor (subprocess SIGKILL handle +
  // stall flag). Its delta-emit fans control/progress transitions onto the same
  // execution bus.
  const inFlightRegistry = createInFlightRegistry(laneGovernor, {
    emit: emitExecutionDelta,
  });
  // The cli executor wired to that registry: a foreground `service` subprocess
  // registers its SIGKILL handle keyed by run so `execution.kill` can reach it.
  // Document-toolkit — when the inbound file collection is present, an op that
  // declares `output_capture` lands its produced file as a `tool_output`
  // data.file and surfaces the record_id as `result.file_ref`.
  const inboundFileCollection = deps.inboundFileCollection;
  const ingestToolOutputFile = inboundFileCollection
    ? async (input: ToolOutputFileIngestInput): Promise<{ record_id: string }> => {
        const record = await inboundFileCollection.ingest({
          src_path: input.src_path,
          content_hash: input.content_hash,
          size_bytes: input.size_bytes,
          filename: input.filename,
          mime_type: input.mime_type,
          origin: 'tool_output',
          source_id: input.source_id,
        });
        return { record_id: record.record_id };
      }
    : undefined;
  // SMB-finance slice 3 — read CAS bytes for a `file_ref` so the cli executor
  // can materialize a docling `source` arg to a temp file (`input_materialize`).
  //
  // D-241 P4 — …and read a MIRRORED vendor file's bytes for the same arg. A
  // `file:remote:*` id is a File Source mirror row whose bytes live at the
  // vendor; `resolveRemoteFileBytes` fetches them through the per-vendor
  // resolver, enforcing `REMOTE_FILE_READ_MAX_BYTES` and returning the same
  // `{ bytes, mime_type, filename }` shape (filename/mime falling back to the
  // mirror `meta`, which is where the extension every converter dispatches on
  // comes from). The two ids are disjoint by construction —
  // `parseRemoteFileRecordId` returns null for a CAS record — so this routes
  // rather than guesses.
  //
  // ⛔ SCOPED TO THE CLI READER ON PURPOSE. `compose-execution-context.ts`
  // builds its OWN `readFileBytes` from the same collection for the D-216
  // `bind.upload` egress path; that one stays CAS-only. Widening it would let a
  // mirrored file from one vendor be uploaded to another, which is a different
  // question from "can a converter read this" — and the chunked path already
  // refuses mirrored files for its own reason (`upload-staging.ts:100`).
  const remoteFileReadDeps = deps.getRemoteFileReadDeps;
  const readFileBytes = inboundFileCollection
    ? async (record_id: string) => {
        if (parseRemoteFileRecordId(record_id) === null) {
          return inboundFileCollection.readBytes(record_id);
        }
        const remote = remoteFileReadDeps?.();
        if (!remote) {
          throw new Error(
            `cli input_materialize: '${record_id}' is a mirrored provider file and no remote byte reader is wired`,
          );
        }
        const { bytes, mime_type, filename } = await resolveRemoteFileBytes(remote, record_id);
        return { bytes, mime_type, filename };
      }
    : undefined;
  const cliInvocationExecutor = createCliInvocationExecutor({
    inFlightRegistry,
    ...(deps.startSupervisedDaemon
      ? { startSupervisedDaemon: deps.startSupervisedDaemon }
      : {}),
    ...(ingestToolOutputFile ? { ingestToolOutputFile } : {}),
    ...(readFileBytes ? { readFileBytes } : {}),
  });
  // SMB-finance slice 3 — land a captured REST download body (a
  // `response_capture` op, storage-gdrive `file.download`) into the CAS as a
  // `connection_download` data.file; the gateway hands base64 bytes here and
  // gets back the record_id it returns as `result.file_ref`.
  const ingestFileDownload = inboundFileCollection
    ? async (input: {
        bytes_b64: string;
        filename: string;
        mime_type: string;
        source_id: string;
        ai_enrichment?: 'opt_out';
      }): Promise<{ record_id: string }> => {
        const record = await inboundFileCollection.ingest({
          bytes: Buffer.from(input.bytes_b64, 'base64'),
          filename: input.filename,
          mime_type: input.mime_type,
          origin: 'connection_download',
          source_id: input.source_id,
          ...(input.ai_enrichment === 'opt_out' ? { ai_enrichment: 'opt_out' as const } : {}),
        });
        return { record_id: record.record_id };
      }
    : undefined;
  // D-217 slice 2b-ii-β2 — the engine's half of a chunked upload is METADATA
  // ONLY: the plaintext size that fixes the request count, and the content hash
  // that pins which bytes that count was computed for. Neither decrypts.
  //
  // ⛔ Staging is deliberately NOT here. It used to be — the engine staged and
  // put the token on the dispatch input — but the action-identity hash covers
  // that input, so a per-attempt token gave every honest repeat a different
  // `canonical_payload_hash` and no D-177 grant could match. `stage` / `dispose`
  // now live with the connection adapter (`compose-execution-context.ts`),
  // below the commit boundary, where the owner's plaintext also stops existing
  // across hashing, admission and any approval hold.
  const describeUploadSource = deps.inboundFileCollection
    ? async (file_ref: string) => {
        const record = deps.inboundFileCollection!.get(file_ref);
        if (record === null) return undefined;
        return {
          size_bytes: record.hot_fields.size,
          content_hash: record.hot_fields.content_hash,
        };
      }
    : undefined;

  const executeDeps: ExecuteHandlerDeps = {
    // D-210 Phase C — the device-fanout branch reads this at each preflight
    // raise. Absent ⇒ every hold raises the actionable ask.
    ...(deps.resolveInboxFanoutMode !== undefined
      ? { resolveInboxFanoutMode: deps.resolveInboxFanoutMode }
      : {}),
    recipeStore: deps.recipeStore,
    ...(deps.recordsStore ? { recordsStore: deps.recordsStore } : {}),
    executorConfig: deps.executorConfig,
    laneGovernor,
    opDurationClassifier,
    inFlightRegistry,
    cliInvocationExecutor,
    ...(ingestFileDownload ? { ingestFileDownload } : {}),
    ...(describeUploadSource ? { describeUploadSource } : {}),
    baseVault: deps.baseVault,
    auditLog: deps.auditLog,
    instanceId: deps.serverInstanceId,
    serverName: deps.serverDisplayName,
    // D-315 slice 7 — the owner's zone as `context.server.time_zone`: the setting
    // when there is one, else the host's, read per run like the housekeeping
    // sweeps read it.
    ...(deps.db ? { ownerTimeZone: ownerTimeZoneOf(deps.db) } : {}),
    sharedStore: deps.sharedStore,
    // D-231 — the owner's curated knowledge behind `{{data.memory.*}}`.
    // ⛔ THREADING THIS IS THE WHOLE FEATURE. The resolver in
    // `execute-handler` is dead code without it, and D-120 Phase 4 shipped
    // exactly that shape — a declared namespace nothing wired — for its entire
    // life. Asserted by `d-231-execute-deps-wiring.test.ts`.
    ...(deps.userMemoryStore ? { userMemoryStore: deps.userMemoryStore } : {}),
    // D-120 Phase 3 — provenance link emission. When db is wired,
    // execute-handler resolves recipe_insights.id pre-run, buffers
    // EmittedLinks via the engine's linkSink, and writes them to the
    // links table after the audit row is appended. Daemon-only mode
    // (db undefined) skips emission entirely.
    ...(deps.db ? { db: deps.db } : {}),
    // D-234 § 234.1 — where an answered peer-admission ask is recorded, and where
    // the ceiling CLAIMS it on the peer's next call. ⛔ Absent DENIES rather than
    // admits: an `ask` ceiling with nowhere to read a decision from can only
    // refuse, which is the safe direction — an unwired host must never downgrade
    // "ask me" into "let them in". Wired wherever `db` is, i.e. everywhere but
    // the dbless harnesses.
    ...(deps.db ? { peerAdmissionStore: createPeerAdmissionStore(deps.db) } : {}),
    // D-234 § 234.3 — forwarded, not rebuilt: the composition root owns the one
    // public-base-URL decision (same rule as `askAnswerLink` above), so a
    // deployment can never link from one surface and not the other.
    ...(deps.ownerSurfaceLink !== undefined
      ? { ownerSurfaceLink: deps.ownerSurfaceLink }
      : {}),
    // D-121 Phase 6 — execution lifecycle + memory event broadcast.
    // Bus emits are best-effort; absent → no realtime events but
    // engine + audit log behavior unchanged.
    eventBus: deps.eventBus,
    // D-179 P4 — run-outcome bus events (emit-only handle).
    ...(deps.warehouseBus ? { warehouseBus: deps.warehouseBus } : {}),
    // D-125 P6.2 — `enrichment-or-fetch` reads through the warehouse
    // before falling through to fetch. Absent store ⇒ transform returns
    // `source: 'no_runtime'` (recipe falls back gracefully).
    ...(deps.enrichmentStore ? { enrichmentStore: deps.enrichmentStore } : {}),
    // D-172 P2 / D-177 rule-1 follow-on — the annotation/link store,
    // forwarded so the engine's per-record annotation prefetch
    // (`{{data.<col>.<id>.annotations.<key>}}`) actually has a resolver
    // on the daemon + mcp paths (previously only the notification block
    // consumed this input — the executeDeps field stayed unset), and so
    // the D-177 stored-cleanliness gate can read annotation row facets.
    ...(deps.annotationStore ? { annotationStore: deps.annotationStore } : {}),
    // D-177 N.11 rule 1 — contact store for the per-row
    // stored-cleanliness gate (dotted-email record resolution). Absent ⇒
    // contact-record roots stay tainted-pinned.
    ...(deps.contactStore ? { contactStore: deps.contactStore } : {}),
    // D-179 P1 — standing-dish resolution (overlay + audit attribution)
    // + per-dish `context.recipe` continuity snapshots.
    ...(dishStore ? { dishStore } : {}),
    // D-179 P3 — group overlay inheritance (dish → group → install →
    // defaults).
    ...(dishGroupStore ? { dishGroupStore } : {}),
    ...(dishContextStore ? { dishContextStore } : {}),
    // D-145 engine-wiring slice 3b.1 — the D-153 commit store, threaded
    // INERT. The Gateway dispatch-outbox (slice 3b.3) is the writer; the
    // dep is plumbed now so 3b.3 is a wiring-only change. Absent (no db)
    // ⇒ no commit log, exactly as today.
    ...(deps.commitStore ? { commitStore: deps.commitStore } : {}),
    // D-157 P1 slice 3 — the preflight checkpoint store. `execute-handler`
    // mints + writes a `Checkpoint` when the engine returns
    // `awaiting_approval`. Absent (no db) ⇒ a paused run is reported in
    // the response but no checkpoint persists — the run cannot resume.
    ...(deps.checkpointStore ? { checkpointStore: deps.checkpointStore } : {}),
    // D-234 § 234.4 return leg — the asker's open-conversation record. Written as
    // a peer ask goes out; read (and closed) when the answer comes back, and it
    // carries the OFFERED option set the inbound answer is validated against.
    // Absent (dbless) ⇒ questions still go and their answers refuse as
    // unsolicited, which is where an undelivered ask already leaves the hold.
    ...(peerAskOutbox ? { peerAskOutbox } : {}),
    ...(deps.mcpActionStore ? { mcpActionStore: deps.mcpActionStore } : {}),
    ...(deps.gatedActionStore ? { gatedActionStore: deps.gatedActionStore } : {}),
    // D-157 server-wiring — the D-158 notification block, threaded as
    // the preflight notifier. `execute-handler` calls `raisePreflightAsk`
    // on this dep when the engine pauses on a policy `ask`; the
    // returned `ask_id` is pinned to the `awaiting_approval` audit
    // anchor. Absent (block not wired — db / auditLog / checkpointStore
    // / annotationStore missing) ⇒ paused runs persist a durable
    // checkpoint but no user-facing ask fires; the boot sweep re-raise
    // on the next start surfaces them once the block becomes available.
    ...(notificationBlock ? { preflightNotifier: notificationBlock } : {}),
    // R2 step 6 — the same block, threaded as the torn-saga notifier.
    // `execute-handler` raises ONE `gateway.saga` ask when a run
    // terminal-fails after ≥1 catalog write landed. Absent ⇒ no saga
    // detection runs (the commit log still records the torn state).
    ...(notificationBlock ? { sagaNotifier: notificationBlock } : {}),
    // D-157 A.1 step 1, runtime half — the same block, threaded to the commit
    // Gateway so a dispatch that settles `in_doubt` asks the owner NOW. The
    // boot sweep only ever saw non-terminal rows, so a runtime `in_doubt` was
    // never surfaced; the torn-saga ask promised otherwise. Absent ⇒ the older
    // behaviour (durable `in_doubt` commit, no ask).
    ...(notificationBlock ? { inDoubtNotifier: notificationBlock } : {}),
    // Doc §4 close-out — the same block, threaded as the >1-provider
    // pick notifier. `execute-handler` raises ONE `gateway.pick` ask
    // when an interactive run arrives with an unbound connection slot
    // that several enrolled connections can serve. Absent ⇒ the typed
    // `connection_pick_required` error alone carries the candidates.
    ...(notificationBlock ? { pickNotifier: notificationBlock } : {}),
    // D-192 Slice 6b — the same block, threaded as the container-pick notifier.
    // `execute-handler` raises ONE `work_entity.container_pick` ask when a
    // work-entity create fails on an ambiguous vendor container (Linear `team`,
    // an Asana `workspace`). Absent ⇒ the `container_pick_required` result alone
    // carries the choice set (no ask raised).
    ...(notificationBlock ? { containerPickNotifier: notificationBlock } : {}),
    // D-192 Slice 6c — the same block, threaded as the create-plan notifier.
    // `execute-handler` raises ONE `work_entity.create_plan` confirm when a work-
    // entity create decides to create a named container that doesn't exist yet.
    // Absent ⇒ the `create_plan_required` result alone carries the plan (no ask).
    ...(notificationBlock ? { createPlanNotifier: notificationBlock } : {}),
    // D-165 P0/P1 — per-connection operation-profile store (LOCAL-ONLY):
    // the caller's seeded store, or an empty fallback (resolved above).
    connectionOperationProfiles,
    // D-182 §7.2 — the cli reachability resolver (the AUTHORITATIVE cli
    // authorization source; built at the boot layer). Omitted when not provided
    // ⇒ cli ops fail closed `cli_reachability_disabled` (reachability defaults OFF).
    ...(deps.cliReachabilityResolver
      ? { cliReachabilityResolver: deps.cliReachabilityResolver }
      : {}),
    // D-182 §8 door-cli authorization path — the per-principal cli-reachable-slug
    // lister (built above from the same contract store). Consumed only by the MCP
    // snapshot builder. Omitted (no contract store) ⇒ no cli union in the snapshot.
    ...(cliReachableSlugsForPrincipal ? { cliReachableSlugsForPrincipal } : {}),
    // D-165 P3.path-picker (Slice 3b) — connection-RECORD store, threaded so
    // the gateway can resolve a connection's `subresource_path` and enforce a
    // catalog operation's `path_scope`. Same handle the channel probes consult
    // (above); absent (dbless) ⇒ path scope inert (whole-account `/`).
    ...(deps.connectionStore ? { connectionStore: deps.connectionStore } : {}),
    // D-182 §10 step 8 / R1 (Fix 2) — installed-manifest store forwarded so the
    // run-path R1 pre-pass binds pack-composition CRM/acct vendors. Absent ⇒
    // built-in HubSpot/Salesforce registry only (the fail-safe).
    ...(deps.localManifestStore ? { localManifestStore: deps.localManifestStore } : {}),
    // D-166 Slice 4d.4 — the `contract.*` override-scan seam (resolved above).
    // Omitted when no contract store was provided ⇒ override layer skipped.
    ...(contractScan ? { contractScan } : {}),
    // D-166 contract_definition — the use-resolution overlay resolver (resolved
    // above). Omitted when no contract store ⇒ the policy gates see no
    // `.<contract_id>` overlay (baseline+snapshot only — additive).
    ...(contractOverlay ? { contractOverlay } : {}),
    // D-196 — raw-op approvals can resume long after the original MCP request,
    // so carry the seller admission store for a fresh customer status/grace check.
    ...(deps.sellerCustomerAdmissionStore
      ? { sellerCustomerAdmissionStore: deps.sellerCustomerAdmissionStore }
      : {}),
    ...(approvalResumeAuthority ? { approvalResumeAuthority } : {}),
    ...(opAdmissionGate ? { opAdmissionGate } : {}),
    // D-177 P2 — the session-grant resolver (resolved above). Omitted when no
    // contract store ⇒ the Gateway runs no grant lookup; every `ask` holds.
    ...(sessionGrantResolver ? { sessionGrantResolver } : {}),
    // D-202 task 4a — the quality-delegation resolver (resolved above). Omitted
    // when no contract store / no switch reader ⇒ the Gateway runs no quality
    // lookup; every `ask` holds exactly as pre-D-202.
    ...(qualityGateResolver ? { qualityGateResolver } : {}),
    // D-177 N.11 rule 5 (slice D) — the forwarded-sender candidate lookup
    // for the gateway's `'scoped'` grant containment. Omitted when no chat
    // surface supplies an index ⇒ scoped grants never match (fail closed).
    ...(deps.scopedSenderCandidates
      ? { scopedSenderCandidates: deps.scopedSenderCandidates }
      : {}),
    // D-177 P5a — the batch-approval coordinator (composed with the
    // notification block above). Omitted when the block is unwired ⇒
    // every hold raises today's per-hold ask.
    ...(batchApprovals ? { batchApprovals } : {}),
  };

  return {
    executeDeps,
    notificationBlock,
    getBatch,
    reconcileOpenBatch,
    preflightResumer,
    inFlightRegistry,
    contractDefinitionStore,
    grantEntryStore,
  };
};
