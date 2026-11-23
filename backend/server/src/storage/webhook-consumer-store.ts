/** D-201 Slices 4/5B2A — durable webhook consumer and approval-hold authority.
 *
 * Packs and local recipes name logical bindings; only this owner-side store may
 * connect those names to an ingress. The same rows drive front-line outbox
 * selection, exact event-type fan-out, per-target dispatch idempotency, and the
 * run-scoped decoded-payload read gate. Public endpoint ids and credentials are
 * never present in a recipe declaration or trigger context.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  validateRecipeWebhookTriggers,
  validateWebhookRequirements,
  validateWebhookTriggerBindings,
  webhookProfile,
  type AcceptedWebhookDeliveryRecord,
  type AcceptedWebhookEventRecord,
  type PackWebhookRequirement,
  type RecipeWebhookTrigger,
  type WebhookConsumerBindingRecord,
  type WebhookEnvironmentPolicy,
  type WebhookIngressBindingSelection,
  type WebhookIngressRecord,
  type WebhookRegistrationMode,
  type WebhookSourceTruthPolicy,
  type WebhookDeadLetterServerReason,
} from '@recued/contracts';
import type { WebhookIngressStore } from './webhook-ingress-store.js';
import {
  WebhookDeadLetterActionError,
  closingWebhookDeadLetterReview,
  deadLetterPageCondition,
  ensureWebhookDeadLetterReviewSchema,
  insertWebhookDeadLetterReview,
  type WebhookDeadLetterDecision,
  type WebhookDeadLetterPageBound,
  type WebhookDeadLetterReviewRow,
} from './webhook-dead-letter-reviews.js';

export type WebhookConsumerKind = WebhookConsumerBindingRecord['consumer_kind'];

export type WebhookConsumerStoreErrorCode =
  | 'invalid'
  | 'not_found'
  | 'not_ready'
  | 'cleanup_required'
  | 'conflict'
  | 'stale_claim'
  | 'corrupt';

export class WebhookConsumerStoreError extends Error {
  constructor(
    readonly code: WebhookConsumerStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookConsumerStoreError';
  }
}

export interface WebhookConsumerRecipeDeclaration {
  recipe_id: string;
  publisher_id: string;
  webhook_triggers: readonly RecipeWebhookTrigger[];
}

export interface ReplaceWebhookConsumerInput {
  consumer_kind: WebhookConsumerKind;
  consumer_id: string;
  /** D-201 Slice 10AD (10AA finding 21) — the rule a replacement left
   *  standing by an earlier save is finished with, when this one finds it: the
   *  same question the start asks (`recipeRemainsStored`), so one update gives
   *  one close reason. Absent, a recipe remains when that replacement still has
   *  a trigger of it, as before. */
  recipeRemains?: FinalizeConsumerReplacementOptions['recipeRemains'];
  /** D-201 Slice 10AF (10AE finding 5) — the owner starts this consumer's
   *  doors clean (a Kitchen save with its webhook switched off): the doors its
   *  recipes had last are forgotten in the replacement's own transaction, so a
   *  later door step starts clean even when this save's own door step fails.
   *  An undone replacement puts them back (`WebhookConsumerSnapshot.last_doors`). */
  forget_last_doors?: boolean;
  /** D-201 Slice 10AJ (10AI finding 1) — the owner's answers to the door
   *  switches an update from another publisher raised, kept in the
   *  replacement's own transaction. Every later door step that makes that
   *  recipe's door reads them (`doorAnswerFor`): the start's finish, a
   *  settings change, the next update. Held only in memory, a door step that
   *  did not finish lost them, and the door opened.
   *  D-201 Slice 10AO (10AM finding 1) — the answers kept before are put on
   *  the prior (`WebhookConsumerSnapshot.door_answers`), so an undone
   *  replacement takes its own away and gives the earlier ones back. */
  door_answers?: readonly WebhookRecipeDoorAnswer[];
  requirements: readonly PackWebhookRequirement[];
  selections: readonly WebhookIngressBindingSelection[];
  recipes: readonly WebhookConsumerRecipeDeclaration[];
  /** Pack installation defaults to armed. Standalone Kitchen saves pass false
   * so selecting an ingress cannot silently start autonomous execution. */
  enabled?: boolean;
  /** D-201 Slice 10X (10V finding 30) — the consumer's recipe row as it stood
   *  before this change (`recipeRowStamp`: its hash and save time), kept with
   *  the record, so a start finishing it can tell whether the change committed
   *  (the row moved on, or went) or not (the row is as it was). */
  prior_recipe_stamp?: string | null;
}

/** D-201 Slice 10X (10V finding 27) — a store fault that may pass: a busy or
 *  locked database, a failing or full disk. A record whose finish hits one is
 *  left for the next try, never set aside. */
export const isPassingStoreFault = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string'
    && /^SQLITE_(BUSY|LOCKED|IOERR|FULL|NOMEM|INTERRUPT|PROTOCOL|CANTOPEN)/.test(code);
};

/** D-201 Slice 10X — a recipe row's stamp: its hash and the time it was saved.
 *  Every save writes both, so a save that commits changes it, even one that
 *  leaves the content as it was. */
export const recipeRowStamp = (
  row: { readonly recipe_hash: string; readonly installed_at: number } | null | undefined,
): string | null => (row === null || row === undefined ? null : `${row.recipe_hash}@${row.installed_at}`);

interface BindingSqlRow {
  binding_id: string;
  consumer_kind: WebhookConsumerKind;
  consumer_id: string;
  logical_binding: string;
  ingress_id: string;
  required_profile_id: string;
  environment_policy: WebhookEnvironmentPolicy;
  registration_modes_json: string;
  required_event_types_json: string;
  paired_connection_required: number;
  decoded_payload_access: WebhookConsumerBindingRecord['decoded_payload_access'];
  source_truth_policy: WebhookSourceTruthPolicy;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface TriggerSqlRow {
  trigger_id: string;
  binding_id: string;
  recipe_id: string;
  publisher_id: string;
  provider_event_type: string;
  /** D-209 #1 — the recipe's webhook DOOR contract. Stamped AFTER the
   * cross-store save/install succeeds (never inside `replaceConsumer`, whose
   * rows must be restorable on rollback before any mint exists). NULL ⇒ no
   * door: a dispatch floors to `PUBLIC_CONTRACT_ID` and denies (fail-closed);
   * the owner's remedy is re-save. One door per (consumer, recipe) — every
   * trigger row of one recipe carries the SAME id. */
  contract_id: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** D-201 Slice 10A — a target row is the recipe work the outer event outbox
 *  hands off. `pending` waits for the recipe-dispatch worker (`available_at`
 *  holds a retry's backoff), `running` is a worker's leased claim (or an owner
 *  hold, see `webhook_waiting_dispatches`), `dead_letter` spent its attempts and
 *  keeps its payload pin for the owner, `dispatched` and `cancelled` are done. */
type DispatchState =
  | 'pending'
  | 'running'
  | 'dispatched'
  | 'cancelled'
  | 'dead_letter';

export type WebhookPreparedDispatchState =
  | DispatchState
  | 'awaiting_approval';

interface DispatchSqlRow {
  dispatch_id: string;
  event_id: string;
  trigger_id: string;
  binding_id: string;
  recipe_id: string;
  publisher_id: string;
  run_id: string;
  state: DispatchState;
  attempt_count: number;
  claim_token: string | null;
  /** Earliest time a pending row may be claimed (a failed run's backoff). */
  available_at: number;
  /** A worker claim's lease. NULL on every non-running row and on an owner
   *  hold, which no worker owns. */
  lease_expires_at: number | null;
  last_error_code: string | null;
  /** D-201 Slice 10B — when a dead letter was closed (by the owner or the
   *  review limit); null otherwise. Its state stays `dead_letter`. */
  resolved_at: number | null;
  /** D-201 Slice 10E — set when the server began stopping while this claim's
   *  run was going (or the run came back stopped by that stop). A run the
   *  restart's drain stops is recorded `killed`, which the runner otherwise
   *  reads as final; with this mark it runs the target again on its run id.
   *  Cleared whenever the run settles any other way. */
  restart_interrupted_at: number | null;
  /** D-201 Slice 10N — set when the owner tried again a dead letter whose
   *  approved run's outcome was in doubt (`approved_run_in_doubt`): having
   *  looked, the owner asks for it to run again. Its `in_doubt` record is
   *  otherwise final, so an uncertain operation is never repeated unasked.
   *  Kept, like the restart's mark, through a failure before a new run record;
   *  cleared whenever the run settles any other way. */
  in_doubt_rerun_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TargetSqlRow {
  trigger_id: string;
  binding_id: string;
  recipe_id: string;
  publisher_id: string;
  provider_event_type: string;
  /** D-209 #1 W3 — the trigger row's stamped door contract (see
   * `TriggerSqlRow.contract_id`). NULL rides through to the dispatch claim,
   * where the consumer builds a door-less `(webhook, anonymous)` source that
   * floors to `PUBLIC_CONTRACT_ID` and denies (fail-closed). */
  contract_id: string | null;
  consumer_kind: WebhookConsumerKind;
  consumer_id: string;
  logical_binding: string;
  ingress_id: string;
  required_profile_id: string;
  environment_policy: WebhookEnvironmentPolicy;
  registration_modes_json: string;
  required_event_types_json: string;
  paired_connection_required: number;
  decoded_payload_access: WebhookConsumerBindingRecord['decoded_payload_access'];
  source_truth_policy: WebhookSourceTruthPolicy;
  binding_created_at: number;
  trigger_created_at: number;
  recipe_pack_slug: string | null;
}

export interface WebhookConsumerSnapshot {
  consumer_kind: WebhookConsumerKind;
  consumer_id: string;
  bindings: readonly BindingSqlRow[];
  triggers: readonly TriggerSqlRow[];
  /** D-201 Slice 10AF (10AE finding 5) — the doors a replacement that starts
   *  clean (`forget_last_doors`) forgot: put back should it be undone. */
  last_doors?: readonly WebhookRecipeLastDoor[];
  /** D-201 Slice 10AO (10AM finding 1) — the owner's answers as they stood
   *  before a replacement that writes or forgets answers: an undo puts exactly
   *  these back. Before 10AO an undone update left its own answers, and the
   *  next update applied one over a switch the owner made since. Absent, the
   *  replacement touched none, and an undo leaves them as they are. */
  door_answers?: readonly WebhookRecipeDoorAnswer[];
}

/** D-201 Slice 10AF — the door a recipe's rows carried last, kept for it by
 *  the stamp (`stampTriggerContracts`). */
export interface WebhookRecipeLastDoor {
  recipe_id: string;
  publisher_id: string;
  contract_id: string;
  updated_at: number;
  /** D-201 Slice 10AJ (10AI finding 7) — its place among this store's doors,
   *  newest highest: the order `newestRecipeDoor` reads, which a clock set back
   *  cannot change. 0 for one kept before 10AJ, older than any since. */
  seq?: number;
}

/** D-201 Slice 10AJ (10AI finding 1) — the owner's answer for one recipe's
 *  door, given when an update brought it from another publisher.
 *  D-201 Slice 10AO (10AM finding 1) — or their switch on the webhook's card
 *  for a recipe whose rows carry no door (`keepOwnerDoorDecision`). It is the
 *  state of a door no stamp has made yet, read whatever the publisher, and
 *  ends when any door of that recipe is stamped. */
export interface WebhookRecipeDoorAnswer {
  recipe_id: string;
  /** The publisher of the rows it was given for. A record only: the answer is
   *  read whatever the publisher (10AO), as the card shows it. */
  publisher_id: string;
  door: 'open' | 'closed';
  /** When it was kept: written by the store, carried by an undo. */
  answered_at?: number;
}

export interface WebhookDispatchTarget {
  trigger_id: string;
  binding_id: string;
  recipe_id: string;
  publisher_id: string;
  /** D-209 #1 W3 — the recipe's webhook DOOR contract, read off the claimed
   * trigger row (every row of one recipe carries the SAME id — one door per
   * (consumer, recipe)). The consumer stamps it on the run's
   * `(webhook, anonymous)` ExecutionSource; NULL (unstamped row — pre-mint
   * crash window, legacy) yields a door-less source that floors to
   * `PUBLIC_CONTRACT_ID` at the gate and denies. Never caller-supplied. */
  contract_id: string | null;
  logical_binding: string;
  ingress_id: string;
  decoded_payload_access: WebhookConsumerBindingRecord['decoded_payload_access'];
  source_truth_policy: WebhookSourceTruthPolicy;
}

export interface WebhookPreparedDispatch extends WebhookDispatchTarget {
  dispatch_id: string;
  run_id: string;
  /** `awaiting_approval` is a durable projection over a running dispatch.
   * The underlying row stays running so the same run retains its payload pin,
   * while the wait marker prevents an outbox replay from claiming it again. */
  state: WebhookPreparedDispatchState;
}

export interface WebhookDispatchClaim extends WebhookPreparedDispatch {
  claim_token: string;
  attempt_count: number;
  /** D-201 Slice 10E — the server's last stop stopped this target's run: a
   *  `killed` run under its run id is run again, not taken as final. */
  resume_interrupted_run: boolean;
  /** D-201 Slice 10N — the owner, having looked, tried again a dead letter
   *  whose approved run was in doubt: an `in_doubt` run under its run id is
   *  run again, not taken as final. */
  rerun_in_doubt: boolean;
}

export interface WebhookAwaitingApprovalDispatch {
  dispatch_id: string;
  run_id: string;
  recipe_id: string;
  /** D-201 Slice 10J — the server's stop began while the owner's approved
   *  run was resuming (`markResumesInterruptedByRestart`). */
  restart_interrupted: boolean;
}

/** D-201 Slice 10A — a target row the recipe-dispatch worker may claim now. */
export interface WebhookRunnableDispatch {
  dispatch_id: string;
  event_id: string;
  recipe_id: string;
  publisher_id: string;
  /** D-201 Slice 10J — the attempts it has spent: a row that cannot be claimed
   *  waits out the retry schedule's next step, as a failed run does. */
  attempt_count: number;
}

/** D-201 Slice 10B — one recipe's run of an event that spent its attempts. */
export interface WebhookDeadLetterTargetRow {
  dispatch_id: string;
  event_id: string;
  delivery_id: string;
  ingress_id: string;
  recipe_id: string;
  run_id: string;
  provider_event_type: string;
  received_at: number;
  attempt_count: number;
  last_error_code: string | null;
  dead_lettered_at: number;
  payload_retained: boolean;
  /** Slice 10F — on a closed one: when, by whom and why. */
  closure?: {
    closed_at: number;
    closed_by: 'owner' | 'server';
    reason: string | null;
  };
}

/** How long a worker claim lasts unless renewed, and the attempt ceiling that
 *  dead-letters a target whose crashed claims spent every attempt. */
export interface WebhookDispatchClaimPolicy {
  lease_ms: number;
  max_attempts: number;
}

const requireClaimPolicy = (policy: WebhookDispatchClaimPolicy): void => {
  if (!Number.isSafeInteger(policy.lease_ms)
    || policy.lease_ms < 1_000
    || policy.lease_ms > 15 * 60 * 1_000) {
    throw new WebhookConsumerStoreError(
      'invalid',
      'webhook dispatch lease_ms must be in 1000..900000',
    );
  }
  if (!Number.isSafeInteger(policy.max_attempts)
    || policy.max_attempts < 1
    || policy.max_attempts > 100) {
    throw new WebhookConsumerStoreError(
      'invalid',
      'webhook dispatch max_attempts must be in 1..100',
    );
  }
};

/** Why `ingress` cannot serve `requirement`, or `null` when it can — given the
 *  webhook triggers of the recipes that would bind it (their events for this
 *  binding must be selected on the ingress too).
 *
 *  ⛔ ONE RULE FOR THE INSTALL AND THE INSTALL DIALOG (D-295). The install refuses
 *  with it (`replaceConsumer`); the dialog's webhook plan offers only the
 *  ingresses it accepts. Two copies would let the dialog offer a webhook the
 *  install then refuses. The checks run in the install's historical order, so
 *  the first failure — and its message — is the one it always reported. */
export const webhookIngressUnfit = (
  ingress: Pick<
    WebhookIngressRecord,
    'intake_state' | 'profile_id' | 'registration_mode' | 'environment'
    | 'selected_event_types' | 'paired_connection_id'
  >,
  requirement: PackWebhookRequirement,
  recipeTriggers: readonly RecipeWebhookTrigger[],
): {
  code: 'not_ready' | 'conflict';
  reason:
    | 'not_enabled' | 'profile' | 'registration_mode' | 'environment'
    | 'required_events' | 'trigger_events' | 'paired_connection';
  message: string;
} | null => {
  const binding = requirement.binding;
  if (ingress.intake_state !== 'enabled') {
    return { code: 'not_ready', reason: 'not_enabled', message: `webhook ingress for '${binding}' is not enabled` };
  }
  if (!requirement.profile_ids.includes(ingress.profile_id)) {
    return {
      code: 'conflict',
      reason: 'profile',
      message: `ingress profile '${ingress.profile_id}' is incompatible with '${binding}'`,
    };
  }
  if (requirement.registration_modes !== undefined
    && !requirement.registration_modes.includes(ingress.registration_mode)) {
    return {
      code: 'conflict',
      reason: 'registration_mode',
      message: `ingress registration mode is incompatible with '${binding}'`,
    };
  }
  const environmentPolicy = requirement.environment_policy ?? 'any';
  if ((environmentPolicy === 'test_only' && ingress.environment !== 'test')
    || (environmentPolicy === 'live_only' && ingress.environment !== 'live')) {
    return {
      code: 'conflict',
      reason: 'environment',
      message: `ingress environment is incompatible with '${binding}'`,
    };
  }
  const requiredEvents = requirement.required_event_types ?? [];
  if (requiredEvents.some((eventType) => !ingress.selected_event_types.includes(eventType))) {
    return {
      code: 'not_ready',
      reason: 'required_events',
      message: `ingress is missing a required event selection for '${binding}'`,
    };
  }
  const triggerEvents = recipeTriggers
    .filter((trigger) => trigger.binding === binding)
    .flatMap((trigger) => trigger.event_types);
  if (triggerEvents.some((eventType) => !ingress.selected_event_types.includes(eventType))) {
    return {
      code: 'not_ready',
      reason: 'trigger_events',
      message: `ingress is missing a recipe trigger event selection for '${binding}'`,
    };
  }
  if (requirement.paired_connection_slot !== undefined && ingress.paired_connection_id === null) {
    return {
      code: 'not_ready',
      reason: 'paired_connection',
      message: `ingress has no paired connection for '${binding}'`,
    };
  }
  return null;
};

export interface WebhookConsumerStoreOptions {
  ingressStore: Pick<WebhookIngressStore, 'get'>;
  now?: () => number;
  newBindingId?: () => string;
  newTriggerId?: () => string;
  newDispatchId?: () => string;
  newRunId?: () => string;
  newClaimToken?: () => string;
}

/** D-201 Slice 10S (10Q finding 4) — what a caller knows that the snapshot
 *  cannot say. */
export interface FinalizeConsumerReplacementOptions {
  /** Whether a recipe is still there after the change: a save keeps it, and
   *  after a pack update or at the start's finish of a replacement a process
   *  left, it remains while it is still stored. A trigger closed while its
   *  recipe remains is closed as `recipe_replaced` (saved with a different
   *  webhook setup), never `recipe_removed`. Absent, a recipe remains when the
   *  replacement still has a trigger of its: a delete passes none, its
   *  replacement having none. D-201 Slice 10Y (10V finding 18) — this said the
   *  start passed none; since Slice 10U it asks whether each recipe is stored. */
  recipeRemains?: (recipeId: string, publisherId: string) => boolean;
}

export interface WebhookConsumerStore {
  replaceConsumer(input: ReplaceWebhookConsumerInput): WebhookConsumerSnapshot;
  /** D-201 Slice 10M — what this replacement, saved switched on, would do,
   * without writing anything. `history`: `kept` when every trigger on now
   * continues, so its waiting deliveries and dead letters go to the saved
   * version; `closed` when one does not; `none` when no trigger is on. A
   * trigger continues by `replaceConsumer`'s own match: its binding continues
   * (Slice 10F's rule) and the saved version still takes its event, for the
   * same recipe and publisher. D-201 Slice 10S (10Q finding 4): 10M checked the
   * bindings alone, so a draft dropping an event its slot only allows was told
   * its history stays, and the save closed that event's. `widened`: each slot whose messages it would use more of,
   * as `<slot>:scoped_read` (it reads them, where it read only their
   * metadata) or `<slot>:delivery_payload_allowed` (it trusts them unchecked,
   * where it read back from the vendor). Throws as `replaceConsumer` would.
   * D-201 Slice 10Y (10V finding 6) — `triggers`: each trigger on now, by its
   * slot and event, and whether its history stays with the saved version or
   * closes. A keep-on save carries every one that continues, so a history
   * `closed` by one trigger is not closed for the rest. */
  previewReplacement(
    input: Omit<ReplaceWebhookConsumerInput, 'enabled'>,
  ): {
    history: 'kept' | 'closed' | 'none';
    widened: string[];
    triggers: Array<{ slot: string; event_type: string; history: 'kept' | 'closed' }>;
  };
  /** Commit the replacement represented by `prior` after the caller's
   * cross-store mutation succeeds. Until this point old in-flight dispatches
   * remain detached so rollback can restore them without losing claim state.
   * D-201 Slice 10P — `replaceConsumer` records `prior` in its own transaction
   * (`webhook_consumer_replacements`) and this clears it, as `restoreConsumer`
   * does: a process that dies between the two leaves the record, and the next
   * start finishes it (`pendingReplacements`, `finishWebhookReplacementsAtStart`),
   * so a continued trigger's rows are re-homed rather than swept as removed. A
   * finished row moves only for an event the outbox can still hand off again.
   * D-201 Slice 10U — callers make the door first (`reconcileWebhookDoors`) and
   * finalize after, so the record stands until the door does. */
  finalizeConsumerReplacement(
    prior: WebhookConsumerSnapshot,
    options?: FinalizeConsumerReplacementOptions,
  ): void;
  /** D-201 Slices 10P and 10U — the replacements a process left unfinished,
   * each with its prior snapshot (`null` when its record cannot be read) and
   * the consumer as it stands now. The start finishes each before anything
   * runs or sweeps (`finishWebhookReplacementsAtStart`): given back when its
   * save never committed, else its door made as the save's would have been
   * and then finalized, so a continued trigger's rows are re-homed and run. */
  pendingReplacements(): Array<{
    consumer_kind: WebhookConsumerKind;
    consumer_id: string;
    prior: WebhookConsumerSnapshot | null;
    current: WebhookConsumerSnapshot;
    /** D-201 Slice 10X — the recipe row's stamp before the change, when the
     *  caller gave one (a Kitchen save or delete since 10X). */
    prior_recipe_stamp: string | null;
  }>;
  /** D-201 Slice 10U (10Q finding 23) — drop a record the start could not
   * finish (unreadable, or one whose finish failed: corruption, or a record a
   * newer version wrote). Its rows are left to the start's sweep, as before
   * 10P, and nothing waits on it again. */
  setAsidePendingReplacement(consumerKind: WebhookConsumerKind, consumerId: string): void;
  /** D-201 Slice 10AX (10AS finding 12) — the owner's door answers and switches
   *  kept for its recipes go in the removal's own transaction: none stands once
   *  the consumer is gone. An install whose undo failed fell back to this and
   *  left the undone update's answer, which the next install applied. With
   *  `forget_last_doors` (an uninstall) the doors its recipes had last go too,
   *  so installed again it starts clean even when nothing after the removal
   *  runs: the uninstall forgot them after it, best effort.
   *  D-201 Slice 10BE (10AY finding 3) — `door_answers`: the answers that stand
   *  once it is removed, written in the same transaction. An install's undo
   *  that cannot restore falls back to this and passes the ones kept before
   *  the update it undid (its snapshot's), as the restore would have put them
   *  back; 10AX forgot those too, and a door the owner closed came out open.
   *  An uninstall passes none. */
  removeConsumer(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    options?: {
      readonly forget_last_doors?: boolean;
      readonly door_answers?: readonly WebhookRecipeDoorAnswer[];
    },
  ): WebhookConsumerSnapshot;
  /** D-201 Slice 10BL (10BF finding 15) — the answers to a consumer's door
   *  switches put back as they stood, and nothing else, in one transaction.
   *  For an install's undo whose restore and removal both refuse (an
   *  operation-bound binding stays for its remote clean-up, so it is never
   *  removed here): the answers kept before the update go back, so the undone
   *  update's own do not stand. They stood, and the next install applied them. */
  restoreDoorAnswers(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    answers: readonly WebhookRecipeDoorAnswer[],
  ): void;
  /** Undo a replacement. D-201 Slice 10X (10V finding 31) — `carryOpenRows`:
   *  the rows made under it that still wait (pending, or an open dead letter)
   *  go back to the restored trigger that takes the same recipe, slot and event,
   *  rather than closing. For the start's undo of a save that never committed,
   *  where a process kept running on the replacement's triggers meanwhile. */
  restoreConsumer(snapshot: WebhookConsumerSnapshot, options?: { carryOpenRows?: boolean }): void;
  /** Arm or disarm one complete consumer. Arming revalidates every stored
   * ingress constraint and advances authority past all accepted deliveries. */
  setConsumerEnabled(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    enabled: boolean,
  ): void;
  isConsumerEnabled(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): boolean;
  listBindings(input?: {
    consumer_kind?: WebhookConsumerKind;
    consumer_id?: string;
  }): WebhookConsumerBindingRecord[];
  /** D-209 #1 — stamp one recipe's webhook DOOR contract onto every one of its
   * trigger rows under this consumer. Called only after the cross-store
   * save/install has succeeded (the mint is never part of the replaceConsumer
   * snapshot). Returns the number of rows stamped — 0 means the recipe has no
   * trigger rows here, which the caller should treat as a failed enrollment. */
  stampTriggerContracts(input: {
    consumer_kind: WebhookConsumerKind;
    consumer_id: string;
    recipe_id: string;
    publisher_id: string;
    contract_id: string;
  }): number;
  /** D-209 — the inverse of {@link stampTriggerContracts}: leave this recipe's
   *  rows on one consumer door-less (NULL), as `replaceConsumer` leaves every row
   *  it re-creates. For a reconcile over rows that are NOT re-created (a main
   *  dish's settings changing), so a refusal leaves no stamp naming the door it
   *  retires — D-295 reads "revoked while still stamped" as the OWNER's act.
   *  Returns the rows changed. */
  clearTriggerContracts(input: {
    consumer_kind: WebhookConsumerKind;
    consumer_id: string;
    recipe_id: string;
    publisher_id: string;
  }): number;
  /** D-209 #1 — the door contract every one of this recipe's trigger rows
   * carries, or `null` when the recipe has no rows, any row is unstamped, or
   * the rows disagree. `null` is the fail-closed "door missing — re-save"
   * state the status/arm surfaces render; it is never an error. */
  doorContractIdForRecipe(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    recipeId: string,
    publisherId: string,
  ): string | null;
  /** D-201 Slice 10AC (10AA finding 3) — the door a recipe had last, for a
   *  later door when its rows carry none: an earlier version dropped its
   *  webhook or its trigger, or its door was refused. A later door for it
   *  carries what its owner did to this one (closed it, switched operations
   *  off). Replaces any it had. D-201 Slice 10AF (10AE findings 1 and 5) —
   *  written by every stamp, in the stamp's own transaction, so it is the
   *  newest door the recipe's rows carried, whatever later stopped an update. */
  rememberRecipeDoor(input: {
    consumer_kind: WebhookConsumerKind;
    consumer_id: string;
    recipe_id: string;
    publisher_id: string;
    contract_id: string;
  }): void;
  /** D-201 Slice 10AC — the door {@link rememberRecipeDoor} kept, or `null`. */
  lastRecipeDoor(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    recipeId: string,
    publisherId: string,
  ): string | null;
  /** D-201 Slice 10AF (10AE findings 1 and 17) — the newest door this
   *  consumer's recipe had, under whichever publisher, or `null`. A recipe
   *  whose rows carry no door starts from it; one that now comes from another
   *  publisher (an owner who edits a pack publishes it under their own name)
   *  does too, which a lookup by publisher could not find, and one that comes
   *  back to a publisher it had starts from its newest door, not that one's. */
  newestRecipeDoor(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    recipeId: string,
  ): { publisher_id: string; contract_id: string } | null;
  /** D-201 Slice 10AC — forget every door kept for this consumer's recipes:
   *  the pack is uninstalled, or the Kitchen recipe deleted. Installed again,
   *  it starts with fresh doors. D-201 Slice 10AJ — and the owner's answers. */
  forgetRecipeDoors(consumerKind: WebhookConsumerKind, consumerId: string): void;
  /** D-201 Slice 10AJ (10AI finding 1) — the owner's answer for this recipe's
   *  door, kept until a stamp makes that door, or `null`.
   *  D-201 Slice 10AO (10AM finding 1) — whatever the publisher: an update
   *  from a third publisher, or back to the first, starts from the state the
   *  owner's answer left the door in, as the card shows it. It was read for
   *  the publisher it was given for only, and the card and the door step
   *  disagreed with it. */
  doorAnswerFor(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    recipeId: string,
  ): 'open' | 'closed' | null;
  /** D-201 Slice 10AO (10AM finding 1) — the owner's switch on the webhook's
   *  card, kept for a recipe whose rows on this consumer carry no door: the
   *  state that door is made in, as an answer is, until a stamp makes it. Rows
   *  that carry a door forget any answer instead: the door is the state. So a
   *  switch the owner makes outranks any answer given before it, even when the
   *  door step it starts does not finish. */
  keepOwnerDoorDecision(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    recipeId: string,
    publisherId: string,
    door: 'open' | 'closed',
  ): void;
  /** D-320 audit — the door the trigger row of this run's dispatch carries now, or
   *  `null` when the run has no dispatch, its trigger row is gone, or the row is
   *  unstamped. A re-derive re-stamps the row with the door that replaced the one
   *  the run started under; an owner's revoke leaves it stamped (D-295). */
  currentDoorForRun(runId: string): string | null;
  /** D-201 Slice 10AP (10AM finding 3) — whose door this run's delivery goes
   *  through now: the consumer, recipe and publisher of its dispatch's trigger
   *  row, so the owner's state of that door is read as the card reads it
   *  (`ownerLeftDoorClosed`). `null` when the run has no dispatch, or its
   *  trigger row or binding is gone. */
  doorOwnerOfRun(runId: string): {
    consumer_kind: WebhookConsumerKind;
    consumer_id: string;
    recipe_id: string;
    publisher_id: string;
  } | null;
  /** Every consumer whose trigger rows start this recipe, each with a snapshot
   *  NARROWED to that recipe's own rows (its bindings kept whole). What a door
   *  reconcile for ONE recipe diffs against: given a consumer's whole snapshot,
   *  `reconcileWebhookDoors` would retire a SIBLING recipe's door as "not
   *  re-used" — a pack ships several webhook recipes under one consumer. */
  /** D-320 phase 3 (3b) — every recipe some trigger row starts, sorted: what a
   *  change to a pack's connections re-derives the doors of. */
  recipesWithTriggers(): string[];
  consumersOfRecipe(recipeId: string): Array<{
    consumer_kind: WebhookConsumerKind;
    consumer_id: string;
    publisher_id: string;
    snapshot: WebhookConsumerSnapshot;
  }>;
  hasDispatchTarget(ingressId: string, providerEventType: string): boolean;
  /** D-201 Slice 10A — the outer event outbox's handoff. Durably materializes
   * one pending target row per currently authorized trigger, each pinning the
   * event's decoded payload until the target is done, and returns them. Runs
   * no recipe: the recipe-dispatch worker claims the rows. */
  prepareDispatches(input: {
    event: AcceptedWebhookEventRecord;
    delivery: AcceptedWebhookDeliveryRecord;
  }): WebhookPreparedDispatch[];
  /** D-201 Slice 10A — target rows the worker may claim now, oldest first: a
   * pending row past its backoff, or a running claim whose lease expired (its
   * worker died). Only rows whose event the outer outbox has handed off
   * (`dispatched`, or pruned since) and whose trigger is attached. At most one
   * per recipe, and none for a recipe that has a live claim: a recipe's
   * deliveries run one at a time, in the order they were handed off. */
  listRunnableDispatches(input: { limit: number }): WebhookRunnableDispatch[];
  /** Claim one target for a worker, re-deriving its authority now. Null when
   * it is done, held for the owner, not yet due, claimed by a live worker,
   * mid-replacement, or out of attempts (then dead-lettered); a target whose
   * authority is gone is cancelled and its pin released. */
  beginDispatch(input: {
    dispatch_id: string;
    event: AcceptedWebhookEventRecord;
    delivery: AcceptedWebhookDeliveryRecord;
  } & WebhookDispatchClaimPolicy): WebhookDispatchClaim | null;
  /** Extend a live claim's lease. False once the claim is no longer this
   * worker's (cancelled, reclaimed after an expiry, or settled). */
  renewDispatchLease(input: {
    dispatch_id: string;
    claim_token: string;
    lease_ms: number;
  }): boolean;
  /** Hand an unrun claim back (the server refused to start the run: it is
   * restarting or paused): pending at once, the attempt its claim counted
   * given back, the payload pin kept. */
  releaseDispatchClaim(dispatchId: string, claimToken: string): void;
  /** D-201 Slice 10E — the server has begun to stop: mark these live claims,
   * whose runs its drain may stop, so the next start runs a stopped one again
   * rather than reading its `killed` record as final. Returns how many were
   * marked (a claim that settled meanwhile is not). */
  markInterruptedByRestart(claims: ReadonlyArray<{
    dispatch_id: string;
    claim_token: string;
  }>): number;
  /** D-201 Slice 10E — a run the restart's drain stopped: like a refusal, the
   * claim goes back pending with its attempt, and the mark stays, so the next
   * start runs it again on its run id. */
  releaseInterruptedDispatch(dispatchId: string, claimToken: string): void;
  /** D-201 Slice 10E — a runnable row the worker could not claim (its row or
   * its binding is unreadable): it counts an attempt and waits out
   * `retry_delay_ms`, so it stops being offered on every pass and its recipe's
   * later deliveries can run; at `max_attempts` it becomes a dead letter
   * (`claim_failed`) for the owner. Null when it was not runnable. Nothing ran,
   * so a restart's mark stays (Slice 10J). */
  deferUnclaimableDispatch(input: {
    dispatch_id: string;
    retry_delay_ms: number;
    max_attempts: number;
  }): 'pending' | 'dead_letter' | null;
  /** Close a runnable target whose event or delivery record is gone, which a
   * pin should make impossible: it can never be authorized or run, and left
   * pending it would hold its recipe's queue forever. False when it is not
   * runnable now (done, held, or claimed by a live worker). */
  cancelUnreadableDispatch(dispatchId: string): boolean;
  markDispatchAwaitingApproval(dispatchId: string, claimToken: string): void;
  listAwaitingApprovalDispatches(): WebhookAwaitingApprovalDispatch[];
  /** Take a bounded fair reconciliation batch. Selected rows rotate behind
   * untouched rows using a logical timestamp so a long-lived hold cannot starve
   * a newer terminal decision. */
  takeAwaitingApprovalDispatches(limit: number): WebhookAwaitingApprovalDispatch[];
  /** D-201 Slice 10J — the server has begun to stop while the owner's approved
   * runs of these held targets resume (outside the worker): mark them, so a
   * run its drain stops becomes a dead letter for the owner instead of reading
   * as the owner's Stop. Returns how many were marked. */
  markResumesInterruptedByRestart(held: ReadonlyArray<{
    dispatch_id: string;
    run_id: string;
  }>): number;
  /** D-201 Slice 10J — a held target's run is waiting on the owner again: a
   * new run record replaced the one a restart's mark was for, so the mark goes. */
  clearHeldRestartMark(input: { dispatch_id: string; run_id: string }): boolean;
  /** Resolve a durable owner hold. `failed` is terminal for this target (for
   * example an owner denial), so it cancels rather than requeues the dispatch.
   * D-201 Slice 10J — `interrupted`: the server's stop ended the approved run
   * (its row carries the restart's mark), so the target becomes a dead letter
   * (`restart_interrupted`) that keeps its pin and its mark: the owner can try
   * it again, and it then runs again on its run id.
   * D-201 Slice 10N (10L finding 4) — `in_doubt`: the approved run's outcome
   * is in doubt (a restart or a crash while its operation ran, or the
   * operation's own uncertain answer). Never a silent cancel: a dead letter
   * (`approved_run_in_doubt`) for the owner's review that keeps its pin.
   * Trying it again runs it again on its run id (`in_doubt_rerun_at`), where
   * its hold asks the owner afresh. */
  resolveAwaitingApprovalDispatch(input: {
    dispatch_id: string;
    run_id: string;
    outcome: 'succeeded' | 'failed' | 'interrupted' | 'in_doubt';
  }): boolean;
  markDispatchSucceeded(dispatchId: string, claimToken: string): void;
  markDispatchCancelled(dispatchId: string, claimToken: string): void;
  /** A run that failed: pending again after `retry_delay_ms`, or dead-lettered
   * once its claims reach `max_attempts`. Either way the payload pin stays:
   * the same run id is retried, or the owner can still recover it.
   * D-201 Slice 10J — `keep_restart_mark`: it failed before a new run record
   * replaced the one a restart stopped, so that restart's mark stays and the
   * next attempt runs it again rather than reading `killed` as the owner's Stop. */
  markDispatchFailed(input: {
    dispatch_id: string;
    claim_token: string;
    error_code: string;
    retry_delay_ms: number;
    max_attempts: number;
    keep_restart_mark?: boolean;
  }): 'pending' | 'dead_letter';
  /** Events with recipe work still to run: what the delivery store's intake
   * capacity counts once the outer outbox has handed the event off. An owner
   * hold is not counted (the outbox never did), nor, since Slice 10B, a dead
   * letter: it waits for the owner, bounded by the review limit. */
  countActiveDispatchEvents(): number;
  /** D-201 Slice 10B — one ingress's unresolved target dead letters (one
   * recipe's run of an event that spent its attempts), newest first. */
  /** One webhook's target dead letters, newest first: the open ones, or (Slice
   * 10F, `closed`) the closed ones with who closed them and why. */
  listDeadLetterTargets(input: {
    ingress_id: string;
    limit: number;
    before?: WebhookDeadLetterPageBound;
    closed?: boolean;
  }): WebhookDeadLetterTargetRow[];
  /** D-201 Slice 10F — an event dead letter was closed (its outbox row): its
   * targets, rows a server before 10A left under it or a handoff whose mark kept
   * failing, can never run. They are cancelled and release their pins. Runs
   * inside the closing transaction. Returns how many. */
  closeTargetsOfClosedEvent(eventId: string): number;
  /** D-201 Slice 10I (10H finding 5) — open rows whose trigger no longer
   * exists (a delete before 10I, or a stop between a save's two steps): no
   * claim can reach them. Dead letters are closed with a record
   * (`recipe_removed`), the rest cancelled, every pin and wait released.
   * D-201 Slice 10P — the replacements a process left unfinished are finished
   * first, so a continued trigger's rows are never among them.
   * Returns how many. */
  closeStrandedTargets(): number;
  /** D-201 Slice 10F — an event dead letter is tried again: its targets get
   * fresh attempts, at once. Runs inside the requeue's transaction. */
  refreshTargetsOfRequeuedEvent(eventId: string): number;
  /** D-201 Slice 10F — whether trying the event again would reach a recipe:
   * one that takes it now, its slot bound since before the event arrived. */
  eventHasCurrentRecipe(eventId: string): boolean;
  /** D-201 Slice 10F — close the open target dead letters of one webhook,
   * recording that Recued did and why (a retired webhook). Returns how many. */
  closeDeadLetterTargetsForIngress(ingressId: string, reason: WebhookDeadLetterServerReason): number;
  /** D-201 Slice 10F — retention: delete the finished target rows (done,
   * cancelled, closed) whose event is gone. Returns how many. */
  pruneDispatchesWithoutEvents(): number;
  /** Unresolved target dead letters on one ingress, or on the server. */
  countUnresolvedDeadLetterTargets(ingressId?: string): number;
  /** The oldest unresolved target dead letters, for the review limit. */
  /** D-201 Slice 10W — whether a run's delivery still waits on the owner or a
   *  worker: queued, running, or an open dead letter. A run held for the
   *  owner's try again goes once its delivery no longer does. */
  isRunStillOpen(runId: string): boolean;
  /** D-201 Slice 10X (10V finding 11) — the oldest unresolved target dead
   *  letters its recipe never ran for want of a live door (`door_missing`,
   *  `door_closed`): the review limit closes these before any other, so a
   *  webhook with no door never crowds out another's dead letters. */
  oldestUnresolvedDoorlessDeadLetterTargets(limit: number): Array<{
    id: string;
    ingress_id: string;
    dead_lettered_at: number;
  }>;
  oldestUnresolvedDeadLetterTargets(limit: number): Array<{
    id: string;
    ingress_id: string;
    dead_lettered_at: number;
  }>;
  /** Try a target dead letter again: pending at once with fresh attempts,
   * under its original target and run ids; the worker re-derives its
   * authority when it claims it. Its payload pin stays. Records the decision. */
  requeueDeadLetterTarget(
    input: { dispatch_id: string } & WebhookDeadLetterDecision & {
      /** D-201 Slice 10U (10Q finding 9) — whether the door stamped on its
       *  trigger is live. One that is not refuses (`door_missing` /
       *  `door_closed`) and the dead letter stays: tried again, the claim
       *  would only keep it again. */
      door?: (contractId: string | null) => 'live' | 'missing' | 'closed';
    },
  ): WebhookDeadLetterReviewRow;
  /** Close a target dead letter: a reviewed end that claims nothing about the
   * recipe. Its payload pin is released, so the payload follows its
   * retention. Records the decision. */
  resolveDeadLetterTarget(
    input: { dispatch_id: string; action: 'resolve' | 'expire' } & WebhookDeadLetterDecision,
  ): WebhookDeadLetterReviewRow;
  isRunAuthorized(input: {
    run_id: string;
    recipe_id: string;
    event: AcceptedWebhookEventRecord;
    delivery: AcceptedWebhookDeliveryRecord;
    require_payload_access: boolean;
  }): boolean;
}

/** D-201 Slice 10A — the target row the outer outbox hands off and the
 *  recipe-dispatch worker claims. `lease_expires_at` is not tied to `running`
 *  by a CHECK: an owner hold is `running` with no lease (no worker owns it). */
const DISPATCH_TABLE_COLUMNS = `
      dispatch_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'running', 'dispatched', 'cancelled', 'dead_letter')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      claim_token TEXT,
      available_at INTEGER NOT NULL DEFAULT 0,
      lease_expires_at INTEGER,
      last_error_code TEXT,
      resolved_at INTEGER,
      restart_interrupted_at INTEGER,
      in_doubt_rerun_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (event_id, trigger_id),
      CHECK (
        (state = 'running' AND claim_token IS NOT NULL)
        OR (state <> 'running' AND claim_token IS NULL)
      )
`;

/** D-201 Slice 10A — a database from before the recipe-dispatch worker has a
 *  dispatch table whose state CHECK has no `dead_letter` and no lease or
 *  backoff columns. SQLite cannot widen a CHECK in place, so the table is
 *  rebuilt in one transaction (no foreign key points at it).
 *
 *  A row that was `running` without an owner hold was a run the old outbox
 *  dispatched inline; whichever process ran it is gone, so its lease starts
 *  expired and the worker reclaims it under the same run id. The runner then
 *  reuses what the run left: a succeeded anchor completes the target, a
 *  killed or denied one closes it, a failed one runs again. An owner hold
 *  keeps no lease (the approval reconciler owns it). */
const migrateDispatchTableForWorker = (db: Database.Database): void => {
  const columns = db.prepare(
    'PRAGMA table_info(webhook_recipe_dispatches)',
  ).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'available_at')) return;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS webhook_recipe_dispatches_rebuild');
    db.exec(`CREATE TABLE webhook_recipe_dispatches_rebuild (${DISPATCH_TABLE_COLUMNS})`);
    db.exec(`
      INSERT INTO webhook_recipe_dispatches_rebuild (
        dispatch_id, event_id, trigger_id, binding_id, recipe_id, publisher_id,
        run_id, state, attempt_count, claim_token, available_at,
        lease_expires_at, last_error_code, created_at, updated_at
      )
      SELECT
        dispatch.dispatch_id, dispatch.event_id, dispatch.trigger_id,
        dispatch.binding_id, dispatch.recipe_id, dispatch.publisher_id,
        dispatch.run_id, dispatch.state, dispatch.attempt_count,
        dispatch.claim_token, 0,
        CASE
          WHEN dispatch.state = 'running' AND NOT EXISTS (
            SELECT 1 FROM webhook_waiting_dispatches waiting
            WHERE waiting.dispatch_id = dispatch.dispatch_id
          ) THEN 0
          ELSE NULL
        END,
        NULL, dispatch.created_at, dispatch.updated_at
      FROM webhook_recipe_dispatches dispatch
    `);
    db.exec('DROP TABLE webhook_recipe_dispatches');
    db.exec('ALTER TABLE webhook_recipe_dispatches_rebuild RENAME TO webhook_recipe_dispatches');
  })();
};

const createSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_consumer_bindings (
      binding_id TEXT PRIMARY KEY,
      consumer_kind TEXT NOT NULL CHECK (
        consumer_kind IN ('pack_install', 'local_recipe')
      ),
      consumer_id TEXT NOT NULL,
      logical_binding TEXT NOT NULL,
      ingress_id TEXT NOT NULL,
      required_profile_id TEXT NOT NULL,
      environment_policy TEXT NOT NULL CHECK (
        environment_policy IN ('match_connection', 'test_only', 'live_only', 'any')
      ),
      registration_modes_json TEXT NOT NULL,
      required_event_types_json TEXT NOT NULL,
      paired_connection_required INTEGER NOT NULL CHECK (
        paired_connection_required IN (0, 1)
      ),
      decoded_payload_access TEXT NOT NULL CHECK (
        decoded_payload_access IN ('metadata_only', 'scoped_read')
      ),
      source_truth_policy TEXT NOT NULL CHECK (
        source_truth_policy IN (
          'delivery_payload_allowed', 'provider_readback_required'
        )
      ),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (consumer_kind, consumer_id, logical_binding),
      FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id)
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_consumer_bindings_ingress
      ON webhook_consumer_bindings(ingress_id, enabled, logical_binding);

    CREATE TABLE IF NOT EXISTS webhook_recipe_triggers (
      trigger_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      provider_event_type TEXT NOT NULL,
      contract_id TEXT,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (binding_id, recipe_id, publisher_id, provider_event_type),
      FOREIGN KEY (binding_id) REFERENCES webhook_consumer_bindings(binding_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_triggers_match
      ON webhook_recipe_triggers(provider_event_type, enabled, binding_id);

    CREATE TABLE IF NOT EXISTS webhook_recipe_dispatches (
      ${DISPATCH_TABLE_COLUMNS}
    );

    CREATE TABLE IF NOT EXISTS webhook_waiting_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_payload_pins (
      pin_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_payload_pins_event
      ON webhook_payload_pins(event_id);

    -- D-201 Slice 10P -- a replacement between its replace and its finalize
    --   (or restore): the prior bindings and triggers, so a process that dies
    --   in between leaves enough for the next start to finalize it.
    CREATE TABLE IF NOT EXISTS webhook_consumer_replacements (
      consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('pack_install', 'local_recipe')),
      consumer_id TEXT NOT NULL,
      prior_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (consumer_kind, consumer_id)
    );

    -- D-201 Slice 10AC -- the door a recipe had last when it was left with
    --   none, so a later version that takes its webhook again keeps what the
    --   owner did to it.
    CREATE TABLE IF NOT EXISTS webhook_recipe_last_doors (
      consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('pack_install', 'local_recipe')),
      consumer_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (consumer_kind, consumer_id, recipe_id, publisher_id)
    );

    -- D-201 Slice 10AJ (10AI finding 1) -- the owner's answer for a recipe's
    --   door when an update brought it from another publisher, until a stamp
    --   makes that door.
    CREATE TABLE IF NOT EXISTS webhook_recipe_door_answers (
      consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('pack_install', 'local_recipe')),
      consumer_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      door TEXT NOT NULL CHECK (door IN ('open', 'closed')),
      answered_at INTEGER NOT NULL,
      PRIMARY KEY (consumer_kind, consumer_id, recipe_id)
    );
  `);
  // D-201 Slice 10AJ (10AI finding 7) — the order of the doors kept, which the
  // wall clock cannot change. A door kept before it is older than any since.
  if (!(db.prepare('PRAGMA table_info(webhook_recipe_last_doors)').all() as Array<{ name: string }>)
    .some((column) => column.name === 'seq')) {
    db.exec('ALTER TABLE webhook_recipe_last_doors ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
  }
  // D-201 Slice 10X — the recipe row's stamp before the change. NULL for a
  // record from before it: the start then judges by the triggers, as 10U did.
  if (!(db.prepare(`PRAGMA table_info(webhook_consumer_replacements)`).all() as Array<{ name: string }>)
    .some((column) => column.name === 'prior_recipe_stamp')) {
    db.exec('ALTER TABLE webhook_consumer_replacements ADD COLUMN prior_recipe_stamp TEXT');
  }
  // D-209 #1 — pre-existing databases created before the door column. NULL for
  // every legacy row is exactly right: no door was ever minted for them, so the
  // dispatch fail-closed floor applies until the owner re-saves.
  const triggerColumns = db.prepare(
    'PRAGMA table_info(webhook_recipe_triggers)',
  ).all() as Array<{ name: string }>;
  if (!triggerColumns.some((column) => column.name === 'contract_id')) {
    db.exec('ALTER TABLE webhook_recipe_triggers ADD COLUMN contract_id TEXT');
  }
  // D-201 Slice 10AF (10AE finding 1) — a door stamped before 10AF has no
  // record: 10AC wrote one only when an update dropped a recipe's door, after
  // its door step, and an update stopped before that lost it. Every recipe's
  // rows name their door now; it is newer than any record kept for it.
  db.exec(`
    INSERT INTO webhook_recipe_last_doors
      (consumer_kind, consumer_id, recipe_id, publisher_id, contract_id, updated_at)
    SELECT binding.consumer_kind, binding.consumer_id, trigger.recipe_id,
      trigger.publisher_id, trigger.contract_id, MAX(trigger.updated_at)
    FROM webhook_recipe_triggers trigger
    JOIN webhook_consumer_bindings binding ON binding.binding_id = trigger.binding_id
    WHERE trigger.contract_id IS NOT NULL
    GROUP BY binding.consumer_kind, binding.consumer_id, trigger.recipe_id, trigger.publisher_id
    ON CONFLICT (consumer_kind, consumer_id, recipe_id, publisher_id) DO UPDATE SET
      contract_id = excluded.contract_id, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= webhook_recipe_last_doors.updated_at
  `);
  migrateDispatchTableForWorker(db);
  // D-201 Slice 10B — a table made by 10A before dead letters could be closed.
  const dispatchColumns = db.prepare(
    'PRAGMA table_info(webhook_recipe_dispatches)',
  ).all() as Array<{ name: string }>;
  if (!dispatchColumns.some((column) => column.name === 'resolved_at')) {
    db.exec('ALTER TABLE webhook_recipe_dispatches ADD COLUMN resolved_at INTEGER');
  }
  // D-201 Slice 10E — a table from before a restart's stop was told apart.
  if (!dispatchColumns.some((column) => column.name === 'restart_interrupted_at')) {
    db.exec('ALTER TABLE webhook_recipe_dispatches ADD COLUMN restart_interrupted_at INTEGER');
  }
  // D-201 Slice 10N — a table from before the owner could rerun an in-doubt run.
  if (!dispatchColumns.some((column) => column.name === 'in_doubt_rerun_at')) {
    db.exec('ALTER TABLE webhook_recipe_dispatches ADD COLUMN in_doubt_rerun_at INTEGER');
  }
  ensureWebhookDeadLetterReviewSchema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_event
      ON webhook_recipe_dispatches(event_id, state, dispatch_id);
    -- THE TRIGGER-SCOPED INDEX. Six statements in this file read dispatches by
    --   trigger_id -- the consumer-uninstall cancel (three JOINs down from
    --   webhook_consumer_bindings) and the trigger-level cancel, which runs its
    --   three statements INSIDE A LOOP over the consumer's triggers. The only
    --   index above leads with event_id, so every one of them SCANNED the whole
    --   dispatch table, once per trigger.
    --
    -- This table grows with EVERY inbound webhook event (D-148 P9 posts
    --   straight to the server), so it is one of the ones with no natural
    --   ceiling. Measured at 200k dispatches across 2,000 triggers,
    --   uninstalling one consumer that owns 5 of them: 33.6ms -> 0.26ms (130x).
    --
    -- The state column is second because the cancel statements pair
    --   trigger_id = ? with state IN ('pending','running','dead_letter'); the
    --   plan becomes SEARCH ... (trigger_id=? AND state=?) rather than a seek
    --   plus a filter.
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_trigger
      ON webhook_recipe_dispatches(trigger_id, state);
    -- D-201 Slice 10A -- the worker's claim scan reads by state first (the
    --   finished rows are the bulk of this table and must stay out of the
    --   scan), and the per-recipe busy check reads one recipe's live claims.
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_claim
      ON webhook_recipe_dispatches(state, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_recipe
      ON webhook_recipe_dispatches(publisher_id, recipe_id, state);
    -- D-201 Slice 10E -- each recipe's queue in handoff order, holding only
    --   the rows that may still run: the claim scan reads one recipe's first
    --   runnable row from here instead of ranking every pending row (32 ms at
    --   30,003 pending rows, on every poll and every settle).
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_queue
      ON webhook_recipe_dispatches(publisher_id, recipe_id, created_at)
      WHERE state IN ('pending', 'running');
    -- D-201 Slice 10F -- the open and the closed dead letters on their own:
    --   the review limit counts the open ones on every worker poll, and a
    --   full scan grew with every dead letter ever closed (9.3 ms at 200,000).
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_open_dead_letters
      ON webhook_recipe_dispatches(updated_at, dispatch_id)
      WHERE state = 'dead_letter' AND resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_closed_dead_letters
      ON webhook_recipe_dispatches(updated_at, dispatch_id)
      WHERE state = 'dead_letter' AND resolved_at IS NOT NULL;
  `);
};

/** D-201 Slice 10F — a binding saved again continues the one it replaces when
 *  it is the same slot on the same webhook, matching the same deliveries, both
 *  switched on, and the saved recipe reads no more than before (the owner's
 *  rule): its payload access the same or `metadata_only`, its source truth the
 *  same or `provider_readback_required`. A continued binding, and each of its
 *  triggers for the same recipe and event type, keeps its `created_at`, so the
 *  deliveries it already had a right to (waiting ones and dead letters) go to
 *  the saved version. Any other save is new authority and, as before,
 *  inherits nothing. */
const bindingContinues = (prior: BindingSqlRow, next: BindingSqlRow): boolean =>
  prior.enabled === 1
  && next.enabled === 1
  && prior.logical_binding === next.logical_binding
  && prior.ingress_id === next.ingress_id
  && prior.required_profile_id === next.required_profile_id
  && prior.environment_policy === next.environment_policy
  && prior.registration_modes_json === next.registration_modes_json
  && prior.required_event_types_json === next.required_event_types_json
  && prior.paired_connection_required === next.paired_connection_required
  && (prior.decoded_payload_access === next.decoded_payload_access
    || next.decoded_payload_access === 'metadata_only')
  && (prior.source_truth_policy === next.source_truth_policy
    || next.source_truth_policy === 'provider_readback_required');

const defaultId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, '')}`;

const bindingFromSql = (row: BindingSqlRow): WebhookConsumerBindingRecord => ({
  binding_id: row.binding_id,
  consumer_kind: row.consumer_kind,
  consumer_id: row.consumer_id,
  logical_binding: row.logical_binding,
  ingress_id: row.ingress_id,
  required_profile_id:
    row.required_profile_id as WebhookConsumerBindingRecord['required_profile_id'],
  decoded_payload_access: row.decoded_payload_access,
  source_truth_policy: row.source_truth_policy,
  enabled: row.enabled === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const safeStringArray = (value: string, label: string): string[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)
      || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error('invalid');
    }
    return parsed.slice();
  } catch {
    throw new WebhookConsumerStoreError('corrupt', `${label} is corrupt`);
  }
};

const requireSafeIdentity = (value: string, label: string): void => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WebhookConsumerStoreError('invalid', `${label} has invalid shape`);
  }
};

/** D-201 Slice 10AF — a forgotten door read back from a stored prior: well
 *  formed, or skipped (an unreadable entry names no door to put back). */
const isRestorableLastDoor = (door: unknown): door is WebhookRecipeLastDoor => {
  if (door === null || typeof door !== 'object') return false;
  const entry = door as Record<string, unknown>;
  const safe = (value: unknown): boolean => typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
  return safe(entry.recipe_id) && safe(entry.publisher_id) && safe(entry.contract_id)
    && typeof entry.updated_at === 'number' && Number.isSafeInteger(entry.updated_at);
};

/** D-201 Slice 10AO — an answer read back from a stored prior: well formed, or
 *  skipped, as a forgotten door is. */
const isRestorableDoorAnswer = (answer: unknown): answer is WebhookRecipeDoorAnswer & { answered_at: number } => {
  if (answer === null || typeof answer !== 'object') return false;
  const entry = answer as Record<string, unknown>;
  const safe = (value: unknown): boolean => typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
  return safe(entry.recipe_id) && safe(entry.publisher_id)
    && (entry.door === 'open' || entry.door === 'closed')
    && typeof entry.answered_at === 'number' && Number.isSafeInteger(entry.answered_at) && entry.answered_at >= 0;
};

const strongerSourceTruth = (
  left: WebhookSourceTruthPolicy,
  right: WebhookSourceTruthPolicy,
): WebhookSourceTruthPolicy => left === 'provider_readback_required'
  || right === 'provider_readback_required'
  ? 'provider_readback_required'
  : 'delivery_payload_allowed';

export const createWebhookConsumerStore = (
  db: Database.Database,
  options: WebhookConsumerStoreOptions,
): WebhookConsumerStore => {
  createSchema(db);
  const now = options.now ?? Date.now;
  const newBindingId = options.newBindingId ?? (() => defaultId('whb'));
  const newTriggerId = options.newTriggerId ?? (() => defaultId('wht'));
  const newDispatchId = options.newDispatchId ?? (() => defaultId('whx'));
  const newRunId = options.newRunId ?? (() => defaultId('whr'));
  const newClaimToken = options.newClaimToken ?? (() => randomUUID());

  const bindingsForConsumer = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): BindingSqlRow[] => db.prepare(`
    SELECT * FROM webhook_consumer_bindings
    WHERE consumer_kind = ? AND consumer_id = ?
    ORDER BY logical_binding ASC, binding_id ASC
  `).all(consumerKind, consumerId) as BindingSqlRow[];

  const snapshotConsumer = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): WebhookConsumerSnapshot => {
    const bindings = bindingsForConsumer(consumerKind, consumerId);
    const bindingIds = new Set(bindings.map((row) => row.binding_id));
    const triggers = bindingIds.size === 0
      ? []
      : (db.prepare(`
          SELECT trigger.* FROM webhook_recipe_triggers trigger
          JOIN webhook_consumer_bindings binding
            ON binding.binding_id = trigger.binding_id
          WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
          ORDER BY trigger.binding_id ASC, trigger.recipe_id ASC,
            trigger.provider_event_type ASC, trigger.trigger_id ASC
        `).all(consumerKind, consumerId) as TriggerSqlRow[])
        .filter((row) => bindingIds.has(row.binding_id));
    return {
      consumer_kind: consumerKind,
      consumer_id: consumerId,
      bindings: bindings.map((row) => ({ ...row })),
      triggers: triggers.map((row) => ({ ...row })),
    };
  };

  /** D-201 Slice 6B3 audit fold — once an operation-bound ingress could have
   * attached its callback, deleting or moving the consumer row would delete
   * the only authority the workflow can use to detach known remote resources.
   * Keep that exact logical-binding/ingress pair until a later cleanup ledger
   * can prove completion. Draft/ready/verification-pending ingresses have never
   * crossed the attach gate and therefore need no tombstone. */
  const assertOperationBoundCleanupAuthorityRetained = (
    prior: readonly BindingSqlRow[],
    nextSelections: readonly WebhookIngressBindingSelection[] | null,
    nextEnabled: boolean | null,
  ): void => {
    const nextByBinding = new Map(
      (nextSelections ?? []).map((selection) => [
        selection.binding,
        selection.ingress_id,
      ] as const),
    );
    for (const row of prior) {
      const ingress = options.ingressStore.get(row.ingress_id);
      if (!ingress) {
        throw new WebhookConsumerStoreError(
          'corrupt',
          'webhook consumer references a missing ingress',
        );
      }
      const mayHaveAttached = ingress.registration_mode === 'operation_bound'
        && (ingress.intake_state === 'enabled'
          || ingress.intake_state === 'degraded'
          || ingress.intake_state === 'disabled');
      if (mayHaveAttached
        && nextByBinding.get(row.logical_binding) !== row.ingress_id) {
        throw new WebhookConsumerStoreError(
          'cleanup_required',
          `operation-bound binding '${row.logical_binding}' must remain available for remote resource cleanup`,
        );
      }
      if (mayHaveAttached && row.enabled === 0 && nextEnabled === true) {
        throw new WebhookConsumerStoreError(
          'cleanup_required',
          `operation-bound binding '${row.logical_binding}' was disarmed and may be re-enabled only by the explicit arm action`,
        );
      }
    }
  };

  const deleteConsumerRows = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): void => {
    db.prepare(`
      DELETE FROM webhook_recipe_triggers
      WHERE binding_id IN (
        SELECT binding_id FROM webhook_consumer_bindings
        WHERE consumer_kind = ? AND consumer_id = ?
      )
    `).run(consumerKind, consumerId);
    db.prepare(`
      DELETE FROM webhook_consumer_bindings
      WHERE consumer_kind = ? AND consumer_id = ?
    `).run(consumerKind, consumerId);
  };

  /** The delivery store's tables exist (they are made after this store's at
   *  boot; an isolated consumer-store harness has none). */
  const deliveryTablesPresent = (): boolean => db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'webhook_accepted_events'
  `).get() !== undefined;

  /** D-201 Slice 10F — Recued closes open target dead letters itself (their
   *  recipe removed, switched off or saved with a different webhook setup, or
   *  their webhook retired). A dead letter is never silently cancelled: it
   *  stays, closed, with a review record that says why, and its pin goes. */
  const closeDeadLetterTargets = (
    condition: string,
    params: readonly unknown[],
    reason: WebhookDeadLetterServerReason,
    stamp: number,
  ): number => {
    if (!deliveryTablesPresent()) return 0;
    const rows = db.prepare(`
      SELECT dispatch.dispatch_id, dispatch.event_id, dispatch.attempt_count,
        event.ingress_id AS ingress_id
      FROM webhook_recipe_dispatches dispatch
        INDEXED BY idx_webhook_recipe_dispatches_open_dead_letters
      JOIN webhook_accepted_events event ON event.event_id = dispatch.event_id
      WHERE dispatch.state = 'dead_letter' AND dispatch.resolved_at IS NULL
        AND ${condition}
    `).all(...params) as Array<{
      dispatch_id: string;
      event_id: string;
      attempt_count: number;
      ingress_id: string;
    }>;
    const close = db.prepare(`
      UPDATE webhook_recipe_dispatches SET resolved_at = ?, updated_at = ?
      WHERE dispatch_id = ? AND state = 'dead_letter' AND resolved_at IS NULL
    `);
    for (const row of rows) {
      if (close.run(stamp, stamp, row.dispatch_id).changes !== 1) continue;
      releaseTarget(row.dispatch_id);
      insertWebhookDeadLetterReview(db, {
        subject_kind: 'target',
        subject_id: row.dispatch_id,
        event_id: row.event_id,
        ingress_id: row.ingress_id,
        action: 'expire',
        actor_kind: 'server',
        actor_instance_id: null,
        reason,
        attempt_count: row.attempt_count,
        created_at: stamp,
      });
    }
    return rows.length;
  };

  const consumerTriggerCondition = `dispatch.trigger_id IN (
    SELECT trigger.trigger_id
    FROM webhook_recipe_triggers trigger
    JOIN webhook_consumer_bindings binding
      ON binding.binding_id = trigger.binding_id
    WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
  )`;

  const cancelConsumerDispatches = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    reason: WebhookDeadLetterServerReason,
  ): void => {
    const stamp = now();
    // Slice 10F — its open dead letters are closed with a record first; the
    // runs that were waiting or going are cancelled, as before.
    closeDeadLetterTargets(consumerTriggerCondition, [consumerKind, consumerId], reason, stamp);
    db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
        updated_at = ?
      WHERE (state IN ('pending', 'running')
          OR (state = 'dead_letter' AND resolved_at IS NULL))
        AND trigger_id IN (
          SELECT trigger.trigger_id
          FROM webhook_recipe_triggers trigger
          JOIN webhook_consumer_bindings binding
            ON binding.binding_id = trigger.binding_id
          WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
        )
    `).run(stamp, consumerKind, consumerId);
    db.prepare(`
      DELETE FROM webhook_payload_pins
      WHERE pin_id IN (
        SELECT dispatch.dispatch_id
        FROM webhook_recipe_dispatches dispatch
        JOIN webhook_recipe_triggers trigger
          ON trigger.trigger_id = dispatch.trigger_id
        JOIN webhook_consumer_bindings binding
          ON binding.binding_id = trigger.binding_id
        WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
      )
    `).run(consumerKind, consumerId);
    db.prepare(`
      DELETE FROM webhook_waiting_dispatches
      WHERE dispatch_id IN (
        SELECT dispatch.dispatch_id
        FROM webhook_recipe_dispatches dispatch
        JOIN webhook_recipe_triggers trigger
          ON trigger.trigger_id = dispatch.trigger_id
        JOIN webhook_consumer_bindings binding
          ON binding.binding_id = trigger.binding_id
        WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
      )
    `).run(consumerKind, consumerId);
  };

  const insertBinding = (row: BindingSqlRow): void => {
    db.prepare(`
      INSERT INTO webhook_consumer_bindings (
        binding_id, consumer_kind, consumer_id, logical_binding, ingress_id,
        required_profile_id, environment_policy, registration_modes_json,
        required_event_types_json, paired_connection_required,
        decoded_payload_access, source_truth_policy, enabled, created_at,
        updated_at
      ) VALUES (
        @binding_id, @consumer_kind, @consumer_id, @logical_binding, @ingress_id,
        @required_profile_id, @environment_policy, @registration_modes_json,
        @required_event_types_json, @paired_connection_required,
        @decoded_payload_access, @source_truth_policy, @enabled, @created_at,
        @updated_at
      )
    `).run(row);
  };

  const insertTrigger = (row: TriggerSqlRow): void => {
    db.prepare(`
      INSERT INTO webhook_recipe_triggers (
        trigger_id, binding_id, recipe_id, publisher_id,
        provider_event_type, contract_id, enabled, created_at, updated_at
      ) VALUES (
        @trigger_id, @binding_id, @recipe_id, @publisher_id,
        @provider_event_type, @contract_id, @enabled, @created_at, @updated_at
      )
    `).run(row);
  };

  const validateReplacement = (
    input: ReplaceWebhookConsumerInput,
  ): Array<{ binding: PackWebhookRequirement; selection: WebhookIngressBindingSelection }> => {
    if (input.consumer_kind !== 'pack_install'
      && input.consumer_kind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    requireSafeIdentity(input.consumer_id, 'consumer_id');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new WebhookConsumerStoreError('invalid', 'consumer enabled state is invalid');
    }
    const requirementIssues = validateWebhookRequirements(input.requirements);
    if (requirementIssues.length > 0) {
      const issue = requirementIssues[0]!;
      throw new WebhookConsumerStoreError(
        'invalid',
        `${issue.path}: ${issue.message}`,
      );
    }
    const selectionByBinding = new Map<string, WebhookIngressBindingSelection>();
    for (const selection of input.selections) {
      if (selection === null || typeof selection !== 'object'
        || Object.getPrototypeOf(selection) !== Object.prototype
        || Object.keys(selection).sort().join(',') !== 'binding,ingress_id'
        || typeof selection.binding !== 'string'
        || typeof selection.ingress_id !== 'string'
        || selection.binding.length === 0
        || selection.ingress_id.length === 0) {
        throw new WebhookConsumerStoreError('invalid', 'webhook binding selection is invalid');
      }
      requireSafeIdentity(selection.binding, 'logical binding');
      requireSafeIdentity(selection.ingress_id, 'ingress_id');
      if (selectionByBinding.has(selection.binding)) {
        throw new WebhookConsumerStoreError(
          'invalid',
          `duplicate webhook selection '${selection.binding}'`,
        );
      }
      selectionByBinding.set(selection.binding, selection);
    }
    if (selectionByBinding.size !== input.requirements.length) {
      throw new WebhookConsumerStoreError(
        'invalid',
        'every webhook requirement needs exactly one owner-selected ingress',
      );
    }

    const requirementByBinding = new Map(
      input.requirements.map((requirement) => [requirement.binding, requirement] as const),
    );
    const recipeIds = new Set<string>();
    for (const recipe of input.recipes) {
      requireSafeIdentity(recipe.recipe_id, 'recipe_id');
      requireSafeIdentity(recipe.publisher_id, 'publisher_id');
      const recipeKey = `${recipe.publisher_id}\u0000${recipe.recipe_id}`;
      if (recipeIds.has(recipeKey)) {
        throw new WebhookConsumerStoreError('invalid', 'duplicate webhook recipe identity');
      }
      recipeIds.add(recipeKey);
      const triggerIssues = [
        ...validateRecipeWebhookTriggers(recipe.webhook_triggers),
        ...validateWebhookTriggerBindings(input.requirements, recipe.webhook_triggers),
      ];
      if (triggerIssues.length > 0) {
        const issue = triggerIssues[0]!;
        throw new WebhookConsumerStoreError(
          'invalid',
          `recipe '${recipe.recipe_id}' ${issue.path}: ${issue.message}`,
        );
      }
    }

    const resolved: Array<{
      binding: PackWebhookRequirement;
      selection: WebhookIngressBindingSelection;
    }> = [];
    for (const [logicalBinding, selection] of selectionByBinding) {
      const requirement = requirementByBinding.get(logicalBinding);
      if (!requirement) {
        throw new WebhookConsumerStoreError(
          'invalid',
          `selection '${logicalBinding}' has no declared requirement`,
        );
      }
      const ingress = options.ingressStore.get(selection.ingress_id);
      if (!ingress) {
        throw new WebhookConsumerStoreError(
          'not_found',
          `selected webhook ingress '${selection.ingress_id}' was not found`,
        );
      }
      const unfit = webhookIngressUnfit(
        ingress,
        requirement,
        input.recipes.flatMap((recipe) => recipe.webhook_triggers),
      );
      if (unfit !== null) {
        throw new WebhookConsumerStoreError(
          unfit.code,
          unfit.code === 'not_ready' && unfit.reason === 'not_enabled'
            ? `selected webhook ingress '${selection.ingress_id}' is not enabled`
            : unfit.message,
        );
      }
      resolved.push({ binding: requirement, selection });
    }
    return resolved;
  };

  const bindingStampAfterAcceptedDeliveries = (observedStamp: number): number => {
    // Binding/event causality must not trust a wall clock that can step
    // backwards. The delivery table is composed after this store at boot, so
    // keep the lookup optional for isolated consumer-store harnesses; if it is
    // present, advance new authority strictly past every committed delivery.
    const deliveryTable = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'webhook_accepted_deliveries'
    `).get();
    if (!deliveryTable) return observedStamp;
    const row = db.prepare(`
      SELECT MAX(received_at) AS latest_received_at
      FROM webhook_accepted_deliveries
    `).get() as { latest_received_at: number | null };
    if (row.latest_received_at === null || row.latest_received_at < observedStamp) {
      return observedStamp;
    }
    if (row.latest_received_at >= Number.MAX_SAFE_INTEGER) {
      throw new WebhookConsumerStoreError(
        'conflict',
        'webhook delivery clock is exhausted; refusing to create retroactive authority',
      );
    }
    return row.latest_received_at + 1;
  };

  /** The binding row a requirement and its chosen ingress make: what
   *  `replaceConsumer` writes, and what `previewReplacement` compares. */
  const bindingRowFor = (input: {
    binding_id: string;
    consumer_kind: BindingSqlRow['consumer_kind'];
    consumer_id: string;
    binding: PackWebhookRequirement;
    ingress: NonNullable<ReturnType<WebhookIngressStore['get']>>;
    descriptor: NonNullable<ReturnType<typeof webhookProfile>>;
    enabled: boolean;
    stamp: number;
  }): BindingSqlRow => ({
    binding_id: input.binding_id,
    consumer_kind: input.consumer_kind,
    consumer_id: input.consumer_id,
    logical_binding: input.binding.binding,
    ingress_id: input.ingress.ingress_id,
    required_profile_id: input.ingress.profile_id,
    environment_policy: input.binding.environment_policy ?? 'any',
    registration_modes_json: JSON.stringify(
      input.binding.registration_modes ?? [input.ingress.registration_mode],
    ),
    required_event_types_json: JSON.stringify(
      input.binding.required_event_types ?? [],
    ),
    paired_connection_required:
      input.binding.paired_connection_slot !== undefined ? 1 : 0,
    decoded_payload_access: input.binding.decoded_payload_access,
    source_truth_policy: strongerSourceTruth(
      input.descriptor.minimum_source_truth_policy,
      input.binding.source_truth_policy,
    ),
    enabled: input.enabled ? 1 : 0,
    created_at: input.stamp,
    updated_at: input.stamp,
  });

  const previewReplacement: WebhookConsumerStore['previewReplacement'] = (
    input,
  ) => {
    const resolved = validateReplacement({ ...input, enabled: true });
    const prior = snapshotConsumer(input.consumer_kind, input.consumer_id);
    const next: BindingSqlRow[] = [];
    for (const { binding, selection } of resolved) {
      const ingress = options.ingressStore.get(selection.ingress_id);
      const descriptor = ingress ? webhookProfile(ingress.profile_id) : undefined;
      if (!ingress || !descriptor) {
        throw new WebhookConsumerStoreError('conflict', 'selected ingress is not available');
      }
      next.push(bindingRowFor({
        binding_id: 'preview',
        consumer_kind: input.consumer_kind,
        consumer_id: input.consumer_id,
        binding,
        ingress,
        descriptor,
        enabled: true,
        stamp: 0,
      }));
    }
    const widened: string[] = [];
    for (const row of next) {
      const before = prior.bindings.find((old) => old.logical_binding === row.logical_binding);
      if (row.decoded_payload_access !== 'metadata_only'
        && (before === undefined || before.decoded_payload_access === 'metadata_only')) {
        widened.push(`${row.logical_binding}:${row.decoded_payload_access}`);
      }
      if (row.source_truth_policy === 'delivery_payload_allowed'
        && before !== undefined
        && before.source_truth_policy === 'provider_readback_required') {
        widened.push(`${row.logical_binding}:delivery_payload_allowed`);
      }
    }
    // D-201 Slice 10S (10Q finding 4) — per trigger, as `replaceConsumer`
    // carries them: one continues when its binding does and the saved version
    // still takes its event, for the same recipe and publisher.
    const onBindings = new Map(prior.bindings
      .filter((binding) => binding.enabled === 1)
      .map((binding) => [binding.binding_id, binding]));
    const onTriggers = prior.triggers.filter((trigger) => onBindings.has(trigger.binding_id));
    const continues = (trigger: TriggerSqlRow): boolean => {
      const slot = next.find((row) => bindingContinues(onBindings.get(trigger.binding_id)!, row));
      return slot !== undefined && input.recipes.some((recipe) => recipe.recipe_id === trigger.recipe_id
        && recipe.publisher_id === trigger.publisher_id
        && recipe.webhook_triggers.some((declaration) => declaration.binding === slot.logical_binding
          && declaration.event_types.includes(trigger.provider_event_type)));
    };
    const history = onTriggers.length === 0
      ? 'none'
      : onTriggers.every(continues)
        ? 'kept'
        : 'closed';
    // D-201 Slice 10Y (10V finding 6) — and per trigger, so the question can
    // say which history closes and which stays.
    const triggers = onTriggers
      .map((trigger) => ({
        slot: onBindings.get(trigger.binding_id)!.logical_binding,
        event_type: trigger.provider_event_type,
        history: continues(trigger) ? 'kept' as const : 'closed' as const,
      }))
      .sort((left, right) => left.slot.localeCompare(right.slot) || left.event_type.localeCompare(right.event_type));
    return { history, widened: widened.sort(), triggers };
  };

  const replaceConsumer = (
    input: ReplaceWebhookConsumerInput,
  ): WebhookConsumerSnapshot => {
    const resolved = validateReplacement(input);
    for (const answer of input.door_answers ?? []) {
      requireSafeIdentity(answer.recipe_id, 'recipe_id');
      requireSafeIdentity(answer.publisher_id, 'publisher_id');
      if (answer.door !== 'open' && answer.door !== 'closed') {
        throw new WebhookConsumerStoreError('invalid', 'a door answer is open or closed');
      }
    }
    const enabled = input.enabled ?? true;
    let prior = snapshotConsumer(input.consumer_kind, input.consumer_id);
    assertOperationBoundCleanupAuthorityRetained(
      prior.bindings,
      input.selections,
      enabled,
    );
    const observedStamp = now();
    if (!Number.isSafeInteger(observedStamp) || observedStamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    const persist = db.transaction(() => {
      // D-201 Slice 10P — a replacement of this consumer that a process left
      // unfinished is finished first: its rows go to the triggers about to be
      // replaced, which this replacement then carries on as its prior.
      finishPendingReplacementWithin(input.consumer_kind, input.consumer_id, observedStamp, input.recipeRemains);
      // D-201 Slice 10AF (10AE finding 5) — the owner starts clean: what the
      // owner did to the doors it had is forgotten with this replacement, and
      // kept on its prior so an undo puts it back.
      // D-201 Slice 10AO (10AM finding 1) — the answers as they stand, on the
      // prior, whenever this replacement writes or forgets any: an undo puts
      // exactly these back, so an undone update leaves none of its own.
      const answersBefore = doorAnswersOf(input.consumer_kind, input.consumer_id);
      if (answersBefore.length > 0 || (input.door_answers ?? []).length > 0) {
        prior = { ...prior, door_answers: answersBefore };
      }
      if (input.forget_last_doors === true) {
        const forgotten = lastDoorsOf(input.consumer_kind, input.consumer_id);
        if (forgotten.length > 0) {
          db.prepare('DELETE FROM webhook_recipe_last_doors WHERE consumer_kind = ? AND consumer_id = ?')
            .run(input.consumer_kind, input.consumer_id);
          prior = { ...prior, last_doors: forgotten };
        }
        // D-201 Slice 10AO — and the switches the owner kept for its doors.
        db.prepare('DELETE FROM webhook_recipe_door_answers WHERE consumer_kind = ? AND consumer_id = ?')
          .run(input.consumer_kind, input.consumer_id);
      }
      // D-201 Slice 10AJ (10AI finding 1) — the owner's answers, kept with the
      // replacement they were given for.
      for (const answer of input.door_answers ?? []) {
        writeDoorAnswer(input.consumer_kind, input.consumer_id, answer, observedStamp);
      }
      // Disabled Kitchen replacements have no dispatch authority and will be
      // restamped by setConsumerEnabled(true). Do not let an exhausted or
      // future delivery clock block a revocation/disarmed save.
      const stamp = enabled
        ? bindingStampAfterAcceptedDeliveries(observedStamp)
        : observedStamp;
      deleteConsumerRows(input.consumer_kind, input.consumer_id);
      const bindingIdByName = new Map<string, string>();
      const continuedBindings = new Map<string, BindingSqlRow>();
      for (const { binding, selection } of resolved) {
        const ingress = options.ingressStore.get(selection.ingress_id);
        if (!ingress || ingress.intake_state !== 'enabled') {
          throw new WebhookConsumerStoreError(
            'conflict',
            'selected ingress changed before the binding transaction committed',
          );
        }
        const descriptor = webhookProfile(ingress.profile_id);
        if (!descriptor || !binding.profile_ids.includes(ingress.profile_id)) {
          throw new WebhookConsumerStoreError(
            'conflict',
            'selected ingress profile changed before binding commit',
          );
        }
        const bindingId = newBindingId();
        requireSafeIdentity(bindingId, 'binding_id');
        bindingIdByName.set(binding.binding, bindingId);
        const row = bindingRowFor({
          binding_id: bindingId,
          consumer_kind: input.consumer_kind,
          consumer_id: input.consumer_id,
          binding,
          ingress,
          descriptor,
          enabled,
          stamp,
        });
        // Slice 10F — the same slot with the same terms keeps its history.
        const continued = prior.bindings.find((old) => bindingContinues(old, row));
        if (continued !== undefined) continuedBindings.set(bindingId, continued);
        insertBinding({ ...row, created_at: continued?.created_at ?? stamp });
      }
      for (const recipe of input.recipes) {
        for (const declaration of recipe.webhook_triggers) {
          const bindingId = bindingIdByName.get(declaration.binding);
          if (!bindingId) {
            throw new WebhookConsumerStoreError(
              'invalid',
              `recipe '${recipe.recipe_id}' references an unbound webhook slot`,
            );
          }
          for (const eventType of declaration.event_types) {
            const triggerId = newTriggerId();
            requireSafeIdentity(triggerId, 'trigger_id');
            const continuedBinding = continuedBindings.get(bindingId);
            const continuedTrigger = continuedBinding === undefined
              ? undefined
              : prior.triggers.find((old) => old.binding_id === continuedBinding.binding_id
                && old.recipe_id === recipe.recipe_id
                && old.publisher_id === recipe.publisher_id
                && old.provider_event_type === eventType);
            insertTrigger({
              trigger_id: triggerId,
              binding_id: bindingId,
              recipe_id: recipe.recipe_id,
              publisher_id: recipe.publisher_id,
              provider_event_type: eventType,
              // The door is stamped AFTER the caller's cross-store save
              // succeeds (`stampTriggerContracts`) — never here, where a
              // failed save must be able to restore the prior rows without
              // an orphan mint. NULL rows deny at dispatch (fail-closed).
              contract_id: null,
              enabled: enabled ? 1 : 0,
              created_at: continuedTrigger?.created_at ?? stamp,
              updated_at: stamp,
            });
          }
        }
      }
      // D-201 Slice 10P (10L finding 6) — committed with the replacement: the
      // prior rows its finalize needs, should the process die before it.
      // D-201 Slice 10AF — and the doors it forgot, for the start's undo.
      // D-201 Slice 10AO — and the answers it changed.
      if (prior.triggers.length > 0 || prior.last_doors !== undefined || prior.door_answers !== undefined) {
        recordPendingReplacement(prior, observedStamp, input.prior_recipe_stamp ?? null);
      }
    });
    persist();
    return prior;
  };

  const removeConsumer = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    options: {
      readonly forget_last_doors?: boolean;
      readonly door_answers?: readonly WebhookRecipeDoorAnswer[];
    } = {},
  ): WebhookConsumerSnapshot => {
    requireSafeIdentity(consumerId, 'consumer_id');
    const prior = snapshotConsumer(consumerKind, consumerId);
    assertOperationBoundCleanupAuthorityRetained(prior.bindings, null, null);
    db.transaction(() => {
      // Once the owner explicitly unbinds this consumer, no active run may
      // read its payload. Cancel those claims and release their pins before
      // deleting the authority rows so a crashed run cannot retain decoded
      // bytes forever after its outbox item is otherwise resolved.
      cancelConsumerDispatches(consumerKind, consumerId, 'recipe_removed');
      deleteConsumerRows(consumerKind, consumerId);
      // D-201 Slice 10P — nothing left to finish: its rows go to the sweep.
      forgetPendingReplacement(consumerKind, consumerId);
      // D-201 Slice 10AX (10AS finding 12) — nor any answer or switch kept for
      // its doors, and, asked, nor the doors its recipes had last.
      db.prepare('DELETE FROM webhook_recipe_door_answers WHERE consumer_kind = ? AND consumer_id = ?')
        .run(consumerKind, consumerId);
      // D-201 Slice 10BE (10AY finding 3) — but the ones the caller says stand.
      for (const answer of (options.door_answers ?? []).filter(isRestorableDoorAnswer)) {
        writeDoorAnswer(consumerKind, consumerId, answer, answer.answered_at);
      }
      if (options.forget_last_doors === true) {
        db.prepare('DELETE FROM webhook_recipe_last_doors WHERE consumer_kind = ? AND consumer_id = ?')
          .run(consumerKind, consumerId);
      }
    })();
    return prior;
  };

  const restoreDoorAnswers: WebhookConsumerStore['restoreDoorAnswers'] = (consumerKind, consumerId, answers) => {
    requireSafeIdentity(consumerId, 'consumer_id');
    db.transaction(() => {
      db.prepare('DELETE FROM webhook_recipe_door_answers WHERE consumer_kind = ? AND consumer_id = ?')
        .run(consumerKind, consumerId);
      for (const answer of answers.filter(isRestorableDoorAnswer)) {
        writeDoorAnswer(consumerKind, consumerId, answer, answer.answered_at);
      }
    })();
  };

  /** D-201 Slice 10P — whether the delivery store's outbox is here: a
   *  consumer store opened alone has no events to hand off again. */
  const outboxTablePresent = (): boolean => db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_event_outbox'
  `).get() !== undefined;

  /** D-201 Slice 10U (10Q finding 22) — the index of the open event dead
   *  letters, named so a read of them never walks the closed ones. The
   *  delivery store makes it (Slice 10F); an outbox from before it reads
   *  without. */
  const openOutboxDeadLettersIndexed = (): string => db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_webhook_outbox_open_dead_letters'
  `).get() === undefined ? '' : 'INDEXED BY idx_webhook_outbox_open_dead_letters';

  /** The finalize itself, inside the caller's transaction (a save's finalize,
   *  a replacement finished at the start, or one finished before the next). */
  /** D-201 Slice 10F — the trigger a replacement continued `oldTrigger` with:
   *  the same slot with the same terms (`bindingContinues`), the same recipe and
   *  event type, and the history (`created_at`) the replace kept for it. The one
   *  rule both directions use: finalize moves rows along it, and the start's
   *  undo of a save that never committed moves them back (Slice 10X). */
  const continuationOf = (
    oldTrigger: TriggerSqlRow,
    priorBindings: ReadonlyMap<string, BindingSqlRow>,
    current: WebhookConsumerSnapshot,
  ): TriggerSqlRow | undefined => {
    const oldBinding = priorBindings.get(oldTrigger.binding_id);
    const newBinding = oldBinding === undefined
      ? undefined
      : current.bindings.find((row) => row.created_at === oldBinding.created_at
        && bindingContinues(oldBinding, row));
    return newBinding === undefined
      ? undefined
      : current.triggers.find((row) => row.binding_id === newBinding.binding_id
        && row.recipe_id === oldTrigger.recipe_id
        && row.publisher_id === oldTrigger.publisher_id
        && row.provider_event_type === oldTrigger.provider_event_type
        && row.created_at === oldTrigger.created_at);
  };

  /** D-201 Slice 10F — moves a trigger's rows onto another: what still waits
   *  (pending, running, an open dead letter) runs there, and an old event a
   *  replay already handed to `to` keeps that row (this one is cancelled).
   *  Slice 10I (10H finding 1) — the finished rows of an event the outbox can
   *  still hand off go too: the handoff finds a recipe's row by event and
   *  trigger, so a finished row left behind let a retried event hand `to` a new
   *  row and run a recipe that had already run, under a new run id. D-201 Slice
   *  10P (10L finding 8) — only for those events: moving all of a busy
   *  webhook's history took about a second at 200,000 rows. D-201 Slice 10U
   *  (10Q finding 22) — the dead letters from the index of the open ones only.
   *  Inside the caller's transaction. */
  const triggerRowMover = (): ((
    fromTriggerId: string,
    to: { readonly trigger_id: string; readonly binding_id: string },
    stamp: number,
  ) => void) => {
    const duplicatesOnTarget = db.prepare(`
      SELECT dispatch_id FROM webhook_recipe_dispatches
      WHERE trigger_id = ?
        AND (state IN ('pending', 'running')
          OR (state = 'dead_letter' AND resolved_at IS NULL))
        AND event_id IN (
          SELECT event_id FROM webhook_recipe_dispatches WHERE trigger_id = ?
        )
    `);
    const moveOpen = db.prepare(`
      UPDATE webhook_recipe_dispatches SET trigger_id = ?, binding_id = ?
      WHERE trigger_id = ?
        AND (state IN ('pending', 'running')
          OR (state = 'dead_letter' AND resolved_at IS NULL))
        AND event_id NOT IN (
          SELECT event_id FROM webhook_recipe_dispatches WHERE trigger_id = ?
        )
    `);
    const moveFinishedOfOpenEvents = outboxTablePresent() ? db.prepare(`
      UPDATE webhook_recipe_dispatches SET trigger_id = ?, binding_id = ?
      WHERE trigger_id = ?
        AND event_id IN (
          SELECT event_id FROM webhook_event_outbox
          WHERE state IN ('pending', 'leased')
          UNION ALL
          SELECT event_id FROM webhook_event_outbox ${openOutboxDeadLettersIndexed()}
          WHERE state = 'dead_letter' AND resolved_at IS NULL
        )
        AND event_id NOT IN (
          SELECT event_id FROM webhook_recipe_dispatches WHERE trigger_id = ?
        )
    `) : null;
    return (fromTriggerId, to, stamp) => {
      if (fromTriggerId === to.trigger_id) return;
      const duplicates = duplicatesOnTarget.all(fromTriggerId, to.trigger_id) as Array<{ dispatch_id: string }>;
      for (const duplicate of duplicates) cancelTarget(duplicate.dispatch_id, stamp);
      moveOpen.run(to.trigger_id, to.binding_id, fromTriggerId, to.trigger_id);
      moveFinishedOfOpenEvents?.run(to.trigger_id, to.binding_id, fromTriggerId, to.trigger_id);
    };
  };

  const finalizeWithin = (
    prior: WebhookConsumerSnapshot,
    stamp: number,
    recipeRemains?: FinalizeConsumerReplacementOptions['recipeRemains'],
  ): void => {
    const cancelDispatch = db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
        updated_at = ?
      WHERE trigger_id = ?
        AND (state IN ('pending', 'running')
          OR (state = 'dead_letter' AND resolved_at IS NULL))
    `);
    const releasePins = db.prepare(`
      DELETE FROM webhook_payload_pins
      WHERE pin_id IN (
        SELECT dispatch_id FROM webhook_recipe_dispatches WHERE trigger_id = ?
      )
    `);
    const releaseWaits = db.prepare(`
      DELETE FROM webhook_waiting_dispatches
      WHERE dispatch_id IN (
        SELECT dispatch_id FROM webhook_recipe_dispatches WHERE trigger_id = ?
      )
    `);
    const current = snapshotConsumer(prior.consumer_kind, prior.consumer_id);
    const priorBindings = new Map(prior.bindings.map((row) => [row.binding_id, row]));
    const move = triggerRowMover();
    for (const oldTrigger of prior.triggers) {
      requireSafeIdentity(oldTrigger.trigger_id, 'trigger_id');
      const continuation = continuationOf(oldTrigger, priorBindings, current);
      if (continuation !== undefined) {
        move(oldTrigger.trigger_id, continuation, stamp);
        continue;
      }
      // No continuation: its open dead letters are closed with a record that
      // says why, and the rest is cancelled, as before.
      const stillTaken = current.triggers.some((row) =>
        row.recipe_id === oldTrigger.recipe_id
        && row.publisher_id === oldTrigger.publisher_id
        && row.provider_event_type === oldTrigger.provider_event_type);
      // D-201 Slice 10S (10Q finding 4) — a recipe still there, saved without
      // this event or its webhook, was not removed: Settings said "Its recipe
      // was removed." of a recipe the owner had just saved.
      const remains = recipeRemains !== undefined
        ? recipeRemains(oldTrigger.recipe_id, oldTrigger.publisher_id)
        : current.triggers.some((row) =>
          row.recipe_id === oldTrigger.recipe_id && row.publisher_id === oldTrigger.publisher_id);
      const switchedOff = current.bindings.length > 0
        && current.bindings.every((row) => row.enabled === 0);
      closeDeadLetterTargets(
        'dispatch.trigger_id = ?',
        [oldTrigger.trigger_id],
        switchedOff ? 'recipe_disarmed' : stillTaken || remains ? 'recipe_replaced' : 'recipe_removed',
        stamp,
      );
      cancelDispatch.run(stamp, oldTrigger.trigger_id);
      releasePins.run(oldTrigger.trigger_id);
      releaseWaits.run(oldTrigger.trigger_id);
    }
  };

  /** D-201 Slice 10P — the record a replacement leaves until its finalize or
   *  restore, so the next start can finish it after a process died between. */
  const recordPendingReplacement = (
    prior: WebhookConsumerSnapshot,
    stamp: number,
    priorRecipeStamp: string | null,
  ): void => {
    db.prepare(`
      INSERT INTO webhook_consumer_replacements
        (consumer_kind, consumer_id, prior_json, created_at, prior_recipe_stamp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(consumer_kind, consumer_id) DO UPDATE SET
        prior_json = excluded.prior_json, created_at = excluded.created_at,
        prior_recipe_stamp = excluded.prior_recipe_stamp
    `).run(prior.consumer_kind, prior.consumer_id, JSON.stringify(prior), stamp, priorRecipeStamp);
  };

  const forgetPendingReplacement = (kind: WebhookConsumerKind, consumerId: string): void => {
    db.prepare(`
      DELETE FROM webhook_consumer_replacements WHERE consumer_kind = ? AND consumer_id = ?
    `).run(kind, consumerId);
  };

  /** A pending record's prior snapshot, or null when it cannot be read: it is
   *  then dropped, and its rows are left to the sweep as before. */
  const pendingPrior = (
    kind: WebhookConsumerKind,
    consumerId: string,
  ): WebhookConsumerSnapshot | null => {
    const row = db.prepare(`
      SELECT prior_json FROM webhook_consumer_replacements
      WHERE consumer_kind = ? AND consumer_id = ?
    `).get(kind, consumerId) as { prior_json: string } | undefined;
    if (row === undefined) return null;
    try {
      const parsed = JSON.parse(row.prior_json) as WebhookConsumerSnapshot;
      if (parsed === null || typeof parsed !== 'object'
        || parsed.consumer_kind !== kind || parsed.consumer_id !== consumerId
        || !Array.isArray(parsed.bindings) || !Array.isArray(parsed.triggers)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  /** Finish one consumer's pending replacement, inside the caller's
   *  transaction. Returns whether there was one. */
  const finishPendingReplacementWithin = (
    kind: WebhookConsumerKind,
    consumerId: string,
    stamp: number,
    recipeRemains?: FinalizeConsumerReplacementOptions['recipeRemains'],
  ): boolean => {
    const exists = db.prepare(`
      SELECT 1 FROM webhook_consumer_replacements WHERE consumer_kind = ? AND consumer_id = ?
    `).get(kind, consumerId) !== undefined;
    if (!exists) return false;
    const prior = pendingPrior(kind, consumerId);
    if (prior !== null && prior.triggers.length > 0) {
      try {
        // D-201 Slice 10U (10Q finding 23) — in its own savepoint. A record
        // that parses but cannot be finished (corruption, or one a newer
        // version wrote) is set aside, as an unreadable one is: before, it
        // failed every save of this consumer, across restarts.
        db.transaction(() => finalizeWithin(prior, stamp, recipeRemains))();
      } catch (error) {
        // D-201 Slice 10X (10V finding 27) — only a fault that will not pass:
        // a busy or failing disk fails this save, and the record stays.
        if (isPassingStoreFault(error)) throw error;
        // Its rows are left to the start's sweep.
      }
    }
    forgetPendingReplacement(kind, consumerId);
    return true;
  };

  const pendingReplacements: WebhookConsumerStore['pendingReplacements'] = () => {
    const pending = db.prepare(`
      SELECT consumer_kind, consumer_id, prior_recipe_stamp FROM webhook_consumer_replacements
      ORDER BY created_at, consumer_kind, consumer_id
    `).all() as Array<{
      consumer_kind: WebhookConsumerKind;
      consumer_id: string;
      prior_recipe_stamp: string | null;
    }>;
    return pending.map((row) => ({
      consumer_kind: row.consumer_kind,
      consumer_id: row.consumer_id,
      prior: pendingPrior(row.consumer_kind, row.consumer_id),
      current: snapshotConsumer(row.consumer_kind, row.consumer_id),
      prior_recipe_stamp: row.prior_recipe_stamp ?? null,
    }));
  };

  const setAsidePendingReplacement: WebhookConsumerStore['setAsidePendingReplacement'] = (
    consumerKind,
    consumerId,
  ) => {
    if (consumerKind !== 'pack_install' && consumerKind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    forgetPendingReplacement(consumerKind, consumerId);
  };

  /** D-201 Slice 10U — the trigger ids replacements still under way detached:
   *  their rows wait for that replacement's finalize or restore, or, should
   *  its process die, for the next start's finish. Never the sweep's. */
  const detachedByPendingReplacements = (): string[] => {
    const rows = db.prepare(`SELECT prior_json FROM webhook_consumer_replacements`)
      .all() as Array<{ prior_json: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      try {
        const prior = JSON.parse(row.prior_json) as { triggers?: unknown };
        if (!Array.isArray(prior.triggers)) continue;
        for (const trigger of prior.triggers) {
          const id = (trigger as { trigger_id?: unknown } | null)?.trigger_id;
          if (typeof id === 'string') ids.push(id);
        }
      } catch {
        // An unreadable record names no rows; the start sets it aside.
      }
    }
    return ids;
  };

  const finalizeConsumerReplacement = (
    prior: WebhookConsumerSnapshot,
    options: FinalizeConsumerReplacementOptions = {},
  ): void => {
    if (prior.consumer_kind !== 'pack_install'
      && prior.consumer_kind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    requireSafeIdentity(prior.consumer_id, 'consumer_id');
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    db.transaction(() => {
      if (prior.triggers.length > 0) finalizeWithin(prior, stamp, options.recipeRemains);
      // This replacement's own record only: a later one's is its finalize's.
      db.prepare(`
        DELETE FROM webhook_consumer_replacements
        WHERE consumer_kind = ? AND consumer_id = ? AND prior_json = ?
      `).run(prior.consumer_kind, prior.consumer_id, JSON.stringify(prior));
    })();
  };

  /** D-201 Slice 10X (10V finding 31) — the rows a replacement made go back to
   *  the trigger it continued (`continuationOf`, finalize's own rule run the
   *  other way), before the restore cancels what is left: what waits runs on the
   *  restored trigger, under the door it had, and a finished row of an event the
   *  outbox can still hand off goes with it. A row whose trigger continued none
   *  (another webhook, other terms) is cancelled by the restore, as before.
   *  Inside its transaction. */
  const carryOpenRowsBack = (snapshot: WebhookConsumerSnapshot): void => {
    const current = snapshotConsumer(snapshot.consumer_kind, snapshot.consumer_id);
    const priorBindings = new Map(snapshot.bindings.map((row) => [row.binding_id, row]));
    const move = triggerRowMover();
    const stamp = now();
    for (const oldTrigger of snapshot.triggers) {
      requireSafeIdentity(oldTrigger.trigger_id, 'trigger_id');
      const continuation = continuationOf(oldTrigger, priorBindings, current);
      if (continuation === undefined) continue;
      move(continuation.trigger_id, oldTrigger, stamp);
    }
  };

  const restoreConsumer: WebhookConsumerStore['restoreConsumer'] = (snapshot, options = {}) => {
    requireSafeIdentity(snapshot.consumer_id, 'consumer_id');
    const restore = db.transaction(() => {
      if (options.carryOpenRows === true) carryOpenRowsBack(snapshot);
      // Any run created under the attempted replacement must lose authority
      // before the prior snapshot is restored. Dispatches belonging to the
      // prior snapshot were detached (not cancelled) by replaceConsumer and
      // regain their exact trigger ids below.
      cancelConsumerDispatches(snapshot.consumer_kind, snapshot.consumer_id, 'recipe_replaced');
      deleteConsumerRows(snapshot.consumer_kind, snapshot.consumer_id);
      for (const row of snapshot.bindings) insertBinding({ ...row });
      for (const row of snapshot.triggers) insertTrigger({ ...row });
      // D-201 Slice 10AF (10AE finding 5) — and the doors it forgot.
      // D-201 Slice 10AJ — oldest first, so the newest stays the newest.
      const restorable = (Array.isArray(snapshot.last_doors) ? snapshot.last_doors : [])
        .filter(isRestorableLastDoor)
        .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0) || left.updated_at - right.updated_at);
      for (const door of restorable) {
        writeLastDoor(snapshot.consumer_kind, snapshot.consumer_id, door);
      }
      // D-201 Slice 10AO (10AM finding 1) — and the answers as they stood:
      // the undone replacement's own go with it. An undone update kept them,
      // and the next update from that publisher applied one over a switch the
      // owner made since.
      if (Array.isArray(snapshot.door_answers)) {
        db.prepare('DELETE FROM webhook_recipe_door_answers WHERE consumer_kind = ? AND consumer_id = ?')
          .run(snapshot.consumer_kind, snapshot.consumer_id);
        for (const answer of snapshot.door_answers.filter(isRestorableDoorAnswer)) {
          writeDoorAnswer(snapshot.consumer_kind, snapshot.consumer_id, answer, answer.answered_at);
        }
      }
      // D-201 Slice 10P — the replacement is undone: nothing to finish.
      forgetPendingReplacement(snapshot.consumer_kind, snapshot.consumer_id);
    });
    restore();
  };

  const bindingIsArmable = (row: BindingSqlRow): boolean => {
    const ingress = options.ingressStore.get(row.ingress_id);
    if (!ingress
      || ingress.intake_state !== 'enabled'
      || ingress.profile_id !== row.required_profile_id) {
      return false;
    }
    const requiredEvents = safeStringArray(
      row.required_event_types_json,
      `webhook binding '${row.binding_id}' required events`,
    );
    const registrationModes = safeStringArray(
      row.registration_modes_json,
      `webhook binding '${row.binding_id}' registration modes`,
    ) as WebhookRegistrationMode[];
    const triggerEvents = db.prepare(`
      SELECT provider_event_type FROM webhook_recipe_triggers
      WHERE binding_id = ?
    `).all(row.binding_id) as Array<{ provider_event_type: string }>;
    return registrationModes.includes(ingress.registration_mode)
      && requiredEvents.every((eventType) =>
        ingress.selected_event_types.includes(eventType))
      && triggerEvents.every(({ provider_event_type }) =>
        ingress.selected_event_types.includes(provider_event_type))
      && !(row.environment_policy === 'test_only' && ingress.environment !== 'test')
      && !(row.environment_policy === 'live_only' && ingress.environment !== 'live')
      && !(row.environment_policy === 'match_connection'
        && ingress.paired_connection_id === null)
      && !(row.paired_connection_required === 1
        && ingress.paired_connection_id === null);
  };

  const consumerStateMatches = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    enabled: boolean,
  ): boolean => {
    const bindings = bindingsForConsumer(consumerKind, consumerId);
    if (bindings.length === 0
      || bindings.some((row) => (row.enabled === 1) !== enabled)) {
      return false;
    }
    const triggers = db.prepare(`
      SELECT trigger.enabled FROM webhook_recipe_triggers trigger
      JOIN webhook_consumer_bindings binding
        ON binding.binding_id = trigger.binding_id
      WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
    `).all(consumerKind, consumerId) as Array<{ enabled: number }>;
    return triggers.every((row) => (row.enabled === 1) === enabled);
  };

  const setConsumerEnabled: WebhookConsumerStore['setConsumerEnabled'] = (
    consumerKind,
    consumerId,
    enabled,
  ) => {
    if (consumerKind !== 'pack_install' && consumerKind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    requireSafeIdentity(consumerId, 'consumer_id');
    const current = bindingsForConsumer(consumerKind, consumerId);
    if (current.length === 0) {
      throw new WebhookConsumerStoreError('not_found', 'webhook consumer has no bindings');
    }
    if (enabled && current.some((row) => !bindingIsArmable(row))) {
      throw new WebhookConsumerStoreError(
        'not_ready',
        'one or more selected webhook ingresses are no longer ready',
      );
    }
    // Repeated arm is idempotent only after revalidation. Otherwise an ingress
    // disabled since the first arm could make a stale owner action appear to
    // succeed even though no current binding is runnable.
    if (consumerStateMatches(consumerKind, consumerId, enabled)) return;
    const observedStamp = now();
    if (!Number.isSafeInteger(observedStamp) || observedStamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    db.transaction(() => {
      const rows = bindingsForConsumer(consumerKind, consumerId);
      if (rows.length === 0) {
        throw new WebhookConsumerStoreError('conflict', 'webhook consumer changed');
      }
      if (enabled && rows.some((row) => !bindingIsArmable(row))) {
        throw new WebhookConsumerStoreError(
          'conflict',
          'selected webhook ingress changed before arming committed',
        );
      }
      if (!enabled) cancelConsumerDispatches(consumerKind, consumerId, 'recipe_disarmed');
      const stamp = enabled
        ? bindingStampAfterAcceptedDeliveries(observedStamp)
        : observedStamp;
      db.prepare(`
        UPDATE webhook_consumer_bindings SET
          enabled = ?,
          created_at = CASE WHEN ? = 1 THEN ? ELSE created_at END,
          updated_at = ?
        WHERE consumer_kind = ? AND consumer_id = ?
      `).run(
        enabled ? 1 : 0,
        enabled ? 1 : 0,
        stamp,
        stamp,
        consumerKind,
        consumerId,
      );
      db.prepare(`
        UPDATE webhook_recipe_triggers SET
          enabled = ?,
          created_at = CASE WHEN ? = 1 THEN ? ELSE created_at END,
          updated_at = ?
        WHERE binding_id IN (
          SELECT binding_id FROM webhook_consumer_bindings
          WHERE consumer_kind = ? AND consumer_id = ?
        )
      `).run(
        enabled ? 1 : 0,
        enabled ? 1 : 0,
        stamp,
        stamp,
        consumerKind,
        consumerId,
      );
    })();
  };

  const requireConsumerKind = (kind: string): void => {
    if (kind !== 'pack_install' && kind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
  };

  const writeLastDoor = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    door: WebhookRecipeLastDoor,
  ): void => {
    // D-201 Slice 10AJ (10AI finding 7) — each write is the newest, whatever
    // the clock says: ordered by `updated_at`, a clock set back made an older
    // door the newest, and a closed one opened.
    db.prepare(`
      INSERT INTO webhook_recipe_last_doors
        (consumer_kind, consumer_id, recipe_id, publisher_id, contract_id, updated_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM webhook_recipe_last_doors))
      ON CONFLICT (consumer_kind, consumer_id, recipe_id, publisher_id) DO UPDATE SET
        contract_id = excluded.contract_id, updated_at = excluded.updated_at, seq = excluded.seq
    `).run(consumerKind, consumerId, door.recipe_id, door.publisher_id, door.contract_id, door.updated_at);
  };

  const rememberRecipeDoor: WebhookConsumerStore['rememberRecipeDoor'] = (input) => {
    requireConsumerKind(input.consumer_kind);
    requireSafeIdentity(input.consumer_id, 'consumer_id');
    requireSafeIdentity(input.recipe_id, 'recipe_id');
    requireSafeIdentity(input.publisher_id, 'publisher_id');
    requireSafeIdentity(input.contract_id, 'contract_id');
    writeLastDoor(input.consumer_kind, input.consumer_id, {
      recipe_id: input.recipe_id,
      publisher_id: input.publisher_id,
      contract_id: input.contract_id,
      updated_at: now(),
    });
  };

  const lastDoorsOf = (consumerKind: WebhookConsumerKind, consumerId: string): WebhookRecipeLastDoor[] =>
    db.prepare(`
      SELECT recipe_id, publisher_id, contract_id, updated_at, seq FROM webhook_recipe_last_doors
      WHERE consumer_kind = ? AND consumer_id = ?
      ORDER BY recipe_id, publisher_id
    `).all(consumerKind, consumerId) as WebhookRecipeLastDoor[];

  const newestRecipeDoor: WebhookConsumerStore['newestRecipeDoor'] = (
    consumerKind,
    consumerId,
    recipeId,
  ) => {
    const row = db.prepare(`
      SELECT publisher_id, contract_id FROM webhook_recipe_last_doors
      WHERE consumer_kind = ? AND consumer_id = ? AND recipe_id = ?
      ORDER BY seq DESC, updated_at DESC, publisher_id
      LIMIT 1
    `).get(consumerKind, consumerId, recipeId) as
      { publisher_id: string; contract_id: string } | undefined;
    return row ?? null;
  };

  const lastRecipeDoor: WebhookConsumerStore['lastRecipeDoor'] = (
    consumerKind,
    consumerId,
    recipeId,
    publisherId,
  ) => {
    const row = db.prepare(`
      SELECT contract_id FROM webhook_recipe_last_doors
      WHERE consumer_kind = ? AND consumer_id = ? AND recipe_id = ? AND publisher_id = ?
    `).get(consumerKind, consumerId, recipeId, publisherId) as { contract_id: string } | undefined;
    return row?.contract_id ?? null;
  };

  const forgetRecipeDoors: WebhookConsumerStore['forgetRecipeDoors'] = (consumerKind, consumerId) => {
    requireConsumerKind(consumerKind);
    db.transaction(() => {
      db.prepare('DELETE FROM webhook_recipe_last_doors WHERE consumer_kind = ? AND consumer_id = ?')
        .run(consumerKind, consumerId);
      db.prepare('DELETE FROM webhook_recipe_door_answers WHERE consumer_kind = ? AND consumer_id = ?')
        .run(consumerKind, consumerId);
    })();
  };

  const doorAnswerFor: WebhookConsumerStore['doorAnswerFor'] = (
    consumerKind,
    consumerId,
    recipeId,
  ) => {
    const row = db.prepare(`
      SELECT door FROM webhook_recipe_door_answers
      WHERE consumer_kind = ? AND consumer_id = ? AND recipe_id = ?
    `).get(consumerKind, consumerId, recipeId) as { door: string } | undefined;
    return row?.door === 'open' || row?.door === 'closed' ? row.door : null;
  };

  const writeDoorAnswer = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
    answer: WebhookRecipeDoorAnswer,
    answeredAt: number,
  ): void => {
    db.prepare(`
      INSERT INTO webhook_recipe_door_answers
        (consumer_kind, consumer_id, recipe_id, publisher_id, door, answered_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (consumer_kind, consumer_id, recipe_id) DO UPDATE SET
        publisher_id = excluded.publisher_id, door = excluded.door, answered_at = excluded.answered_at
    `).run(consumerKind, consumerId, answer.recipe_id, answer.publisher_id, answer.door, answeredAt);
  };

  const doorAnswersOf = (consumerKind: WebhookConsumerKind, consumerId: string): WebhookRecipeDoorAnswer[] =>
    (db.prepare(`
      SELECT recipe_id, publisher_id, door, answered_at FROM webhook_recipe_door_answers
      WHERE consumer_kind = ? AND consumer_id = ?
      ORDER BY recipe_id
    `).all(consumerKind, consumerId) as Array<{ recipe_id: string; publisher_id: string; door: string; answered_at: number }>)
      .filter((row) => row.door === 'open' || row.door === 'closed')
      .map((row) => ({
        recipe_id: row.recipe_id,
        publisher_id: row.publisher_id,
        door: row.door as 'open' | 'closed',
        answered_at: row.answered_at,
      }));

  const keepOwnerDoorDecision: WebhookConsumerStore['keepOwnerDoorDecision'] = (
    consumerKind,
    consumerId,
    recipeId,
    publisherId,
    door,
  ) => {
    requireConsumerKind(consumerKind);
    requireSafeIdentity(consumerId, 'consumer_id');
    requireSafeIdentity(recipeId, 'recipe_id');
    requireSafeIdentity(publisherId, 'publisher_id');
    if (door !== 'open' && door !== 'closed') {
      throw new WebhookConsumerStoreError('invalid', 'a door answer is open or closed');
    }
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    db.transaction(() => {
      if (doorContractIdForRecipe(consumerKind, consumerId, recipeId, publisherId) !== null) {
        db.prepare(`
          DELETE FROM webhook_recipe_door_answers
          WHERE consumer_kind = ? AND consumer_id = ? AND recipe_id = ?
        `).run(consumerKind, consumerId, recipeId);
        return;
      }
      writeDoorAnswer(consumerKind, consumerId, { recipe_id: recipeId, publisher_id: publisherId, door }, stamp);
    })();
  };

  const stampTriggerContracts: WebhookConsumerStore['stampTriggerContracts'] = (
    input,
  ) => {
    if (input.consumer_kind !== 'pack_install'
      && input.consumer_kind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    requireSafeIdentity(input.consumer_id, 'consumer_id');
    requireSafeIdentity(input.recipe_id, 'recipe_id');
    requireSafeIdentity(input.publisher_id, 'publisher_id');
    requireSafeIdentity(input.contract_id, 'contract_id');
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    // D-201 Slice 10AF (10AE findings 1 and 5) — the door the rows carry is
    // the recipe's last, kept with them in one transaction. 10AC wrote it once,
    // at the end of an update's door step, best effort: an update that died
    // first, the start's finish of it, a failed write or a fault lost it, and
    // the webhook taken back got a door with everything granted. A newer door
    // the switch or a save makes replaces it here too, so an older one is
    // never applied over the owner's latest decision.
    return db.transaction(() => {
      const updated = db.prepare(`
        UPDATE webhook_recipe_triggers SET
          contract_id = ?, updated_at = ?
        WHERE recipe_id = ? AND publisher_id = ?
          AND binding_id IN (
            SELECT binding_id FROM webhook_consumer_bindings
            WHERE consumer_kind = ? AND consumer_id = ?
          )
      `).run(
        input.contract_id,
        stamp,
        input.recipe_id,
        input.publisher_id,
        input.consumer_kind,
        input.consumer_id,
      );
      if (updated.changes > 0) {
        writeLastDoor(input.consumer_kind, input.consumer_id, {
          recipe_id: input.recipe_id,
          publisher_id: input.publisher_id,
          contract_id: input.contract_id,
          updated_at: stamp,
        });
        // D-201 Slice 10AJ (10AI finding 1) — that door now carries the owner's
        // answer for it, in the same transaction.
        // D-201 Slice 10AO (10AM finding 1) — any answer for that recipe,
        // whatever its publisher: a door is made, so it is the state. Only the
        // same publisher's went, so a pack that went back to its first
        // publisher kept the other's answer, which the next update from it
        // applied over the door the owner had opened since.
        db.prepare(`
          DELETE FROM webhook_recipe_door_answers
          WHERE consumer_kind = ? AND consumer_id = ? AND recipe_id = ?
        `).run(input.consumer_kind, input.consumer_id, input.recipe_id);
      }
      return updated.changes;
    })();
  };

  const clearTriggerContracts: WebhookConsumerStore['clearTriggerContracts'] = (
    input,
  ) => {
    if (input.consumer_kind !== 'pack_install'
      && input.consumer_kind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    requireSafeIdentity(input.consumer_id, 'consumer_id');
    requireSafeIdentity(input.recipe_id, 'recipe_id');
    requireSafeIdentity(input.publisher_id, 'publisher_id');
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    const updated = db.prepare(`
      UPDATE webhook_recipe_triggers SET
        contract_id = NULL, updated_at = ?
      WHERE recipe_id = ? AND publisher_id = ? AND contract_id IS NOT NULL
        AND binding_id IN (
          SELECT binding_id FROM webhook_consumer_bindings
          WHERE consumer_kind = ? AND consumer_id = ?
        )
    `).run(
      stamp,
      input.recipe_id,
      input.publisher_id,
      input.consumer_kind,
      input.consumer_id,
    );
    return updated.changes;
  };

  const doorContractIdForRecipe: WebhookConsumerStore['doorContractIdForRecipe'] = (
    consumerKind,
    consumerId,
    recipeId,
    publisherId,
  ) => {
    requireSafeIdentity(consumerId, 'consumer_id');
    requireSafeIdentity(recipeId, 'recipe_id');
    requireSafeIdentity(publisherId, 'publisher_id');
    const rows = db.prepare(`
      SELECT DISTINCT trigger.contract_id AS contract_id
      FROM webhook_recipe_triggers trigger
      JOIN webhook_consumer_bindings binding
        ON binding.binding_id = trigger.binding_id
      WHERE binding.consumer_kind = ? AND binding.consumer_id = ?
        AND trigger.recipe_id = ? AND trigger.publisher_id = ?
    `).all(consumerKind, consumerId, recipeId, publisherId) as
      Array<{ contract_id: string | null }>;
    if (rows.length !== 1) return null;
    return rows[0]!.contract_id;
  };

  const currentDoorForRun: WebhookConsumerStore['currentDoorForRun'] = (runId) => {
    const row = db.prepare(`
      SELECT trigger.contract_id AS contract_id
      FROM webhook_recipe_dispatches dispatch
      JOIN webhook_recipe_triggers trigger ON trigger.trigger_id = dispatch.trigger_id
      WHERE dispatch.run_id = ?
    `).get(runId) as { contract_id: string | null } | undefined;
    return row?.contract_id ?? null;
  };

  const doorOwnerOfRun: WebhookConsumerStore['doorOwnerOfRun'] = (runId) => {
    const row = db.prepare(`
      SELECT binding.consumer_kind AS consumer_kind, binding.consumer_id AS consumer_id,
        trigger.recipe_id AS recipe_id, trigger.publisher_id AS publisher_id
      FROM webhook_recipe_dispatches dispatch
      JOIN webhook_recipe_triggers trigger ON trigger.trigger_id = dispatch.trigger_id
      JOIN webhook_consumer_bindings binding ON binding.binding_id = trigger.binding_id
      WHERE dispatch.run_id = ?
      LIMIT 1
    `).get(runId) as {
      consumer_kind: string;
      consumer_id: string;
      recipe_id: string;
      publisher_id: string;
    } | undefined;
    if (row === undefined || (row.consumer_kind !== 'pack_install' && row.consumer_kind !== 'local_recipe')) return null;
    return { ...row, consumer_kind: row.consumer_kind };
  };

  const recipesWithTriggers: WebhookConsumerStore['recipesWithTriggers'] = () =>
    (db.prepare('SELECT DISTINCT recipe_id FROM webhook_recipe_triggers ORDER BY recipe_id ASC')
      .all() as Array<{ recipe_id: string }>).map((row) => row.recipe_id);

  const consumersOfRecipe: WebhookConsumerStore['consumersOfRecipe'] = (recipeId) => {
    requireSafeIdentity(recipeId, 'recipe_id');
    const owners = db.prepare(`
      SELECT DISTINCT binding.consumer_kind AS consumer_kind,
        binding.consumer_id AS consumer_id, trigger.publisher_id AS publisher_id
      FROM webhook_recipe_triggers trigger
      JOIN webhook_consumer_bindings binding
        ON binding.binding_id = trigger.binding_id
      WHERE trigger.recipe_id = ?
      ORDER BY binding.consumer_kind ASC, binding.consumer_id ASC, trigger.publisher_id ASC
    `).all(recipeId) as Array<{
      consumer_kind: WebhookConsumerKind;
      consumer_id: string;
      publisher_id: string;
    }>;
    return owners.map((owner) => {
      const whole = snapshotConsumer(owner.consumer_kind, owner.consumer_id);
      return {
        ...owner,
        snapshot: {
          ...whole,
          triggers: whole.triggers.filter((row) =>
            row.recipe_id === recipeId && row.publisher_id === owner.publisher_id),
        },
      };
    });
  };

  const targetRows = (
    ingressId: string,
    providerEventType: string,
  ): TargetSqlRow[] => db.prepare(`
    SELECT
      trigger.trigger_id,
      trigger.binding_id,
      trigger.recipe_id,
      trigger.publisher_id,
      trigger.provider_event_type,
      trigger.contract_id,
      trigger.created_at AS trigger_created_at,
      binding.consumer_kind,
      binding.consumer_id,
      binding.logical_binding,
      binding.ingress_id,
      binding.required_profile_id,
      binding.environment_policy,
      binding.registration_modes_json,
      binding.required_event_types_json,
      binding.paired_connection_required,
      binding.decoded_payload_access,
      binding.source_truth_policy,
      binding.created_at AS binding_created_at,
      recipe.pack_slug AS recipe_pack_slug
    FROM webhook_recipe_triggers trigger
    JOIN webhook_consumer_bindings binding
      ON binding.binding_id = trigger.binding_id
    JOIN recipes recipe
      ON recipe.recipe_id = trigger.recipe_id
      AND recipe.publisher_id = trigger.publisher_id
    WHERE binding.ingress_id = ?
      AND trigger.provider_event_type = ?
      AND binding.enabled = 1
      AND trigger.enabled = 1
      AND (
        (binding.consumer_kind = 'pack_install'
          AND recipe.pack_slug = binding.consumer_id)
        OR
        (binding.consumer_kind = 'local_recipe'
          AND recipe.recipe_id = binding.consumer_id
          AND recipe.pack_slug IS NULL)
      )
    ORDER BY binding.logical_binding ASC, trigger.recipe_id ASC,
      trigger.publisher_id ASC, trigger.trigger_id ASC
  `).all(ingressId, providerEventType) as TargetSqlRow[];

  const targetIsCurrent = (
    row: TargetSqlRow,
    ingressId: string,
    providerEventType: string,
    acceptedAt?: number,
  ): boolean => {
    // A binding installed after this delivery was accepted must not inherit
    // historical work merely because another consumer caused the event outbox
    // row to exist. Replacement can safely drop outstanding work; it cannot
    // widen it to a newly approved consumer retroactively. Binding creation
    // advances past the latest committed delivery even when the wall clock
    // moves backwards; millisecond ties also fail closed.
    if (acceptedAt !== undefined
      && (row.binding_created_at >= acceptedAt || row.trigger_created_at >= acceptedAt)) {
      return false;
    }
    const ingress = options.ingressStore.get(ingressId);
    if (!ingress
      || (ingress.intake_state !== 'enabled' && ingress.intake_state !== 'degraded')
      || ingress.profile_id !== row.required_profile_id
      || !ingress.selected_event_types.includes(providerEventType)) {
      return false;
    }
    const requiredEvents = safeStringArray(
      row.required_event_types_json,
      `webhook binding '${row.binding_id}' required events`,
    );
    if (requiredEvents.some((eventType) =>
      !ingress.selected_event_types.includes(eventType))) {
      return false;
    }
    const registrationModes = safeStringArray(
      row.registration_modes_json,
      `webhook binding '${row.binding_id}' registration modes`,
    ) as WebhookRegistrationMode[];
    if (!registrationModes.includes(ingress.registration_mode)) return false;
    if ((row.environment_policy === 'test_only' && ingress.environment !== 'test')
      || (row.environment_policy === 'live_only' && ingress.environment !== 'live')
      || (row.environment_policy === 'match_connection'
        && ingress.paired_connection_id === null)
      || (row.paired_connection_required === 1
        && ingress.paired_connection_id === null)) {
      return false;
    }
    return true;
  };

  const currentTargets = (
    ingressId: string,
    providerEventType: string,
    acceptedAt?: number,
  ): TargetSqlRow[] => targetRows(ingressId, providerEventType)
    .filter((row) => targetIsCurrent(
      row,
      ingressId,
      providerEventType,
      acceptedAt,
    ));

  const preparedFrom = (
    dispatch: DispatchSqlRow,
    target: TargetSqlRow,
  ): WebhookPreparedDispatch => ({
    dispatch_id: dispatch.dispatch_id,
    run_id: dispatch.run_id,
    state: dispatch.state === 'running'
      && db.prepare(`
        SELECT 1 FROM webhook_waiting_dispatches
        WHERE dispatch_id = ? AND run_id = ?
      `).get(dispatch.dispatch_id, dispatch.run_id) !== undefined
      ? 'awaiting_approval'
      : dispatch.state,
    trigger_id: target.trigger_id,
    binding_id: target.binding_id,
    recipe_id: target.recipe_id,
    publisher_id: target.publisher_id,
    contract_id: target.contract_id,
    logical_binding: target.logical_binding,
    ingress_id: target.ingress_id,
    decoded_payload_access: target.decoded_payload_access,
    source_truth_policy: target.source_truth_policy,
  });

  /** D-201 Slice 10A — a target keeps its event's decoded payload from the
   *  handoff until it is done (dispatched or cancelled). The outer outbox row
   *  protected the payload only until it was handed off, and a target may then
   *  wait out a backoff, a pause or an owner hold before its run reads it. A
   *  dead letter keeps it too, so the owner can still recover the run. */
  const pinPayload = (
    dispatch: Pick<DispatchSqlRow, 'dispatch_id' | 'event_id' | 'run_id'>,
    stamp: number,
  ): void => {
    db.prepare(`
      INSERT INTO webhook_payload_pins (
        pin_id, event_id, run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pin_id) DO UPDATE SET
        event_id = excluded.event_id,
        run_id = excluded.run_id,
        updated_at = excluded.updated_at
    `).run(dispatch.dispatch_id, dispatch.event_id, dispatch.run_id, stamp, stamp);
  };

  const releaseTarget = (dispatchId: string): void => {
    db.prepare('DELETE FROM webhook_payload_pins WHERE pin_id = ?').run(dispatchId);
    db.prepare('DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?')
      .run(dispatchId);
  };

  const cancelTarget = (dispatchId: string, stamp: number): void => {
    db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
        updated_at = ?
      WHERE dispatch_id = ?
        AND (state IN ('pending', 'running')
          OR (state = 'dead_letter' AND resolved_at IS NULL))
    `).run(stamp, dispatchId);
    releaseTarget(dispatchId);
  };

  const triggerAttached = (triggerId: string): boolean => db.prepare(`
    SELECT 1 FROM webhook_recipe_triggers WHERE trigger_id = ?
  `).get(triggerId) !== undefined;

  const prepareDispatches: WebhookConsumerStore['prepareDispatches'] = ({
    event,
    delivery,
  }) => {
    if (event.delivery_id !== delivery.delivery_id
      || event.ingress_id !== delivery.ingress_id) {
      throw new WebhookConsumerStoreError(
        'conflict',
        'webhook event and delivery identities do not match',
      );
    }
    const targets = currentTargets(
      event.ingress_id,
      event.provider_event_type,
      delivery.received_at,
    );
    const stamp = now();
    const prepare = db.transaction((): WebhookPreparedDispatch[] => {
      const currentTriggerIds = new Set(targets.map((target) => target.trigger_id));
      const existing = db.prepare(`
        SELECT * FROM webhook_recipe_dispatches
        WHERE event_id = ?
          AND (state IN ('pending', 'running')
            OR (state = 'dead_letter' AND resolved_at IS NULL))
      `).all(event.event_id) as DispatchSqlRow[];
      for (const dispatch of existing) {
        if (currentTriggerIds.has(dispatch.trigger_id)) continue;
        if (!triggerAttached(dispatch.trigger_id)) {
          // replaceConsumer deliberately detaches the prior trigger ids until
          // its cross-store recipe/pack mutation either restores or finalizes
          // them. Do not let an outbox replay in that window cancel rollback
          // state or acknowledge the outer event before the owner transaction
          // has a durable disposition.
          throw new WebhookConsumerStoreError(
            'conflict',
            'webhook dispatch target replacement is still in progress',
          );
        }
        cancelTarget(dispatch.dispatch_id, stamp);
      }

      const result: WebhookPreparedDispatch[] = [];
      for (const target of targets) {
        let dispatch = db.prepare(`
          SELECT * FROM webhook_recipe_dispatches
          WHERE event_id = ? AND trigger_id = ?
        `).get(event.event_id, target.trigger_id) as DispatchSqlRow | undefined;
        if (!dispatch) {
          const dispatchId = newDispatchId();
          const runId = newRunId();
          requireSafeIdentity(dispatchId, 'dispatch_id');
          requireSafeIdentity(runId, 'run_id');
          db.prepare(`
            INSERT INTO webhook_recipe_dispatches (
              dispatch_id, event_id, trigger_id, binding_id, recipe_id,
              publisher_id, run_id, state, attempt_count, claim_token,
              available_at, lease_expires_at, last_error_code,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL, NULL, ?, ?)
          `).run(
            dispatchId,
            event.event_id,
            target.trigger_id,
            target.binding_id,
            target.recipe_id,
            target.publisher_id,
            runId,
            stamp,
            stamp,
            stamp,
          );
          dispatch = db.prepare(`
            SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
          `).get(dispatchId) as DispatchSqlRow;
        }
        // A replay pins a row the first handoff left unpinned too (a row
        // written before Slice 10A pinned only once a run claimed it).
        if (dispatch.state === 'pending'
          || dispatch.state === 'running'
          || (dispatch.state === 'dead_letter' && dispatch.resolved_at === null)) {
          pinPayload(dispatch, stamp);
        }
        result.push(preparedFrom(dispatch, target));
      }
      return result;
    });
    return prepare();
  };

  const listRunnableDispatches: WebhookConsumerStore['listRunnableDispatches'] = ({
    limit,
  }) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new WebhookConsumerStoreError(
        'invalid',
        'webhook runnable dispatch limit must be in 1..100',
      );
    }
    // Ties on `created_at` (one handoff, or two in one millisecond) break on
    // `rowid`, the order the rows were written: a dispatch id is random, and a
    // recipe's deliveries must run in the order they were handed off.
    //
    // ⛔ ONLY A HANDED-OFF EVENT'S TARGETS RUN. The outer row is marked
    // `dispatched` in its own transaction after `prepareDispatches` commits;
    // a run that started in between would run behind an outer row that may yet
    // be retried into a dead letter. A crash between the two leaves the targets
    // waiting for the outer replay, which finds them and marks the row.
    //
    // D-201 Slice 10E — each recipe's head is read from the queue index (its
    // pending and running rows in handoff order) and the scan stops at the
    // first one that may run, so its cost follows the number of recipes, not
    // the backlog. A delivery waiting out a retry, held for the owner, or not
    // yet handed off is passed over: a recipe's later deliveries do not wait
    // for it. A recipe runs one delivery at a time (no live claim), which the
    // worker also enforces for the claims its own process holds.
    return db.prepare(`
      SELECT head.dispatch_id, head.event_id, head.recipe_id, head.publisher_id,
        head.attempt_count
      FROM (
        SELECT DISTINCT publisher_id, recipe_id FROM webhook_recipe_triggers
      ) recipe
      JOIN webhook_recipe_dispatches head ON head.rowid = (
        SELECT dispatch.rowid
        FROM webhook_recipe_dispatches dispatch
        WHERE dispatch.publisher_id = recipe.publisher_id
          AND dispatch.recipe_id = recipe.recipe_id
          AND dispatch.state IN ('pending', 'running')
          AND (
            (dispatch.state = 'pending' AND dispatch.available_at <= @now)
            OR (dispatch.state = 'running'
              AND COALESCE(dispatch.lease_expires_at, 0) <= @now
              AND NOT EXISTS (
                SELECT 1 FROM webhook_waiting_dispatches waiting
                WHERE waiting.dispatch_id = dispatch.dispatch_id
              ))
          )
          AND EXISTS (
            SELECT 1 FROM webhook_recipe_triggers trigger
            WHERE trigger.trigger_id = dispatch.trigger_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_event_outbox outbox
            WHERE outbox.event_id = dispatch.event_id
              AND outbox.state <> 'dispatched'
          )
        ORDER BY dispatch.created_at ASC, dispatch.rowid ASC
        LIMIT 1
      )
      WHERE NOT EXISTS (
        SELECT 1 FROM webhook_recipe_dispatches busy
        WHERE busy.publisher_id = recipe.publisher_id
          AND busy.recipe_id = recipe.recipe_id
          AND busy.state = 'running'
          AND busy.lease_expires_at > @now
      )
      ORDER BY head.created_at ASC, head.rowid ASC
      LIMIT @limit
    `).all({ now: now(), limit }) as WebhookRunnableDispatch[];
  };

  const currentTargetById = (
    triggerId: string,
    ingressId: string,
    providerEventType: string,
    acceptedAt: number,
  ): TargetSqlRow | null => currentTargets(
    ingressId,
    providerEventType,
    acceptedAt,
  )
    .find((row) => row.trigger_id === triggerId) ?? null;

  const beginDispatch: WebhookConsumerStore['beginDispatch'] = ({
    dispatch_id,
    event,
    delivery,
    lease_ms,
    max_attempts,
  }) => {
    requireClaimPolicy({ lease_ms, max_attempts });
    const claim = db.transaction((): WebhookDispatchClaim | null => {
      const dispatch = db.prepare(`
        SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
      `).get(dispatch_id) as DispatchSqlRow | undefined;
      if (!dispatch) {
        throw new WebhookConsumerStoreError('not_found', 'webhook dispatch not found');
      }
      if (dispatch.event_id !== event.event_id
        || event.delivery_id !== delivery.delivery_id
        || event.ingress_id !== delivery.ingress_id) {
        throw new WebhookConsumerStoreError('conflict', 'webhook dispatch identity mismatch');
      }
      if (dispatch.state === 'dispatched'
        || dispatch.state === 'cancelled'
        || dispatch.state === 'dead_letter') return null;
      const waiting = db.prepare(`
        SELECT run_id FROM webhook_waiting_dispatches WHERE dispatch_id = ?
      `).get(dispatch_id) as { run_id: string } | undefined;
      if (waiting) {
        if (dispatch.state !== 'running' || waiting.run_id !== dispatch.run_id) {
          throw new WebhookConsumerStoreError(
            'corrupt',
            'webhook awaiting-approval dispatch is corrupt',
          );
        }
        return null;
      }
      const stamp = now();
      // ⛔ A LIVE CLAIM IS NEVER TAKEN OVER. Before Slice 10A an outbox retry
      // replaced the claim of a run still in progress; that run's own result
      // then failed as stale while the retry waited on the same run. A running
      // row is another worker's until its lease expires (its worker died).
      if (dispatch.state === 'running' && (dispatch.lease_expires_at ?? 0) > stamp) {
        return null;
      }
      if (dispatch.state === 'pending' && dispatch.available_at > stamp) return null;
      // Mid-replacement: the owner's save detached the trigger and will either
      // restore or finalize it. Neither run nor cancel the target until then.
      if (!triggerAttached(dispatch.trigger_id)) return null;
      const target = currentTargetById(
        dispatch.trigger_id,
        event.ingress_id,
        event.provider_event_type,
        delivery.received_at,
      );
      if (!target
        || target.binding_id !== dispatch.binding_id
        || target.recipe_id !== dispatch.recipe_id
        || target.publisher_id !== dispatch.publisher_id) {
        cancelTarget(dispatch_id, stamp);
        return null;
      }
      // A claim whose worker died with it spent its attempt; a target that
      // takes its process down every time stops at the ceiling. Nothing ran:
      // a restart's mark stays, so the owner's try again runs it again on its
      // run id (Slice 10J; this cleared it, and that try closed it as stopped).
      if (dispatch.attempt_count >= max_attempts) {
        db.prepare(`
          UPDATE webhook_recipe_dispatches SET
            state = 'dead_letter', claim_token = NULL, lease_expires_at = NULL,
            last_error_code = 'attempt_limit', updated_at = ?
          WHERE dispatch_id = ?
        `).run(stamp, dispatch_id);
        pinPayload(dispatch, stamp);
        return null;
      }
      const claimToken = newClaimToken();
      requireSafeIdentity(claimToken, 'claim_token');
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = 'running', attempt_count = attempt_count + 1,
          claim_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE dispatch_id = ?
      `).run(claimToken, stamp + lease_ms, stamp, dispatch_id);
      pinPayload(dispatch, stamp);
      return {
        ...preparedFrom({
          ...dispatch,
          state: 'running',
          attempt_count: dispatch.attempt_count + 1,
          claim_token: claimToken,
          lease_expires_at: stamp + lease_ms,
          updated_at: stamp,
        }, target),
        claim_token: claimToken,
        attempt_count: dispatch.attempt_count + 1,
        resume_interrupted_run: dispatch.restart_interrupted_at !== null,
        rerun_in_doubt: dispatch.in_doubt_rerun_at !== null,
      };
    });
    return claim();
  };

  const renewDispatchLease: WebhookConsumerStore['renewDispatchLease'] = ({
    dispatch_id,
    claim_token,
    lease_ms,
  }) => {
    requireClaimPolicy({ lease_ms, max_attempts: 1 });
    const stamp = now();
    // An owner hold has no lease to renew; the hold, not a worker, owns it.
    return db.prepare(`
      UPDATE webhook_recipe_dispatches SET lease_expires_at = ?, updated_at = ?
      WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
        AND lease_expires_at IS NOT NULL
    `).run(stamp + lease_ms, stamp, dispatch_id, claim_token).changes === 1;
  };

  const requireWorkerClaim = (
    dispatchId: string,
    claimToken: string,
  ): DispatchSqlRow => {
    const dispatch = db.prepare(`
      SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
    `).get(dispatchId) as DispatchSqlRow | undefined;
    const held = db.prepare(`
      SELECT 1 FROM webhook_waiting_dispatches WHERE dispatch_id = ?
    `).get(dispatchId) !== undefined;
    if (!dispatch
      || dispatch.state !== 'running'
      || dispatch.claim_token !== claimToken
      || held) {
      throw new WebhookConsumerStoreError(
        'stale_claim',
        'webhook recipe dispatch claim is stale',
      );
    }
    return dispatch;
  };

  const cancelUnreadableDispatch: WebhookConsumerStore['cancelUnreadableDispatch'] = (
    dispatchId,
  ) => db.transaction((): boolean => {
    const dispatch = db.prepare(`
      SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
    `).get(dispatchId) as DispatchSqlRow | undefined;
    const held = db.prepare(`
      SELECT 1 FROM webhook_waiting_dispatches WHERE dispatch_id = ?
    `).get(dispatchId) !== undefined;
    const stamp = now();
    const runnable = dispatch !== undefined
      && !held
      && (dispatch.state === 'pending'
        || (dispatch.state === 'running' && (dispatch.lease_expires_at ?? 0) <= stamp));
    if (!runnable) return false;
    cancelTarget(dispatchId, stamp);
    return true;
  })();

  const releaseDispatchClaim: WebhookConsumerStore['releaseDispatchClaim'] = (
    dispatchId,
    claimToken,
  ) => {
    db.transaction(() => {
      requireWorkerClaim(dispatchId, claimToken);
      const stamp = now();
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = 'pending',
          attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
          available_at = ?, claim_token = NULL, lease_expires_at = NULL,
          updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(stamp, stamp, dispatchId, claimToken);
    })();
  };

  const markInterruptedByRestart: WebhookConsumerStore['markInterruptedByRestart'] = (
    claims,
  ) => {
    const stamp = now();
    const mark = db.prepare(`
      UPDATE webhook_recipe_dispatches SET restart_interrupted_at = ?, updated_at = ?
      WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
        AND NOT EXISTS (
          SELECT 1 FROM webhook_waiting_dispatches waiting
          WHERE waiting.dispatch_id = webhook_recipe_dispatches.dispatch_id
        )
    `);
    return db.transaction((): number => {
      let marked = 0;
      for (const claim of claims) {
        marked += mark.run(stamp, stamp, claim.dispatch_id, claim.claim_token).changes;
      }
      return marked;
    })();
  };

  const markResumesInterruptedByRestart: WebhookConsumerStore[
    'markResumesInterruptedByRestart'
  ] = (held) => {
    const stamp = now();
    const mark = db.prepare(`
      UPDATE webhook_recipe_dispatches SET restart_interrupted_at = ?, updated_at = ?
      WHERE dispatch_id = ? AND run_id = ? AND state = 'running'
        AND EXISTS (
          SELECT 1 FROM webhook_waiting_dispatches waiting
          WHERE waiting.dispatch_id = webhook_recipe_dispatches.dispatch_id
            AND waiting.run_id = webhook_recipe_dispatches.run_id
        )
    `);
    return db.transaction((): number => {
      let marked = 0;
      for (const row of held) {
        marked += mark.run(stamp, stamp, row.dispatch_id, row.run_id).changes;
      }
      return marked;
    })();
  };

  const clearHeldRestartMark: WebhookConsumerStore['clearHeldRestartMark'] = (input) => db.prepare(`
    UPDATE webhook_recipe_dispatches SET restart_interrupted_at = NULL, updated_at = ?
    WHERE dispatch_id = ? AND run_id = ? AND state = 'running'
      AND restart_interrupted_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM webhook_waiting_dispatches waiting
        WHERE waiting.dispatch_id = webhook_recipe_dispatches.dispatch_id
          AND waiting.run_id = webhook_recipe_dispatches.run_id
      )
  `).run(now(), input.dispatch_id, input.run_id).changes === 1;

  const releaseInterruptedDispatch: WebhookConsumerStore['releaseInterruptedDispatch'] = (
    dispatchId,
    claimToken,
  ) => {
    db.transaction(() => {
      requireWorkerClaim(dispatchId, claimToken);
      const stamp = now();
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = 'pending',
          attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
          available_at = ?, claim_token = NULL, lease_expires_at = NULL,
          restart_interrupted_at = COALESCE(restart_interrupted_at, ?),
          updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(stamp, stamp, stamp, dispatchId, claimToken);
    })();
  };

  const deferUnclaimableDispatch: WebhookConsumerStore['deferUnclaimableDispatch'] = (
    input,
  ) => {
    if (!Number.isSafeInteger(input.retry_delay_ms)
      || input.retry_delay_ms < 0
      || input.retry_delay_ms > 24 * 60 * 60 * 1_000) {
      throw new WebhookConsumerStoreError('invalid', 'webhook dispatch retry_delay_ms is out of range');
    }
    requireClaimPolicy({ lease_ms: 1_000, max_attempts: input.max_attempts });
    return db.transaction((): 'pending' | 'dead_letter' | null => {
      const stamp = now();
      // Only what the claim scan offers: a pending row, or a running one whose
      // worker died (lease lapsed, no owner hold). A live claim is untouched.
      const dispatch = db.prepare(`
        SELECT attempt_count FROM webhook_recipe_dispatches
        WHERE dispatch_id = ?
          AND (state = 'pending'
            OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?
              AND NOT EXISTS (
                SELECT 1 FROM webhook_waiting_dispatches waiting
                WHERE waiting.dispatch_id = webhook_recipe_dispatches.dispatch_id
              )))
      `).get(input.dispatch_id, stamp) as { attempt_count: number } | undefined;
      if (dispatch === undefined) return null;
      const attempts = dispatch.attempt_count + 1;
      const next = attempts >= input.max_attempts ? 'dead_letter' : 'pending';
      // Not claimed, so nothing ran: a restart's mark stays (Slice 10J).
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = ?, attempt_count = ?, claim_token = NULL, lease_expires_at = NULL,
          available_at = ?, last_error_code = 'claim_failed', updated_at = ?
        WHERE dispatch_id = ?
      `).run(
        next,
        attempts,
        next === 'pending' ? stamp + input.retry_delay_ms : stamp,
        stamp,
        input.dispatch_id,
      );
      return next;
    })();
  };

  const markDispatchFailed: WebhookConsumerStore['markDispatchFailed'] = (input) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.error_code)) {
      throw new WebhookConsumerStoreError('invalid', 'webhook dispatch error_code has invalid shape');
    }
    if (!Number.isSafeInteger(input.retry_delay_ms)
      || input.retry_delay_ms < 0
      || input.retry_delay_ms > 24 * 60 * 60 * 1_000) {
      throw new WebhookConsumerStoreError('invalid', 'webhook dispatch retry_delay_ms is out of range');
    }
    requireClaimPolicy({ lease_ms: 1_000, max_attempts: input.max_attempts });
    return db.transaction((): 'pending' | 'dead_letter' => {
      const dispatch = requireWorkerClaim(input.dispatch_id, input.claim_token);
      const stamp = now();
      const next = dispatch.attempt_count >= input.max_attempts
        ? 'dead_letter'
        : 'pending';
      // D-201 Slice 10J — the mark goes only once a new run record replaced
      // the one a restart stopped; a failure before that keeps it.
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = ?, claim_token = NULL, lease_expires_at = NULL,
          available_at = ?, last_error_code = ?,
          restart_interrupted_at = CASE WHEN ? = 1 THEN restart_interrupted_at ELSE NULL END,
          in_doubt_rerun_at = CASE WHEN ? = 1 THEN in_doubt_rerun_at ELSE NULL END,
          updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(
        next,
        next === 'pending' ? stamp + input.retry_delay_ms : dispatch.available_at,
        input.error_code,
        input.keep_restart_mark === true ? 1 : 0,
        input.keep_restart_mark === true ? 1 : 0,
        stamp,
        input.dispatch_id,
        input.claim_token,
      );
      return next;
    })();
  };

  // ── D-201 Slice 10B — target dead letters for the owner's review ─────────

  const listDeadLetterTargets: WebhookConsumerStore[
    'listDeadLetterTargets'
  ] = (input) => {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) {
      throw new WebhookConsumerStoreError(
        'invalid',
        'webhook dead letters: limit must be in 1..101',
      );
    }
    const bound = deadLetterPageCondition(input.before, 'dispatch.updated_at', 'dispatch.dispatch_id');
    const rows = db.prepare(`
      SELECT
        dispatch.dispatch_id, dispatch.event_id, event.delivery_id,
        event.ingress_id, dispatch.recipe_id, dispatch.run_id,
        event.provider_event_type, delivery.received_at,
        dispatch.attempt_count, dispatch.last_error_code,
        dispatch.updated_at AS dead_lettered_at,
        EXISTS (
          SELECT 1 FROM webhook_decoded_payloads payload
          WHERE payload.event_id = dispatch.event_id
        ) AS payload_retained
      FROM webhook_recipe_dispatches dispatch INDEXED BY ${input.closed === true
        ? 'idx_webhook_recipe_dispatches_closed_dead_letters'
        : 'idx_webhook_recipe_dispatches_open_dead_letters'}
      JOIN webhook_accepted_events event ON event.event_id = dispatch.event_id
      JOIN webhook_accepted_deliveries delivery
        ON delivery.delivery_id = event.delivery_id
      WHERE dispatch.state = 'dead_letter'
        AND ${input.closed === true ? 'dispatch.resolved_at IS NOT NULL' : 'dispatch.resolved_at IS NULL'}
        AND event.ingress_id = @ingress_id
        AND ${bound.sql}
      ORDER BY dispatch.updated_at DESC, dispatch.dispatch_id DESC
      LIMIT @limit
    `).all({ ingress_id: input.ingress_id, limit: input.limit, ...bound.params }) as Array<
      Omit<WebhookDeadLetterTargetRow, 'payload_retained' | 'closure'> & {
        payload_retained: number;
        resolved_at?: number | null;
      }
    >;
    return rows.map((row) => {
      const view: WebhookDeadLetterTargetRow = {
        ...row,
        payload_retained: row.payload_retained === 1,
      };
      if (input.closed !== true) return view;
      const closing = closingWebhookDeadLetterReview(db, { kind: 'target', id: row.dispatch_id });
      return {
        ...view,
        closure: {
          closed_at: row.dead_lettered_at,
          closed_by: closing?.actor_kind ?? 'server',
          reason: closing?.reason ?? null,
        },
      };
    });
  };

  const countUnresolvedDeadLetterTargets: WebhookConsumerStore[
    'countUnresolvedDeadLetterTargets'
  ] = (ingressId) => (db.prepare(`
    SELECT COUNT(*) AS count
    FROM webhook_recipe_dispatches dispatch
      INDEXED BY idx_webhook_recipe_dispatches_open_dead_letters
    JOIN webhook_accepted_events event ON event.event_id = dispatch.event_id
    WHERE dispatch.state = 'dead_letter' AND dispatch.resolved_at IS NULL
      AND (@ingress_id IS NULL OR event.ingress_id = @ingress_id)
  `).get({ ingress_id: ingressId ?? null }) as { count: number }).count;

  const isRunStillOpen: WebhookConsumerStore['isRunStillOpen'] = (runId) =>
    db.prepare(`
      SELECT 1 FROM webhook_recipe_dispatches
      WHERE run_id = ?
        AND (state IN ('pending', 'running') OR (state = 'dead_letter' AND resolved_at IS NULL))
    `).get(runId) !== undefined;

  const oldestUnresolvedDoorlessDeadLetterTargets: WebhookConsumerStore[
    'oldestUnresolvedDoorlessDeadLetterTargets'
  ] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return db.prepare(`
      SELECT dispatch.dispatch_id AS id, event.ingress_id AS ingress_id,
        dispatch.updated_at AS dead_lettered_at
      FROM webhook_recipe_dispatches dispatch
        INDEXED BY idx_webhook_recipe_dispatches_open_dead_letters
      JOIN webhook_accepted_events event ON event.event_id = dispatch.event_id
      WHERE dispatch.state = 'dead_letter' AND dispatch.resolved_at IS NULL
        AND dispatch.last_error_code IN ('door_missing', 'door_closed')
      ORDER BY dispatch.updated_at ASC, dispatch.dispatch_id ASC
      LIMIT ?
    `).all(limit) as Array<{ id: string; ingress_id: string; dead_lettered_at: number }>;
  };

  const oldestUnresolvedDeadLetterTargets: WebhookConsumerStore[
    'oldestUnresolvedDeadLetterTargets'
  ] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return db.prepare(`
      SELECT dispatch.dispatch_id AS id, event.ingress_id AS ingress_id,
        dispatch.updated_at AS dead_lettered_at
      FROM webhook_recipe_dispatches dispatch
        INDEXED BY idx_webhook_recipe_dispatches_open_dead_letters
      JOIN webhook_accepted_events event ON event.event_id = dispatch.event_id
      WHERE dispatch.state = 'dead_letter' AND dispatch.resolved_at IS NULL
      ORDER BY dispatch.updated_at ASC, dispatch.dispatch_id ASC
      LIMIT ?
    `).all(limit) as Array<{ id: string; ingress_id: string; dead_lettered_at: number }>;
  };

  /** The target dead letter a decision names, checked against what its
   *  caller saw. */
  const requireUnresolvedDeadLetterTarget = (
    input: { dispatch_id: string } & WebhookDeadLetterDecision,
  ): DispatchSqlRow & { ingress_id: string } => {
    const row = db.prepare(`
      SELECT dispatch.*, event.ingress_id AS ingress_id
      FROM webhook_recipe_dispatches dispatch
      JOIN webhook_accepted_events event ON event.event_id = dispatch.event_id
      WHERE dispatch.dispatch_id = ?
    `).get(input.dispatch_id) as (DispatchSqlRow & { ingress_id: string }) | undefined;
    if (!row || row.ingress_id !== input.ingress_id) {
      throw new WebhookDeadLetterActionError('not_found', 'webhook dead letter not found');
    }
    if (row.state !== 'dead_letter' || row.resolved_at !== null) {
      throw new WebhookDeadLetterActionError(
        'not_dead_letter',
        'webhook recipe dispatch is no longer a dead letter',
      );
    }
    if (row.updated_at !== input.dead_lettered_at) {
      throw new WebhookDeadLetterActionError(
        'stale',
        'webhook dead letter changed since it was read',
      );
    }
    return row;
  };

  const requeueDeadLetterTarget: WebhookConsumerStore['requeueDeadLetterTarget'] = (
    input,
  ) => db.transaction((): WebhookDeadLetterReviewRow => {
    const row = requireUnresolvedDeadLetterTarget(input);
    // Slice 10F — tried again, it must reach a recipe: its trigger is still
    // there (a save that kept the slot carried it over) and current for the
    // event. Otherwise say so; the claim would only cancel it unseen.
    const event = db.prepare(`
      SELECT event.provider_event_type AS provider_event_type,
        delivery.received_at AS received_at
      FROM webhook_accepted_events event
      JOIN webhook_accepted_deliveries delivery
        ON delivery.delivery_id = event.delivery_id
      WHERE event.event_id = ?
    `).get(row.event_id) as { provider_event_type: string; received_at: number } | undefined;
    if (event === undefined
      || !triggerAttached(row.trigger_id)
      || currentTargetById(
        row.trigger_id,
        row.ingress_id,
        event.provider_event_type,
        event.received_at,
      ) === null) {
      throw new WebhookDeadLetterActionError(
        'no_recipe',
        'no recipe takes this dead letter now',
      );
    }
    // D-201 Slice 10U (10Q finding 9) — and through a live door: one with none
    // runs nothing at the claim, so tried again it would only come back. It
    // stays for the owner, who is told which door to make or open.
    if (input.door !== undefined) {
      const stamped = (db.prepare(`
        SELECT contract_id FROM webhook_recipe_triggers WHERE trigger_id = ?
      `).get(row.trigger_id) as { contract_id: string | null } | undefined)?.contract_id ?? null;
      const door = input.door(stamped);
      if (door !== 'live') {
        throw new WebhookDeadLetterActionError(
          door === 'missing' ? 'door_missing' : 'door_closed',
          door === 'missing'
            ? 'its recipe has no webhook door, so it cannot run'
            : "its recipe's webhook door is switched off, so it cannot run",
        );
      }
    }
    const stamp = now();
    // D-201 Slice 10N — an approved run whose outcome was in doubt runs again
    // only because the owner, having looked, tried it again: this says so.
    db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'pending', attempt_count = 0, available_at = ?,
        in_doubt_rerun_at = CASE
          WHEN last_error_code = 'approved_run_in_doubt' THEN ? ELSE in_doubt_rerun_at
        END,
        last_error_code = NULL, updated_at = ?
      WHERE dispatch_id = ? AND state = 'dead_letter' AND resolved_at IS NULL
    `).run(stamp, stamp, stamp, row.dispatch_id);
    pinPayload(row, stamp);
    return insertWebhookDeadLetterReview(db, {
      subject_kind: 'target',
      subject_id: row.dispatch_id,
      event_id: row.event_id,
      ingress_id: row.ingress_id,
      action: 'requeue',
      actor_kind: input.actor_kind,
      actor_instance_id: input.actor_instance_id,
      reason: input.reason,
      attempt_count: row.attempt_count,
      created_at: stamp,
    });
  })();

  const resolveDeadLetterTarget: WebhookConsumerStore['resolveDeadLetterTarget'] = (
    input,
  ) => db.transaction((): WebhookDeadLetterReviewRow => {
    const row = requireUnresolvedDeadLetterTarget(input);
    const stamp = now();
    db.prepare(`
      UPDATE webhook_recipe_dispatches SET resolved_at = ?, updated_at = ?
      WHERE dispatch_id = ? AND state = 'dead_letter' AND resolved_at IS NULL
    `).run(stamp, stamp, row.dispatch_id);
    releaseTarget(row.dispatch_id);
    return insertWebhookDeadLetterReview(db, {
      subject_kind: 'target',
      subject_id: row.dispatch_id,
      event_id: row.event_id,
      ingress_id: row.ingress_id,
      action: input.action,
      actor_kind: input.actor_kind,
      actor_instance_id: input.actor_instance_id,
      reason: input.reason,
      attempt_count: row.attempt_count,
      created_at: stamp,
    });
  })();

  const closeTargetsOfClosedEvent: WebhookConsumerStore['closeTargetsOfClosedEvent'] = (
    eventId,
  ) => db.transaction((): number => {
    const stamp = now();
    // No live claim can stand under an event whose outer row is a dead letter
    // (a claim needs it dispatched); the condition keeps one safe anyway.
    // Slice 10I (10H finding 11) — nor is an approval hold touched: it has no
    // lease, and it is the owner's open decision, not work that cannot run.
    const rows = db.prepare(`
      SELECT dispatch_id FROM webhook_recipe_dispatches
      WHERE event_id = ?
        AND (state = 'pending'
          OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?
            AND NOT EXISTS (
              SELECT 1 FROM webhook_waiting_dispatches waiting
              WHERE waiting.dispatch_id = webhook_recipe_dispatches.dispatch_id
            )))
    `).all(eventId, stamp) as Array<{ dispatch_id: string }>;
    for (const row of rows) cancelTarget(row.dispatch_id, stamp);
    return rows.length;
  })();

  const closeStrandedTargets: WebhookConsumerStore['closeStrandedTargets'] = () => {
    // D-201 Slice 10U — a replacement a process left unfinished is the start's
    // to finish, before this runs (`finishWebhookReplacementsAtStart`). Any
    // record still here is a replacement under way (a pack install awaits
    // between its replace and its finalize): its rows are not stranded, and
    // 10P's finish here finalized it under the install's feet.
    if (!deliveryTablesPresent()) return 0;
    return db.transaction((): number => {
      const stamp = now();
      const underWay = JSON.stringify(detachedByPendingReplacements());
      const closed = closeDeadLetterTargets(
        `dispatch.trigger_id NOT IN (SELECT trigger_id FROM webhook_recipe_triggers)
          AND dispatch.trigger_id NOT IN (SELECT value FROM json_each(?))`,
        [underWay],
        'recipe_removed',
        stamp,
      );
      const rows = db.prepare(`
        SELECT dispatch_id FROM webhook_recipe_dispatches
        WHERE state IN ('pending', 'running')
          AND trigger_id NOT IN (SELECT trigger_id FROM webhook_recipe_triggers)
          AND trigger_id NOT IN (SELECT value FROM json_each(?))
      `).all(underWay) as Array<{ dispatch_id: string }>;
      for (const row of rows) cancelTarget(row.dispatch_id, stamp);
      return closed + rows.length;
    })();
  };

  const refreshTargetsOfRequeuedEvent: WebhookConsumerStore['refreshTargetsOfRequeuedEvent'] = (
    eventId,
  ) => {
    const stamp = now();
    return db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'pending', attempt_count = 0, available_at = ?,
        claim_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
        updated_at = ?
      WHERE event_id = ?
        AND (state = 'pending'
          OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?
            AND NOT EXISTS (
              SELECT 1 FROM webhook_waiting_dispatches waiting
              WHERE waiting.dispatch_id = webhook_recipe_dispatches.dispatch_id
            )))
    `).run(stamp, stamp, eventId, stamp).changes;
  };

  const eventHasCurrentRecipe: WebhookConsumerStore['eventHasCurrentRecipe'] = (eventId) => {
    if (!deliveryTablesPresent()) return false;
    const event = db.prepare(`
      SELECT event.ingress_id AS ingress_id,
        event.provider_event_type AS provider_event_type,
        delivery.received_at AS received_at
      FROM webhook_accepted_events event
      JOIN webhook_accepted_deliveries delivery
        ON delivery.delivery_id = event.delivery_id
      WHERE event.event_id = ?
    `).get(eventId) as {
      ingress_id: string;
      provider_event_type: string;
      received_at: number;
    } | undefined;
    if (event === undefined) return false;
    return currentTargets(event.ingress_id, event.provider_event_type, event.received_at)
      .length > 0;
  };

  const closeDeadLetterTargetsForIngress: WebhookConsumerStore[
    'closeDeadLetterTargetsForIngress'
  ] = (ingressId, reason) => db.transaction((): number => closeDeadLetterTargets(
    'event.ingress_id = ?',
    [ingressId],
    reason,
    now(),
  ))();

  const pruneDispatchesWithoutEvents: WebhookConsumerStore['pruneDispatchesWithoutEvents'] = () => {
    if (!deliveryTablesPresent()) return 0;
    return db.prepare(`
      DELETE FROM webhook_recipe_dispatches
      WHERE (state IN ('dispatched', 'cancelled')
          OR (state = 'dead_letter' AND resolved_at IS NOT NULL))
        AND NOT EXISTS (
          SELECT 1 FROM webhook_accepted_events event
          WHERE event.event_id = webhook_recipe_dispatches.event_id
        )
    `).run().changes;
  };

  const finishDispatch = (
    dispatchId: string,
    claimToken: string,
    state: 'dispatched' | 'cancelled',
  ): void => {
    const finish = db.transaction(() => {
      const updated = db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = ?, claim_token = NULL, lease_expires_at = NULL,
          restart_interrupted_at = NULL, in_doubt_rerun_at = NULL, updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(state, now(), dispatchId, claimToken);
      if (updated.changes !== 1) {
        throw new WebhookConsumerStoreError(
          'stale_claim',
          'webhook recipe dispatch claim is stale',
        );
      }
      releaseTarget(dispatchId);
    });
    finish();
  };

  const markDispatchAwaitingApproval: WebhookConsumerStore[
    'markDispatchAwaitingApproval'
  ] = (dispatchId, claimToken) => {
    const mark = db.transaction(() => {
      const dispatch = db.prepare(`
        SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
      `).get(dispatchId) as DispatchSqlRow | undefined;
      if (!dispatch
        || dispatch.state !== 'running'
        || dispatch.claim_token !== claimToken) {
        throw new WebhookConsumerStoreError(
          'stale_claim',
          'webhook recipe dispatch claim is stale',
        );
      }
      const pin = db.prepare(`
        SELECT 1 FROM webhook_payload_pins
        WHERE pin_id = ? AND event_id = ? AND run_id = ?
      `).get(dispatchId, dispatch.event_id, dispatch.run_id);
      if (!pin) {
        throw new WebhookConsumerStoreError(
          'corrupt',
          'webhook awaiting-approval dispatch has no payload pin',
        );
      }
      const existing = db.prepare(`
        SELECT run_id FROM webhook_waiting_dispatches WHERE dispatch_id = ?
      `).get(dispatchId) as { run_id: string } | undefined;
      if (existing && existing.run_id !== dispatch.run_id) {
        throw new WebhookConsumerStoreError(
          'corrupt',
          'webhook awaiting-approval dispatch run identity changed',
        );
      }
      const stamp = now();
      db.prepare(`
        INSERT INTO webhook_waiting_dispatches (
          dispatch_id, run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(dispatch_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(dispatchId, dispatch.run_id, stamp, stamp);
      // The hold, not a worker, owns the row now: no lease to renew or
      // expire, so no worker reclaims a run the owner has yet to decide.
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          lease_expires_at = NULL, restart_interrupted_at = NULL, in_doubt_rerun_at = NULL, updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(stamp, dispatchId, claimToken);
    });
    mark();
  };

  const selectAwaitingApprovalDispatches = (
    limit?: number,
  ): WebhookAwaitingApprovalDispatch[] => (db.prepare(`
    SELECT
      waiting.dispatch_id AS dispatch_id,
      waiting.run_id AS run_id,
      dispatch.recipe_id AS recipe_id,
      dispatch.restart_interrupted_at IS NOT NULL AS restart_interrupted
    FROM webhook_waiting_dispatches waiting
    JOIN webhook_recipe_dispatches dispatch
      ON dispatch.dispatch_id = waiting.dispatch_id
      AND dispatch.run_id = waiting.run_id
    JOIN webhook_recipe_triggers trigger
      ON trigger.trigger_id = dispatch.trigger_id
    JOIN webhook_consumer_bindings binding
      ON binding.binding_id = trigger.binding_id
    WHERE dispatch.state = 'running'
      AND trigger.enabled = 1
      AND binding.enabled = 1
    ORDER BY waiting.updated_at ASC, waiting.dispatch_id ASC
    ${limit === undefined ? '' : 'LIMIT ?'}
  `).all(...(limit === undefined ? [] : [limit])) as Array<
    Omit<WebhookAwaitingApprovalDispatch, 'restart_interrupted'> & { restart_interrupted: number }
  >).map((row) => ({ ...row, restart_interrupted: row.restart_interrupted === 1 }));

  const listAwaitingApprovalDispatches: WebhookConsumerStore[
    'listAwaitingApprovalDispatches'
  ] = () => selectAwaitingApprovalDispatches();

  const takeAwaitingApprovalDispatches: WebhookConsumerStore[
    'takeAwaitingApprovalDispatches'
  ] = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new WebhookConsumerStoreError(
        'invalid',
        'webhook approval reconciliation limit must be in 1..100',
      );
    }
    const take = db.transaction((): WebhookAwaitingApprovalDispatch[] => {
      const rows = selectAwaitingApprovalDispatches(limit);
      if (rows.length === 0) return rows;
      const maximum = db.prepare(`
        SELECT MAX(updated_at) AS updated_at FROM webhook_waiting_dispatches
      `).get() as { updated_at: number | null };
      const observed = now();
      if (!Number.isSafeInteger(observed) || observed < 0
        || (maximum.updated_at !== null
          && (!Number.isSafeInteger(maximum.updated_at) || maximum.updated_at < 0))) {
        throw new WebhookConsumerStoreError(
          'corrupt',
          'webhook approval reconciliation clock is invalid',
        );
      }
      const base = Math.max(observed, maximum.updated_at ?? observed);
      if (base > Number.MAX_SAFE_INTEGER - rows.length) {
        throw new WebhookConsumerStoreError(
          'conflict',
          'webhook approval reconciliation clock is exhausted',
        );
      }
      const rotate = db.prepare(`
        UPDATE webhook_waiting_dispatches SET updated_at = ?
        WHERE dispatch_id = ? AND run_id = ?
      `);
      rows.forEach((row, index) => {
        rotate.run(base + index + 1, row.dispatch_id, row.run_id);
      });
      return rows;
    });
    return take();
  };

  const resolveAwaitingApprovalDispatch: WebhookConsumerStore[
    'resolveAwaitingApprovalDispatch'
  ] = (input) => {
    const resolve = db.transaction((): boolean => {
      const waiting = db.prepare(`
        SELECT run_id FROM webhook_waiting_dispatches WHERE dispatch_id = ?
      `).get(input.dispatch_id) as { run_id: string } | undefined;
      if (!waiting) return false;
      if (waiting.run_id !== input.run_id) {
        throw new WebhookConsumerStoreError(
          'conflict',
          'webhook awaiting-approval dispatch run identity mismatch',
        );
      }
      const dispatch = db.prepare(`
        SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
      `).get(input.dispatch_id) as DispatchSqlRow | undefined;
      if (!dispatch
        || dispatch.run_id !== input.run_id
        || dispatch.state !== 'running') {
        throw new WebhookConsumerStoreError(
          'corrupt',
          'webhook awaiting-approval dispatch is not running',
        );
      }
      const authorityStillAttached = db.prepare(`
        SELECT 1
        FROM webhook_recipe_triggers trigger
        JOIN webhook_consumer_bindings binding
          ON binding.binding_id = trigger.binding_id
        WHERE trigger.trigger_id = ?
          AND trigger.binding_id = ?
          AND trigger.recipe_id = ?
          AND trigger.publisher_id = ?
          AND trigger.enabled = 1
          AND binding.enabled = 1
      `).get(
        dispatch.trigger_id,
        dispatch.binding_id,
        dispatch.recipe_id,
        dispatch.publisher_id,
      );
      if (!authorityStillAttached) return false;
      if (input.outcome === 'interrupted') {
        // D-201 Slice 10J — the server's stop ended the owner's approved run:
        // never a silent cancel. A dead letter for the owner, its pin and its
        // mark kept, so trying it again runs it again on its run id.
        if (dispatch.restart_interrupted_at === null) {
          throw new WebhookConsumerStoreError(
            'conflict',
            'webhook awaiting-approval dispatch carries no restart mark',
          );
        }
        db.prepare(`
          UPDATE webhook_recipe_dispatches SET
            state = 'dead_letter', claim_token = NULL, lease_expires_at = NULL,
            last_error_code = 'restart_interrupted', updated_at = ?
          WHERE dispatch_id = ? AND run_id = ? AND state = 'running'
        `).run(now(), input.dispatch_id, input.run_id);
        db.prepare('DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?')
          .run(input.dispatch_id);
        return true;
      }
      if (input.outcome === 'in_doubt') {
        // D-201 Slice 10N — what the owner approved may or may not have gone
        // through: the owner reviews it. Its pin stays. Trying it again marks
        // it to run again (`in_doubt_rerun_at`, set by the requeue).
        db.prepare(`
          UPDATE webhook_recipe_dispatches SET
            state = 'dead_letter', claim_token = NULL, lease_expires_at = NULL,
            last_error_code = 'approved_run_in_doubt', updated_at = ?
          WHERE dispatch_id = ? AND run_id = ? AND state = 'running'
        `).run(now(), input.dispatch_id, input.run_id);
        db.prepare('DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?')
          .run(input.dispatch_id);
        return true;
      }
      const terminalState: DispatchState = input.outcome === 'succeeded'
        ? 'dispatched'
        : 'cancelled';
      const updated = db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = ?, claim_token = NULL, lease_expires_at = NULL,
          restart_interrupted_at = NULL, in_doubt_rerun_at = NULL, updated_at = ?
        WHERE dispatch_id = ? AND run_id = ? AND state = 'running'
      `).run(terminalState, now(), input.dispatch_id, input.run_id);
      if (updated.changes !== 1) {
        throw new WebhookConsumerStoreError(
          'corrupt',
          'webhook awaiting-approval dispatch is not running',
        );
      }
      db.prepare('DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?')
        .run(input.dispatch_id);
      db.prepare('DELETE FROM webhook_payload_pins WHERE pin_id = ?')
        .run(input.dispatch_id);
      return true;
    });
    return resolve();
  };

  const isRunAuthorized: WebhookConsumerStore['isRunAuthorized'] = (input) => {
    const row = db.prepare(`
      SELECT dispatch.* FROM webhook_recipe_dispatches dispatch
      JOIN webhook_payload_pins pin
        ON pin.pin_id = dispatch.dispatch_id
        AND pin.event_id = dispatch.event_id
        AND pin.run_id = dispatch.run_id
      WHERE dispatch.run_id = ?
        AND dispatch.recipe_id = ?
        AND dispatch.event_id = ?
        AND dispatch.state = 'running'
    `).get(
      input.run_id,
      input.recipe_id,
      input.event.event_id,
    ) as DispatchSqlRow | undefined;
    if (!row
      || input.event.delivery_id !== input.delivery.delivery_id
      || input.event.ingress_id !== input.delivery.ingress_id) {
      return false;
    }
    const target = currentTargetById(
      row.trigger_id,
      input.event.ingress_id,
      input.event.provider_event_type,
      input.delivery.received_at,
    );
    if (!target
      || target.binding_id !== row.binding_id
      || target.recipe_id !== row.recipe_id
      || target.publisher_id !== row.publisher_id) {
      return false;
    }
    return !input.require_payload_access
      || target.decoded_payload_access === 'scoped_read';
  };

  return {
    replaceConsumer,
    previewReplacement,
    finalizeConsumerReplacement,
    removeConsumer,
    restoreDoorAnswers,
    restoreConsumer,
    setConsumerEnabled,
    isConsumerEnabled(consumerKind, consumerId) {
      return consumerStateMatches(consumerKind, consumerId, true);
    },
    listBindings(input = {}) {
      const rows = input.consumer_kind !== undefined
        && input.consumer_id !== undefined
        ? bindingsForConsumer(input.consumer_kind, input.consumer_id)
        : input.consumer_kind !== undefined
          ? db.prepare(`
              SELECT * FROM webhook_consumer_bindings
              WHERE consumer_kind = ?
              ORDER BY consumer_id ASC, logical_binding ASC, binding_id ASC
            `).all(input.consumer_kind) as BindingSqlRow[]
          : db.prepare(`
              SELECT * FROM webhook_consumer_bindings
              ORDER BY consumer_kind ASC, consumer_id ASC,
                logical_binding ASC, binding_id ASC
            `).all() as BindingSqlRow[];
      return rows.map(bindingFromSql);
    },
    stampTriggerContracts,
    clearTriggerContracts,
    doorContractIdForRecipe,
    rememberRecipeDoor,
    lastRecipeDoor,
    newestRecipeDoor,
    forgetRecipeDoors,
    doorAnswerFor,
    keepOwnerDoorDecision,
    currentDoorForRun,
    doorOwnerOfRun,
    recipesWithTriggers,
    consumersOfRecipe,
    hasDispatchTarget(ingressId, providerEventType) {
      return currentTargets(ingressId, providerEventType).length > 0;
    },
    prepareDispatches,
    listRunnableDispatches,
    beginDispatch,
    renewDispatchLease,
    releaseDispatchClaim,
    markInterruptedByRestart,
    markResumesInterruptedByRestart,
    clearHeldRestartMark,
    releaseInterruptedDispatch,
    deferUnclaimableDispatch,
    cancelUnreadableDispatch,
    markDispatchAwaitingApproval,
    listAwaitingApprovalDispatches,
    takeAwaitingApprovalDispatches,
    resolveAwaitingApprovalDispatch,
    markDispatchSucceeded(dispatchId, claimToken) {
      finishDispatch(dispatchId, claimToken, 'dispatched');
    },
    markDispatchCancelled(dispatchId, claimToken) {
      finishDispatch(dispatchId, claimToken, 'cancelled');
    },
    markDispatchFailed,
    listDeadLetterTargets,
    closeTargetsOfClosedEvent,
    closeStrandedTargets,
    pendingReplacements,
    setAsidePendingReplacement,
    refreshTargetsOfRequeuedEvent,
    eventHasCurrentRecipe,
    closeDeadLetterTargetsForIngress,
    pruneDispatchesWithoutEvents,
    countUnresolvedDeadLetterTargets,
    oldestUnresolvedDeadLetterTargets,
    oldestUnresolvedDoorlessDeadLetterTargets,
    isRunStillOpen,
    requeueDeadLetterTarget,
    resolveDeadLetterTarget,
    countActiveDispatchEvents() {
      // Slice 10F — not the targets under an event whose outer row is a dead
      // letter: they cannot run until it is tried again, and closing it cancels
      // them. A server before 10A left such rows pending (its v26.11.9 did),
      // and they held intake even after the owner closed the dead letter.
      const underDeadLetter = deliveryTablesPresent()
        ? `AND NOT EXISTS (
            SELECT 1 FROM webhook_event_outbox outbox
            WHERE outbox.event_id = dispatch.event_id
              AND outbox.state = 'dead_letter'
          )`
        : '';
      const row = db.prepare(`
        SELECT COUNT(DISTINCT dispatch.event_id) AS count
        FROM webhook_recipe_dispatches dispatch
        WHERE (dispatch.state = 'pending'
          OR (dispatch.state = 'running' AND NOT EXISTS (
            SELECT 1 FROM webhook_waiting_dispatches waiting
            WHERE waiting.dispatch_id = dispatch.dispatch_id
          )))
          ${underDeadLetter}
      `).get() as { count: number };
      return row.count;
    },
    isRunAuthorized,
  };
};
