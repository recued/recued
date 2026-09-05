/** D-157 server-wiring — boot composer for the D-158 notification block.
 *
 *  The block is the single user-surface seam shared by the gateway's
 *  two human-decision flows (`gateway.preflight` § A.2 and
 *  `gateway.in_doubt` § A.1). Composition needs four pieces from the
 *  surrounding server: `db` (SQLite collections), `auditLog` (paused-
 *  anchor lookup), `checkpointStore` (resume payload load), and the
 *  annotation store (in-doubt reconciliation writer). The UI channel
 *  adapts each `UiNotificationEvent` onto the D-121 broadcast bus so
 *  every paired client receives the `notification.notify` /
 *  `notification.ask` / `notification.ask_closed` events.
 *
 *  Three exports:
 *    - `composeNotificationBlock` — construct the block + the
 *      preflight resumer, register both gateway handlers, return both.
 *    - `recoverNotificationBlockAtBoot` — best-effort
 *      `recoverPendingAsks` + `sweepAwaitingCheckpoints`. Runs
 *      BEFORE the commit-store crash recovery so the bus replay reaches
 *      paired clients ahead of any new event (codex MAJOR 4 fold).
 *    - `raiseInDoubtForSweptCommits` — best-effort `raiseInDoubtAsks`
 *      for the commits the commit-substrate sweep marked `in_doubt`
 *      at boot. Runs AFTER `commitStore.sweepPendingToInDoubt()`.
 */

import type Database from 'better-sqlite3';
import type {
  BatchAskRecord,
  Checkpoint,
  Commit,
  PreflightOverrideOffer,
} from '@recued/contracts';
import type { PreflightRunSettled } from '../../preflight-resumer.js';
import { createBatchAskStore } from '@recued/storage';
import type { ActivityAction, ActivityEntry, AuditLogStore, CheckpointStore } from '@recued/storage';
import {
  createAskStore,
  createBridgeChannel,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type BridgeSink,
  type Channel,
  type ChannelName,
  type ChannelReadinessProbe,
  type NotificationBlock,
  type AnswerAuditRecord,
  type NotificationSettings,
  type PendingAsk,
  type RemoteChannel,
} from '@recued/notification';
import {
  NEVER_ASK_OPERATION_OPTION_ID,
  RELAX_OPERATION_TO_ASK_OPTION_ID,
  raiseInDoubtAsks,
  registerInDoubtHandler,
  registerPreflightHandler,
  type PreflightAskContext,
  type PreflightResumer,
} from '@recued/gateway';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { EventBus } from '../../events/bus.js';
import { createSQLiteCollection } from '../../sqlite-collection.js';
import type { AnnotationStore } from '../../storage/annotation-store.js';
import type { ClientTokenStore } from '../../pairing/client-tokens.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import { createPreflightResumer } from '../../preflight-resumer.js';
import {
  createBatchApprovalCoordinator,
  type BatchApprovalCoordinator,
} from '../../batch-approval.js';
import type { SessionGrantResolver } from '../../session-grant-resolver.js';
import type { QualityDelegationSignalStore } from '../../storage/quality-delegation-signal-store.js';
import type { McpActionStore } from '../../mcp-action-store.js';
import {
  reconcileInterruptedGatedActionsAtBoot,
  type GatedActionRecord,
  type GatedActionStore,
} from '../../gated-action-store.js';
import { createInDoubtAnnotationWriter } from '../../in-doubt-annotation-writer.js';
import { registerSagaReconciliation } from '../../saga-server-wiring.js';
import { registerPickResolution } from '../../pick-server-wiring.js';
import { registerContainerPickResolution } from '../../work-entity-container-pick-wiring.js';
import { registerPeerAdmissionHandler } from '../../peer-admission-ask.js';
import { registerPeerAnswerHandler } from '../../peer-answer-return.js';
import { PEER_ASK_HANDLER_KIND } from '../../peer-ask-receiver.js';
import { createPeerAskInboxStore } from '../../storage/peer-ask-inbox-store.js';
import { PEER_RECEIVE_ANSWER_TOOL } from '../../peer-receive-ask-recipe.js';
import { createPeerAdmissionStore } from '../../storage/peer-admission-store.js';
import { registerCreatePlanResolution } from '../../work-entity-create-plan-wiring.js';
import type { WorkEntitySourceWriteExecutor } from '../../work-entity-write-executor.js';
import { createSourceDependencyEntityStore } from '../../storage/source-dependency-entity-store.js';
import {
  sweepAwaitingCheckpoints,
  type PreflightBootSweepDeps,
} from '../../preflight-boot-sweep.js';
import type { ReceptionInboxFanoutMode } from '@recued/contracts';

/** Dependencies the notification-block composition needs. All five are
 *  required — the caller (`bin.ts`) gates entry on the four runtime
 *  prerequisites (`db`, `auditLog`, `checkpointStore`,
 *  `annotationStore`) being defined before calling in. */
export interface ComposeNotificationBlockDeps {
  /** D-137 — late-bound chat sink for a run that settled after its turn.
   *  Absent ⇒ late results are not recallable, the behaviour before this. */
  readonly getRunSettledSink?: () => ((settled: PreflightRunSettled) => void) | undefined;
  /** D-210 A.8 slice 3d — builds `/ask/<ask_id>` for `inline` channel asks.
   *  Resolved once in `compose-execution-context` (the only place the public
   *  base URL is in scope) and shared with the email channel. Absent on a
   *  non-public deployment → text-only asks, unchanged. */
  askAnswerLink?: (ask_id: string) => string;
  db: Database.Database;
  auditLog: AuditLogStore;
  checkpointStore: CheckpointStore;
  mcpActionStore?: McpActionStore;
  gatedActionStore?: GatedActionStore;
  preserveClaimedDispatch?: (
    record: GatedActionRecord,
  ) => boolean | Promise<boolean>;
  annotationStore: AnnotationStore;
  eventBus: EventBus;
  /** Lazy accessor for `executeDeps`. Construction runs BEFORE
   *  `executeDeps` exists (the block threads as
   *  `executeDeps.preflightNotifier`, so the block must precede
   *  executeDeps in boot order). The thunk only dereferences when an
   *  answer fires, well after `executeDepsRef = executeDeps` runs. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** Durable pre-resume effects shared by single + batch approval. The hook
   * runs before the host re-instantiates an approved operation; throwing keeps
   * the checkpoint for answered-ask boot recovery and prevents downstream
   * execution. Reception uses this to promote an accepted intake form into
   * canonical `form_response` before any optional workflow continues. */
  beforePreflightResume?: (
    checkpoint: Checkpoint,
    context: PreflightAskContext,
  ) => Promise<void>;
  /** D-211 — authoritative standing-ruling writer for preflight affordances. */
  upsertOverride?: (offer: PreflightOverrideOffer) => Promise<void>;
  /** D-192 Slice 6c — lazy accessor for the boot-singleton work-entity write
   *  executor (populated post-listener; `null` at compose time). The create-plan
   *  answer dispatcher derefs it at ANSWER time to run `executeCreatePlan`. */
  getWriteExecutor?: () => WorkEntitySourceWriteExecutor | null;
  /** D-163 N.5 — credential-backed readiness probe source for the
   *  `slack` / `telegram` / `email` channels. The probe consults
   *  `connectionStore.get('notification', channel)` so a toggled-on
   *  channel without an enrolled `connection.notification.*` record
   *  reads `ready: false` in `describeNotificationChannels()` and the
   *  block's `setChannel(enabled: true)` returns `not_ready`. Absent
   *  (daemon-only / dbless harness) ⇒ those rows surface `not_ready`
   *  by default, which matches the spec's fail-closed posture. */
  connectionStore?: ConnectionStoreSqlite;
  /** D-163 N.5 — pair-presence-backed readiness probe source for the
   *  `bridge` channel. Lifted from `composeClientSecurityContext` to
   *  `composeAppContext` (D-163 Slice B) so the probe consults the
   *  same SQLite-backed rows the cert-stack rotates: the store is
   *  stateless and two handles over the same `db` are equivalent.
   *  The probe counts active `client_kind: 'bridge'` rows — they
   *  persist across the Bridge's offline windows, which is the right
   *  "you've installed Bridge before, so let the toggle be live"
   *  semantic per spec § N.5. Absent ⇒ Bridge row reads `not_ready`,
   *  matching the install-CTA posture. */
  clientTokens?: ClientTokenStore;
  /** D-163 § A.3 — host-injected sink the Bridge channel uses to
   *  dispatch OS notifications through a paired Browser Bridge.
   *  Absent ⇒ the Bridge channel's `deliverNotify` becomes a silent
   *  no-op (the channel still constructs so Settings can render the
   *  "Install Browser Bridge" row; the readiness probe gates user-
   *  side toggling separately). A future slice wires the production
   *  sink once the `BridgeCommand` transport reaches `ws-server`. */
  bridgeSink?: BridgeSink;
  /** D-192 CORE #6 seam 7 (Group D) — the `vendor → RemoteChannel` messenger
   *  registry (capability: 'inline'; slack / telegram / …). Built ONCE by
   *  `buildMessengerRemoteChannels` in `compose-execution-context` from the same
   *  `connectionStore` the probe consults, so each adapter and its credential row
   *  stay in lock-step; `Object.values()` fold into `allChannels`. A vendor
   *  absent from the map (or an empty / absent registry) stays out of the fan-out
   *  set and the probe's `hasAdapter(<vendor>)` gate keeps its Settings row
   *  `not_ready` even when a `connection.notification.<vendor>` credential is
   *  enrolled (Slice B fail-closed posture). The block's `ChannelSelector`
   *  plumbing routes by `Channel.name`, so wiring an adapter is a strict-additive
   *  capability flip — no behavioral change for `bridge` / `ui`. Replaces the
   *  per-vendor `slackChannel` / `telegramChannel`. */
  messengerChannels?: Record<string, RemoteChannel>;
  /** D-158 P2b — pre-built email `Channel` (capability: 'landing-page').
   *  Built by `composeEmailChannel` against the same `connectionStore`
   *  the probe consults, so the adapter and the
   *  `connection.notification.email` credential stay in lock-step.
   *  Unlike Slack / Telegram it is NOT a `RemoteChannel` (email is not
   *  transport-backed — it rides the BYO mail account via `mailRpc`).
   *  Absent ⇒ email stays out of the fan-out set and the probe's
   *  `hasAdapter('email')` gate keeps the Settings row `not_ready` even
   *  when a `connection.notification.email` credential is enrolled.
   *  Strict-additive capability flip — no behavioral change for the
   *  other channels. */
  emailChannel?: Channel;
  /** D-169 P1 — optional snapshot of currently-connected bridge
   *  `client_token_id`s, used to tag each per-bridge sub-row in
   *  Settings → Notifications with a live presence flag (N.6 UX —
   *  "Bridge1 Chrome on macOS — Offline since 5m ago"). Absent ⇒ every
   *  row reads `connected: false` and the surface degrades to the
   *  durable-only view (still functional, just without the presence
   *  hint). The composer pulls the Set from the ws-server's per-tick
   *  roster snapshot via the thunk pattern so this composer runs
   *  before the WS server's handle exists. */
  getConnectedBridgeTokenIds?: () => Set<string>;
  /** D-177 P5a — the session-grant resolver (built by the caller over the
   *  contract-definition store). The batch-approval coordinator mints the
   *  `grant_mode: 'batch'` grant from an answered snapshot through it.
   *  Optional: absent ⇒ batch approves degrade to plain marker resumes
   *  (the approved actions still execute; only the member-claim replay
   *  absorption is dropped). */
  sessionGrantResolver?: SessionGrantResolver;
  /** D-202 Slice 1b — the durable quality VERDICT store (built by the caller
   *  over the contract store). Threaded to the host resumer so a resolved
   *  QUALITY-relevant ask records one `QualityDelegationSignal` (approve →
   *  `quality_good`, deny → `quality_bad`) for the reject-driven learner.
   *  Optional: absent (no contract store — dbless) ⇒ no signal is recorded and
   *  the approve/deny path is byte-identical to pre-1b. */
  qualityDelegationSignalStore?: QualityDelegationSignalStore;
}

/** Result of composition. `bin.ts` retains both handles — the block
 *  threads onto `executeDeps.preflightNotifier`; the resumer is held
 *  for symmetry with the gateway's deny-side contract. D-177 P5a adds
 *  the batch-approval coordinator — its `registerHold` half threads as
 *  `executeDeps.batchApprovals`; its answer hooks are already registered
 *  on the `gateway.preflight` handler here. */
export interface NotificationBlockBundle {
  block: NotificationBlock;
  resumer: PreflightResumer;
  batchApprovals: BatchApprovalCoordinator;
  /** Narrow LIVE read of a batch row's membership — the `/ask` landing needs
   *  to know whether a batch-registered ask covers ONE member or many before
   *  it may render that member's values as the approval.
   *
   *  ⛔ A reader, not the store: nothing outside this bundle may mutate a
   *  batch row, and a caller that only needs the count must not be handed
   *  `close` / `create` to reach it. Read at render time because an `open`
   *  batch accumulates members. */
  getBatch: (
    batch_id: string,
  ) => Promise<Pick<BatchAskRecord,
    'state' | 'current_ask_id' | 'members' | 'answer_option'> | null>;
  reconcileOpenBatch: BatchApprovalCoordinator['reconcileOpenBatch'];
}

/** Decorate the one host resumer used by both the legacy single-checkpoint
 * answer handler and the batch coordinator. Keeping the hook here avoids a
 * surface-specific approval path: Inbox, global approvals, batch approval,
 * and boot recovery all run the same durable pre-resume effects. */
/** D-210 — project an answered ask into its durable `ActivityEntry`.
 *
 *  🔴 Until this existed, an APPROVE wrote no approval audit row at all:
 *  `createPreflightAnswerHandler` writes none, deny got only a failed run
 *  anchor, and `approval_allow` / `approval_deny` were declared
 *  `ActivityAction` codes WITH labels and ZERO writers. The run anchor's
 *  `ask_id` back-pointer does not survive either — `auditLog.append` is
 *  `set(run_id, …)`, so resuming the run OVERWRITES the awaiting row that
 *  carried it. Nothing referenced an ask once it went terminal.
 *
 *  ⛔ THIS IS THE PRECONDITION FOR PRUNING TERMINAL ASKS. `ActivityEntry` is
 *  append-only and keyed on `activity_id` (unlike the run-keyed anchor), and
 *  both actions are reserve-class, so the row outlives both the ask row and
 *  normal retention.
 *
 *  Pure + exported so the action mapping is testable without booting a
 *  block: "which code does this option mean" is a claim, not plumbing. */
/** FN-2 — pull the join keys off the ask's own payload.
 *
 *  The host may read this shape; the notification leaf may not (see
 *  `AnswerAuditRecord.handler_payload`). Every field is optional on BOTH
 *  sides: a `gateway.preflight` payload carries `run_id` + `checkpoint_id`
 *  always, then EITHER `recipe_id` + `gated_step_id` (a recipe-bound hold)
 *  OR `raw_op_id` (a recipe-less raw-op door hold) — the checkpoint guard
 *  enforces that partition, so reading both and emitting what is present is
 *  correct for either. A non-preflight ask kind carries none of them and
 *  yields an entry identical to the pre-FN-2 one.
 *
 *  ⚠ Reads defensively rather than casting: the payload is
 *  `Record<string, unknown>` by contract and a pack may register any ask
 *  kind with any shape, so a non-string under a key we know is silently
 *  ignored instead of being written into the ledger as a wrong join key. */
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export const answerActivitySubject = (
  payload: Record<string, unknown> | undefined,
): Pick<ActivityEntry, 'run_id' | 'recipe_id' | 'step_id' | 'operation_id'> => {
  if (payload === undefined) return {};
  const run_id = str(payload.run_id);
  const recipe_id = str(payload.recipe_id);
  const step_id = str(payload.gated_step_id);
  // A raw-op hold names the op directly; a recipe-bound hold names the
  // ingredient the gated dispatch targeted. Either is the operation this
  // decision was about, and they are mutually exclusive by construction.
  const operation_id = str(payload.raw_op_id) ?? str(payload.tool_slug);
  return {
    ...(run_id !== undefined ? { run_id } : {}),
    ...(recipe_id !== undefined ? { recipe_id } : {}),
    ...(step_id !== undefined ? { step_id } : {}),
    ...(operation_id !== undefined ? { operation_id } : {}),
  };
};

export const buildAnswerActivity = (record: AnswerAuditRecord): ActivityEntry => ({
  // `(answered_at, ask_id)` is unique by construction — the block calls this
  // once per ask, inside the once-only `open → answered` dedup window.
  activity_id: `notification.answered-${record.answered_at}-${record.ask_id}`,
  timestamp: record.answered_at,
  action: answerAuditAction(record.option),
  target: record.ask_id,
  ...answerActivitySubject(record.handler_payload),
  // Structured beside the prose: the channel that carried the winning answer
  // was previously recoverable only by parsing `detail`.
  answered_via: record.answered_via,
  detail:
    `${record.title ?? record.handler_kind}`
    + ` — answered '${record.option_label}' (${record.option})`
    + ` via ${record.answered_via}`,
});

/** Map an answered option id to its activity code.
 *
 *  ⛔ Deliberately NOT `option === 'deny' ? deny : allow`. The block audits
 *  EVERY ask kind, not just `gateway.preflight`, and a non-preflight ask's
 *  options are arbitrary pack strings — reading an unknown option as
 *  `approval_allow` would record consent the user never expressed. Only the
 *  two known affirmative ids map to allow; everything else, including any
 *  unrecognised option, records as `approval_deny`, which is the safe
 *  direction for a record of what someone agreed to.
 *  ⚠ The detail line always carries the RAW option, so an unusual answer is
 *  never misread as a plain denial by a human reading the row. */
const answerAuditAction = (option: string): ActivityAction =>
  option === 'approve'
  || option === 'allow_session'
  || option === NEVER_ASK_OPERATION_OPTION_ID
  || option === RELAX_OPERATION_TO_ASK_OPTION_ID
    ? 'approval_allow'
    : 'approval_deny';

export const withBeforePreflightResume = (
  resumer: PreflightResumer,
  beforePreflightResume: ((
    checkpoint: Checkpoint,
    context: PreflightAskContext,
  ) => Promise<void>) | undefined,
): PreflightResumer => {
  if (beforePreflightResume === undefined) return resumer;
  return {
    async resumeRun(checkpoint, context) {
      await beforePreflightResume(checkpoint, context);
      await resumer.resumeRun(checkpoint, context);
    },
    denyRun: (checkpoint, context) => resumer.denyRun(checkpoint, context),
  };
};

/** Compose the notification block + its UI channel + the preflight
 *  resumer + the in-doubt annotation writer; register both gateway
 *  handlers on the block. Returns the block + the resumer for the
 *  caller to retain.
 *
 *  The UI channel's `busSink` swallows `eventBus.emit` failures by
 *  design (D-158 I-2 / TR-10): the ask stays durably `open` in the
 *  AskStore and the boot sweep re-fans on next start, so a transient
 *  bus failure should not back-propagate through `notify` / `ask`. */
export const composeNotificationBlock = (
  deps: ComposeNotificationBlockDeps,
): NotificationBlockBundle => {
  const {
    db,
    auditLog,
    checkpointStore,
    annotationStore,
    eventBus,
    getExecuteDeps,
    connectionStore,
    clientTokens,
    bridgeSink,
    messengerChannels,
    emailChannel,
  } = deps;

  const askStore = createAskStore(
    (() => {
      const asks = createSQLiteCollection<PendingAsk>(db, 'pending_asks');
      // Without these the store's field queries are still correct but still
      // scan — SQLite needs an expression index over the SAME
      // `json_extract(data, '$.<field>')` text the query emits.
      asks.ensureFieldIndexes(['status', 'created_at']);
      return asks;
    })(),
  );
  const settingsStore = createNotificationSettingsStore(
    createSQLiteCollection<NotificationSettings>(db, 'notification_settings'),
  );

  const uiChannel = createUiChannel({
    busSink: (event) => {
      try {
        switch (event.kind) {
          case 'notification.notify':
            eventBus.emit({
              kind: 'notification.notify',
              ...(event.message.title !== undefined
                ? { title: event.message.title }
                : {}),
              text: event.message.text,
            });
            // D-169 P2 — persist the fired notification as a
            // `notification_fired` activity row so the bridge side panel
            // section #3 (N.5 #3) historical view (`notification.recent`)
            // survives a server restart; notify is otherwise bus-only /
            // ephemeral. Best-effort (fire-and-forget, matching `notify`'s
            // contract — D-158 I-2 / TR-10): an async logActivity failure
            // must not back-propagate through the user's `notify` call, so
            // the rejection is caught (the surrounding `try` only guards
            // the synchronous dispatch).
            void auditLog
              .logActivity({
                activity_id: '',
                timestamp: Date.now(),
                action: 'notification_fired',
                target: '',
                detail: JSON.stringify({
                  ...(event.message.title !== undefined
                    ? { title: event.message.title }
                    : {}),
                  text: event.message.text,
                  ...(event.message.link_url !== undefined
                    ? { link_url: event.message.link_url }
                    : {}),
                }),
              })
              .catch(() => {
                /* best-effort — see module doc (D-158 I-2 / TR-10) */
              });
            return;
          case 'notification.ask':
            eventBus.emit({
              kind: 'notification.ask',
              ask_id: event.ask_id,
              ...(event.message.title !== undefined
                ? { title: event.message.title }
                : {}),
              text: event.message.text,
              options: event.options.map((o) => ({
                id: o.id,
                label: o.label,
              })),
              // D-234 § 234.3 / § 234.4e — TWO more fields on an enumerating
              // copier. This literal is the bus frame; a field it does not name
              // never reaches any live card. `link_url` had been missing here
              // since § 234.3, so a live ask's "read it here" affordance
              // appeared only after the next history re-fetch.
              ...(event.message.link_url !== undefined
                ? { link_url: event.message.link_url }
                : {}),
              ...(event.note_prompt !== undefined
                ? { note_prompt: event.note_prompt }
                : {}),
              ...(event.body !== undefined ? { body: event.body } : {}),
            });
            return;
          case 'notification.ask_closed':
            eventBus.emit({
              kind: 'notification.ask_closed',
              ask_id: event.ask_id,
            });
            return;
        }
      } catch {
        // Best-effort by D-158 I-2 / TR-10 — see module doc.
      }
    },
  });

  // D-163 N.4 — Bridge as a discrete `'notify-only'` channel. The
  // adapter constructs whether or not `bridgeSink` is wired so Settings
  // can always render the "Install Browser Bridge" row + the toggle is
  // available once the readiness probe flips true. Absent sink ⇒
  // `deliverNotify` becomes a silent no-op; the block's I-2 filter keeps
  // `deliverAsk` from ever reaching this adapter, and the passive notify
  // on ask raise (I-3) reduces to a no-op until the production sink is
  // wired in a follow-on slice.
  const bridgeChannel = createBridgeChannel({
    bridgeSink: bridgeSink ?? (() => {
      // No-op fallback. The channel is still registered so
      // `describeNotificationChannels()` shows the Bridge row; the
      // readiness probe gates user-facing toggling separately.
    }),
  });

  // The D-163 channel array. Slice B wired `ui` + `bridge`; D-192 CORE #6
  // seam 7 folds in the whole messenger registry (`slack` / `telegram` / … via
  // `Object.values`) in place of the old per-vendor `slack` + `telegram`
  // spreads; D-158 P2b adds `email` (OUTBOUND). The probe's adapter-presence
  // gate (`allChannels.some(...)`) is structural — a
  // `connection.notification.<vendor>` credential alone never reads `ready`
  // until the matching adapter lands in `allChannels`, so toggling a channel
  // whose `deliverAsk` / `deliverNotify` would silently drop stays impossible by
  // construction.
  const allChannels: readonly Channel[] = [
    uiChannel,
    bridgeChannel,
    ...Object.values(messengerChannels ?? {}),
    ...(emailChannel ? [emailChannel] : []),
  ];
  const hasAdapter = (name: ChannelName): boolean =>
    allChannels.some((c) => c.name === name);

  // D-163 N.5 — single `ChannelReadinessProbe` seam, generalised over
  // credential-backed channels (`connection.notification.*` lookups) AND
  // pair-presence-backed channels (the `client_tokens` table for Bridge).
  // `'ui'` is structurally always-on per D-158 N.4. Every backing is
  // optional — when an accessor is absent or returns undefined, OR when the
  // channel's adapter has not been wired yet, the corresponding row reads
  // `not_ready`, matching the spec's fail-closed posture: the user cannot
  // toggle a channel on whose adapter + backing are not both wired.
  //
  // D-192 seam 10 — the former `case 'slack' | 'telegram' | 'email'` arms ran
  // IDENTICAL logic, so they were never per-vendor knowledge, just an
  // enumeration. They collapse into the credential-backed default: every
  // channel that is neither `ui` nor `bridge` is backed by a
  // `connection.notification.<channel>` row, chat transport or not. A newly
  // declared transport is probed correctly here with no edit — and, because the
  // default is fail-closed, an unwired one reads `not_ready` rather than
  // silently reading ready.
  const readinessProbe: ChannelReadinessProbe = async (
    channel: ChannelName,
  ): Promise<boolean> => {
    if (channel === 'ui') return true;
    if (channel === 'bridge') {
      if (!hasAdapter('bridge')) return false;
      if (!clientTokens) return false;
      return clientTokens.list({ client_kind: 'bridge' }).length > 0;
    }
    if (!hasAdapter(channel)) return false;
    if (!connectionStore) return false;
    return connectionStore.get('notification', channel) !== null;
  };

  // D-169 P1 — per-bridge roster for Settings → Notifications. The
  // bridge channel section renders one sub-row per paired bridge,
  // each carrying its independent notification + approval mode
  // toggles (N.6). The probe joins `client_tokens` (kind = 'bridge',
  // non-revoked) with the live WS-roster presence set; absent
  // `clientTokens` (dbless harness) → `[]`, and the Settings UI shows
  // the channel-level toggle only.
  //
  // The `connected` flag is a presence-snapshot hint, not a routing
  // gate — D-169 P2 wires the routing decision separately via the
  // per-ask roster lookup (TR-12). P1 surfaces presence through the
  // optional `getConnectedBridgeTokenIds` thunk; when absent the row
  // reads `connected: false` and the Settings UI renders "Offline"
  // copy without breaking the row contract.
  const bridgeRosterProbe = async () => {
    if (!clientTokens) return [];
    const tokens = clientTokens.list({
      client_kind: 'bridge',
      include_revoked: false,
    });
    const connectedSet = deps.getConnectedBridgeTokenIds
      ? deps.getConnectedBridgeTokenIds()
      : new Set<string>();
    return tokens.map((t) => {
      const out: {
        client_token_id: string;
        label: string;
        added_at?: number;
        connected: boolean;
      } = {
        client_token_id: t.token_id,
        label: t.client_label ?? `Bridge (${t.token_id.slice(0, 8)})`,
        connected: connectedSet.has(t.token_id),
      };
      // `issued_at` is Unix-ms in the durable row; the wire-shape
      // expects Unix-seconds (matches `pair.list`'s `added_at`
      // convention). Floor + check non-zero so a malformed row
      // doesn't surface a meaningless 1970 timestamp.
      const secs = Math.floor(t.issued_at / 1000);
      if (secs > 0) out.added_at = secs;
      return out;
    });
  };

  const block = createNotificationBlock({
    askStore,
    settingsStore,
    channels: allChannels,
    readinessProbe,
    bridgeRosterProbe,
    prepareRecoveredAsk: (ask) => {
      if (ask.handler_kind !== PEER_ASK_HANDLER_KIND) return;
      const peerContractId = ask.handler_payload.peer_contract_id;
      const exchangeRef = ask.handler_payload.exchange_ref;
      if (typeof peerContractId !== 'string' || peerContractId.length === 0
        || typeof exchangeRef !== 'string' || exchangeRef.length === 0) {
        throw new Error('persisted peer ask has malformed inbox correlation');
      }
      const inbox = createPeerAskInboxStore(db);
      const row = inbox.get(peerContractId, exchangeRef);
      // Legacy peer asks predate the reciprocal inbox. Do not strand an already
      // durable owner decision during migration; new asks always have a row.
      if (row === null) return;
      const marked = inbox.markRaised(peerContractId, exchangeRef, ask.ask_id);
      if (marked === 'mismatch') {
        throw new Error('persisted peer ask disagrees with its inbox reservation');
      }
    },
    // D-210 A.8 slice 3d — the `/ask/<ask_id>` URL for `inline` channels. Same
    // builder the email channel already uses, so a deployment either has a
    // public base URL and BOTH surfaces carry a link, or has none and neither
    // does — never one silently without the other.
    ...(deps.askAnswerLink !== undefined ? { askAnswerLink: deps.askAnswerLink } : {}),
    // D-210 — the answered ask becomes a durable activity row.
    //
    // 🔴 Until this existed, an APPROVE wrote no approval audit row at all:
    // `createPreflightAnswerHandler` writes none, deny got only a failed run
    // anchor, and `approval_allow` / `approval_deny` were declared
    // `ActivityAction` codes with labels and ZERO writers. The run anchor's
    // `ask_id` back-pointer does not survive either — `auditLog.append` is
    // `set(run_id, …)`, so resuming the run OVERWRITES the awaiting row that
    // carried it. So nothing referenced the ask once it went terminal.
    //
    // ⛔ This is the precondition for pruning terminal asks. `ActivityEntry`
    // is append-only and keyed on `activity_id` (unlike the run-keyed
    // anchor), and both actions are reserve-class, so the row outlives both
    // the ask and normal retention.
    recordAnswerAudit: (record) => auditLog.logActivity(buildAnswerActivity(record)),
  });

  const baseResumer = createPreflightResumer({
    getExecuteDeps,
    auditLog,
    // D-137 — resolved AT SETTLE TIME, not at construction: chat is composed
    // in the app context and this resumer in the execution context, so the
    // sink does not exist yet when this runs.
    onRunSettled: (settled) => { deps.getRunSettledSink?.()?.(settled); },
    ...(deps.mcpActionStore !== undefined
      ? { mcpActionStore: deps.mcpActionStore }
      : {}),
    ...(deps.gatedActionStore !== undefined
      ? { gatedActionStore: deps.gatedActionStore }
      : {}),
    ...(deps.preserveClaimedDispatch !== undefined
      ? { preserveClaimedDispatch: deps.preserveClaimedDispatch }
      : {}),
    // D-202 Slice 1b — record the owner's approve/deny on a quality-relevant ask
    // as a reject-driven learner signal. Absent ⇒ no signal (dbless / no
    // contract store), byte-identical to pre-1b.
    ...(deps.qualityDelegationSignalStore !== undefined
      ? { qualityDelegationSignalStore: deps.qualityDelegationSignalStore }
      : {}),
  });
  const resumer = withBeforePreflightResume(
    baseResumer,
    deps.beforePreflightResume,
  );

  // D-177 P5a — the batch-approval coordinator (N.10): the durable
  // batch-ask rows ride their own SQLite collection; the coordinator's
  // answer hooks register on the `gateway.preflight` handler below, and
  // its `registerHold` half threads to `handleExecute` as
  // `executeDeps.batchApprovals` (the caller wires it off this bundle).
  const batchAskStore = createBatchAskStore(
    createSQLiteCollection<BatchAskRecord>(db, 'batch_asks'),
  );
  const batchApprovals = createBatchApprovalCoordinator({
    batchAskStore,
    checkpointStore,
    resumer,
    notifier: block,
    listUnresolvedAsks: () => block.listUnresolvedAsks(),
    cancelAsk: (ask_id) => block.cancelAsk(ask_id),
    ...(deps.sessionGrantResolver !== undefined
      ? { sessionGrantResolver: deps.sessionGrantResolver }
      : {}),
    ...(deps.upsertOverride !== undefined
      ? { upsertOverride: deps.upsertOverride }
      : {}),
    ...(deps.gatedActionStore !== undefined
      ? { gatedActionStore: deps.gatedActionStore }
      : {}),
  });

  registerPreflightHandler(block, {
    checkpointStore,
    resumer,
    batchApprovals: batchApprovals.hooks,
    ...(deps.upsertOverride !== undefined
      ? { upsertOverride: deps.upsertOverride }
      : {}),
  });
  registerInDoubtHandler(
    block,
    createInDoubtAnnotationWriter(annotationStore),
  );
  // R2 step 6 — the torn-saga answer handler: every answer records a
  // run-linked annotation; `undo` dispatches the persisted compensation
  // plans as fresh GATED runs via `handleExecute` (each still pauses at
  // preflight approval — the gate is the gate).
  registerSagaReconciliation(block, {
    annotationStore,
    getExecuteDeps,
    auditLog,
  });
  // Doc §4 close-out — the >1-provider pick answer handler: a candidate
  // answer dispatches a FRESH gated run with the chosen binding merged
  // into `config` (re-run, never resume — §1.3); `cancel` records the
  // decision and dispatches nothing.
  registerPickResolution(block, {
    getExecuteDeps,
    auditLog,
  });
  // D-192 Slice 6b — the container-pick answer handler: a chosen container is
  // persisted as the Source's default (`store.select`) then a FRESH run re-does
  // the create off the stored selection (re-run, never resume — the gate is the
  // gate). The store is a thin prepared-statement wrapper over `db` (same pattern
  // as the batch-ask store constructed inline above), so a local instance here
  // reads/writes the one `source_dependency_entity` table consistently.
  // D-234 § 234.1 — the peer-admission answer handler. ⛔ IT DISPATCHES NOTHING:
  // recording the decision IS the whole effect, because you can re-dispatch a
  // REQUEST but not an IDENTITY — a peer's authority comes from their live token
  // presentation, so a deferred re-run has no honest way to be them. The peer's
  // next call (a manual retry, carrying its own token) claims the decision at the
  // ceiling. That makes this the one ask leaf with no re-run dispatcher.
  registerPeerAdmissionHandler(block, createPeerAdmissionStore(db));
  // D-234 § 234.4 — THE RETURN LEG. Unlike the admission handler above, this one
  // DOES dispatch: an answer is DATA, not authority, so carrying it back needs no
  // re-presentation of anyone's identity — we call the peer under OUR connection,
  // as ourselves. That is the whole difference § 234.4 turns on.
  registerPeerAnswerHandler(block, PEER_ASK_HANDLER_KIND, {
    // ⚠ THE SAME SCAN `peerConnectionNameFor` DOES IN `mcp-server`, over the
    // SAME `config.peer_contract_id` field. Duplicated rather than shared only
    // because the two live either side of the public boundary; if a third copy
    // ever appears, that is the moment to lift it into one resolver.
    connectionForContract: (peer_contract_id) => {
      if (connectionStore === undefined || peer_contract_id === '') return undefined;
      for (const row of connectionStore.list({ kind: 'mcp' })) {
        try {
          const cfg = JSON.parse(row.config_json ?? '{}') as Record<string, unknown>;
          if (cfg.peer_contract_id === peer_contract_id) return row.name;
        } catch { /* a malformed row names nobody */ }
      }
      return undefined;
    },
    call: async (connection, callArgs) => {
      // ⛔ THE SAME DIRECT PATH THE ASK WENT OUT ON, and for the same reason:
      // preflight is a property of the RUN, and there is no run here — an owner
      // answering their own notification must not be asked to approve the
      // delivery of the answer they just gave.
      const { createServerExecutor } = await import('../../server-executor.js');
      const { CONNECTION_DIRECT_SLUG } = await import('@recued/contracts');
      const cfg = getExecuteDeps()?.executorConfig;
      if (cfg === undefined) throw new Error('executor config not yet published');
      return createServerExecutor(cfg)(CONNECTION_DIRECT_SLUG, {
        connection_kind: 'mcp',
        connection,
        tool: PEER_RECEIVE_ANSWER_TOOL,
        args: callArgs,
      });
    },
    logActivity: (row) => {
      try {
        (auditLog as unknown as { logActivity?: (r: unknown) => void })
          .logActivity?.({ ...row, timestamp: Date.now() });
      } catch { /* the ledger is not the decision */ }
    },
  });
  registerContainerPickResolution(block, {
    getExecuteDeps,
    auditLog,
    store: createSourceDependencyEntityStore(db),
  });
  // D-192 Slice 6c — the create-plan approve dispatcher: an approved plan creates
  // the named container(s) via the write executor's `executeCreatePlan` (which
  // persists each selection) then a FRESH run re-does the write off the stored
  // selection. Wired only when the write-executor accessor is threaded in (it
  // populates post-listener); absent ⇒ no create-plan answer handler (the ask is
  // never raised without the notifier either).
  if (deps.getWriteExecutor !== undefined) {
    registerCreatePlanResolution(block, {
      getExecuteDeps,
      auditLog,
      getWriteExecutor: deps.getWriteExecutor,
    });
  }

  return {
    block,
    resumer,
    batchApprovals,
    getBatch: async (batch_id: string) => await batchAskStore.get(batch_id),
    reconcileOpenBatch: (batch_id: string) =>
      batchApprovals.reconcileOpenBatch(batch_id),
  };
};

/** Dependencies the boot-time pending-ask + awaiting-checkpoint
 *  recovery needs. All three are required by `sweepAwaitingCheckpoints`;
 *  the bare `recoverPendingAsks` call only reads the block. */
export interface NotificationBlockBootRecoveryDeps {
  block: NotificationBlock;
  checkpointStore: CheckpointStore;
  auditLog: AuditLogStore;
  gatedActionStore?: GatedActionStore;
  /** Replay exactly journaled peer deliveries before generic dispatch claims
   * are frozen. The journal remains the authority if this retry throws. */
  recoverPeerDeliveries?: () => Promise<void>;
  /** Exempt dispatches backed by an exactly replayable durable substrate. */
  preserveInterruptedDispatch?: (
    record: GatedActionRecord,
  ) => boolean | Promise<boolean>;
  /** Narrow batch read used to keep an ask-less checkpoint attached to its
   * one durable group instead of minting a rogue standalone approval. */
  getBatch?: PreflightBootSweepDeps['getBatch'];
  reconcileOpenBatch?: PreflightBootSweepDeps['reconcileOpenBatch'];
  /** D-210 Phase C — threaded to the sweep so a notify-mode reception
   *  hold, which is ask-less BY DESIGN, is not re-raised as an
   *  actionable card on the next boot. */
  resolveInboxFanoutMode?: () => ReceptionInboxFanoutMode;
}

const BOOT_PEER_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'peer_outbox_unavailable',
  'peer_outbox_conflict',
  'peer_outbox_write_failed',
]);

const peerFailureFromTerminalAnchor = (
  action: GatedActionRecord,
  anchor: Awaited<ReturnType<AuditLogStore['get']>>,
): { status_message: string; result: Record<string, unknown> } | null => {
  if (anchor?.commit_status !== 'failed') return null;
  for (const error of anchor.errors ?? []) {
    if (error.source?.step_id !== action.gated_step_id
      || error.source.ingredient_slug !== 'peer-ask') continue;
    const details = error.details !== null
      && typeof error.details === 'object'
      && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : undefined;
    if (details === undefined
      || typeof details.exchange_ref !== 'string'
      || details.exchange_ref.length === 0) continue;
    const recognized = (typeof details.refusal === 'string'
        && details.refusal.length > 0)
      || (typeof details.reason === 'string'
        && BOOT_PEER_FAILURE_REASONS.has(details.reason));
    if (!recognized) continue;
    return {
      status_message: error.message,
      result: { ...details, status: 'failed' },
    };
  }
  return null;
};

/** Repair the inverse crash window: the terminal peer-delivery audit landed
 * but its receipt settlement did not. This runs before generic dispatching ->
 * in_doubt reconciliation so the durable run outcome, when narrowly matched
 * to its step and peer exchange, is not overwritten by a generic restart fact. */
const repairTerminalPeerFailureReceiptsAtBoot = async (
  store: GatedActionStore,
  auditLog: AuditLogStore,
): Promise<number> => {
  let repaired = 0;
  for (const action of await store.list()) {
    if (action.status !== 'dispatching') continue;
    try {
      const failure = peerFailureFromTerminalAnchor(
        action,
        await auditLog.get(action.run_id),
      );
      if (failure === null) continue;
      const settled = await store.finish(action.action_ref, {
        status: 'failed',
        status_message: failure.status_message,
        result: failure.result,
        observed: { items: 1, succeeded: 0, failed: 1 },
      });
      if (settled?.status === 'failed') repaired += 1;
    } catch (error) {
      console.warn(
        `[gated-action] terminal peer receipt repair failed for ${action.action_ref}: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return repaired;
};

/** Freeze interrupted dispatch claims, re-deliver outstanding asks, then re-raise asks
 *  for any `awaiting_approval` audit anchors whose `ask_id` is
 *  missing. Runs once at boot BEFORE live traffic so the bus replay
 *  reaches paired clients ahead of any new event. Best-effort
 *  per-failure — a thrown call surfaces as a `console.warn` so the
 *  daemon boot proceeds.
 *
 *  Ordering: peer-specific terminal repair and generic interrupted-claim
 *  reconciliation run BEFORE answered asks replay. A recipe receipt left
 *  `dispatching` across restart has lost its only live owner; freezing it as
 *  `in_doubt` is what prevents the surviving answered ask from dispatching the
 *  effect again. Exactly replayable peer-journal dispatches are exempted by the
 *  reconciler predicate. The checkpoint sweep remains last so it cannot mint a
 *  replacement before persisted asks replay. */
export const recoverNotificationBlockAtBoot = async (
  deps: NotificationBlockBootRecoveryDeps,
): Promise<void> => {
  const { block, checkpointStore, auditLog } = deps;

  if (deps.gatedActionStore !== undefined) {
    try {
      const repaired = await repairTerminalPeerFailureReceiptsAtBoot(
        deps.gatedActionStore,
        auditLog,
      );
      if (repaired > 0) {
        console.warn(
          `[gated-action] repaired ${repaired} terminal peer delivery failure receipt${repaired === 1 ? '' : 's'} at boot`,
        );
      }
    } catch (e) {
      console.warn(
        '[gated-action] terminal peer receipt repair failed at boot: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
    try {
      await deps.recoverPeerDeliveries?.();
    } catch (e) {
      console.warn(
        '[peer-delivery] journal recovery failed at boot; durable deliveries remain pending: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
    try {
      const reconciled = await reconcileInterruptedGatedActionsAtBoot(
        deps.gatedActionStore,
        { preserve: deps.preserveInterruptedDispatch },
      );
      if (reconciled > 0) {
        console.warn(
          `[gated-action] marked ${reconciled} interrupted dispatch${reconciled === 1 ? '' : 'es'} in doubt at boot`,
        );
      }
    } catch (e) {
      console.warn(
        '[gated-action] boot reconciliation failed; interrupted dispatch receipts '
          + 'will be retried on the next boot: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  try {
    await block.recoverPendingAsks();
  } catch (e) {
    console.warn(
      '[notification] recoverPendingAsks failed at boot — outstanding '
        + 'asks remain durable, next boot will retry: '
        + (e instanceof Error ? e.message : String(e)),
    );
  }

  try {
    const sweepResult = await sweepAwaitingCheckpoints({
      checkpointStore,
      auditLog,
      notifier: block,
      // Answered-but-unhandled asks remain the authority for their checkpoint:
      // if replay failed, the sweep must not mint a second approval beside the
      // already-recorded decision.
      listUnresolvedAsks: () => block.listUnresolvedAsks(),
      ...(deps.gatedActionStore !== undefined
        ? { gatedActionStore: deps.gatedActionStore }
        : {}),
      ...(deps.getBatch !== undefined ? { getBatch: deps.getBatch } : {}),
      ...(deps.reconcileOpenBatch !== undefined
        ? { reconcileOpenBatch: deps.reconcileOpenBatch }
        : {}),
      ...(deps.resolveInboxFanoutMode !== undefined
        ? { resolveInboxFanoutMode: deps.resolveInboxFanoutMode }
        : {}),
    });
    if (sweepResult.raised > 0
      || sweepResult.repairedPeerFailures > 0
      || sweepResult.failed > 0
      || sweepResult.orphaned > 0) {
      console.warn(
        '[preflight] awaiting-checkpoint sweep — '
          + `inspected=${sweepResult.inspected} raised=${sweepResult.raised} `
          + `alreadyPaired=${sweepResult.alreadyPaired} failed=${sweepResult.failed} `
          + `orphaned=${sweepResult.orphaned} terminal=${sweepResult.terminal} `
          + `superseded=${sweepResult.superseded} `
          + `heldForPeer=${sweepResult.heldForPeer} `
          + `repairedPeerFailures=${sweepResult.repairedPeerFailures} `
          + `leftPassive=${sweepResult.leftPassive}`,
      );
    }
  } catch (e) {
    console.warn(
      '[preflight] awaiting-checkpoint sweep threw — paused runs may '
        + 'remain unsurfaced until next boot: '
        + (e instanceof Error ? e.message : String(e)),
    );
  }
};

/** Raise one `notification.ask` per swept-to-in-doubt commit
 *  (D-157 § A.1 step 1). The caller must have already invoked
 *  `commitStore.sweepPendingToInDoubt()` and pass the resulting
 *  list; the sweep is the single boot-time producer of `in_doubt`
 *  commits, so this raise is idempotent across boots (subsequent
 *  boots return an empty list).
 *
 *  Best-effort per commit. A failed raise leaves the commit
 *  unreconciled; the user can manually trigger reconciliation via
 *  Settings → Audit (a downstream slice). */
export const raiseInDoubtForSweptCommits = async (deps: {
  block: NotificationBlock;
  sweptCommits: readonly Commit[];
}): Promise<void> => {
  const { block, sweptCommits } = deps;
  if (sweptCommits.length === 0) return;
  try {
    const outcome = await raiseInDoubtAsks(block, sweptCommits);
    if (outcome.failed.length > 0) {
      console.warn(
        `[commits] in-doubt ask raise: ${outcome.failed.length} `
          + `commit(s) could not be surfaced as notification.ask — `
          + 'see notification block logs',
      );
    }
  } catch (e) {
    console.warn(
      '[commits] in-doubt ask raise threw — proceeding without '
        + 'surfaced reconciliation prompts: '
        + (e instanceof Error ? e.message : String(e)),
    );
  }
};
