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
} from '@recued/contracts';
import type { WebhookIngressStore } from './webhook-ingress-store.js';

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
  requirements: readonly PackWebhookRequirement[];
  selections: readonly WebhookIngressBindingSelection[];
  recipes: readonly WebhookConsumerRecipeDeclaration[];
  /** Pack installation defaults to armed. Standalone Kitchen saves pass false
   * so selecting an ingress cannot silently start autonomous execution. */
  enabled?: boolean;
}

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

type DispatchState = 'pending' | 'running' | 'dispatched' | 'cancelled';

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
}

export interface WebhookAwaitingApprovalDispatch {
  dispatch_id: string;
  run_id: string;
  recipe_id: string;
}

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

export interface WebhookConsumerStore {
  replaceConsumer(input: ReplaceWebhookConsumerInput): WebhookConsumerSnapshot;
  /** Commit the replacement represented by `prior` after the caller's
   * cross-store mutation succeeds. Until this point old in-flight dispatches
   * remain detached so rollback can restore them without losing claim state. */
  finalizeConsumerReplacement(prior: WebhookConsumerSnapshot): void;
  removeConsumer(
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): WebhookConsumerSnapshot;
  restoreConsumer(snapshot: WebhookConsumerSnapshot): void;
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
  hasDispatchTarget(ingressId: string, providerEventType: string): boolean;
  prepareDispatches(input: {
    event: AcceptedWebhookEventRecord;
    delivery: AcceptedWebhookDeliveryRecord;
  }): WebhookPreparedDispatch[];
  beginDispatch(input: {
    dispatch_id: string;
    event: AcceptedWebhookEventRecord;
    delivery: AcceptedWebhookDeliveryRecord;
  }): WebhookDispatchClaim | null;
  markDispatchAwaitingApproval(dispatchId: string, claimToken: string): void;
  listAwaitingApprovalDispatches(): WebhookAwaitingApprovalDispatch[];
  /** Take a bounded fair reconciliation batch. Selected rows rotate behind
   * untouched rows using a logical timestamp so a long-lived hold cannot starve
   * a newer terminal decision. */
  takeAwaitingApprovalDispatches(limit: number): WebhookAwaitingApprovalDispatch[];
  /** Resolve a durable owner hold. `failed` is terminal for this target (for
   * example an owner denial), so it cancels rather than requeues the dispatch. */
  resolveAwaitingApprovalDispatch(input: {
    dispatch_id: string;
    run_id: string;
    outcome: 'succeeded' | 'failed';
  }): boolean;
  markDispatchSucceeded(dispatchId: string, claimToken: string): void;
  markDispatchCancelled(dispatchId: string, claimToken: string): void;
  markDispatchFailed(dispatchId: string, claimToken: string): void;
  isRunAuthorized(input: {
    run_id: string;
    recipe_id: string;
    event: AcceptedWebhookEventRecord;
    delivery: AcceptedWebhookDeliveryRecord;
    require_payload_access: boolean;
  }): boolean;
}

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
      dispatch_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'running', 'dispatched', 'cancelled')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      claim_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (event_id, trigger_id),
      CHECK (
        (state = 'running' AND claim_token IS NOT NULL)
        OR (state <> 'running' AND claim_token IS NULL)
      )
    );

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
    --   trigger_id = ? with state IN ('pending','running'); the plan becomes
    --   SEARCH ... (trigger_id=? AND state=?) rather than a seek plus a filter.
    CREATE INDEX IF NOT EXISTS idx_webhook_recipe_dispatches_trigger
      ON webhook_recipe_dispatches(trigger_id, state);

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
  `);
  // D-209 #1 — pre-existing databases created before the door column. NULL for
  // every legacy row is exactly right: no door was ever minted for them, so the
  // dispatch fail-closed floor applies until the owner re-saves.
  const triggerColumns = db.prepare(
    'PRAGMA table_info(webhook_recipe_triggers)',
  ).all() as Array<{ name: string }>;
  if (!triggerColumns.some((column) => column.name === 'contract_id')) {
    db.exec('ALTER TABLE webhook_recipe_triggers ADD COLUMN contract_id TEXT');
  }
};

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

  const cancelConsumerDispatches = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): void => {
    const stamp = now();
    db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'cancelled', claim_token = NULL, updated_at = ?
      WHERE state IN ('pending', 'running')
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

  const replaceConsumer = (
    input: ReplaceWebhookConsumerInput,
  ): WebhookConsumerSnapshot => {
    const resolved = validateReplacement(input);
    const enabled = input.enabled ?? true;
    const prior = snapshotConsumer(input.consumer_kind, input.consumer_id);
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
      // Disabled Kitchen replacements have no dispatch authority and will be
      // restamped by setConsumerEnabled(true). Do not let an exhausted or
      // future delivery clock block a revocation/disarmed save.
      const stamp = enabled
        ? bindingStampAfterAcceptedDeliveries(observedStamp)
        : observedStamp;
      deleteConsumerRows(input.consumer_kind, input.consumer_id);
      const bindingIdByName = new Map<string, string>();
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
        insertBinding({
          binding_id: bindingId,
          consumer_kind: input.consumer_kind,
          consumer_id: input.consumer_id,
          logical_binding: binding.binding,
          ingress_id: ingress.ingress_id,
          required_profile_id: ingress.profile_id,
          environment_policy: binding.environment_policy ?? 'any',
          registration_modes_json: JSON.stringify(
            binding.registration_modes ?? [ingress.registration_mode],
          ),
          required_event_types_json: JSON.stringify(
            binding.required_event_types ?? [],
          ),
          paired_connection_required:
            binding.paired_connection_slot !== undefined ? 1 : 0,
          decoded_payload_access: binding.decoded_payload_access,
          source_truth_policy: strongerSourceTruth(
            descriptor.minimum_source_truth_policy,
            binding.source_truth_policy,
          ),
          enabled: enabled ? 1 : 0,
          created_at: stamp,
          updated_at: stamp,
        });
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
              created_at: stamp,
              updated_at: stamp,
            });
          }
        }
      }
    });
    persist();
    return prior;
  };

  const removeConsumer = (
    consumerKind: WebhookConsumerKind,
    consumerId: string,
  ): WebhookConsumerSnapshot => {
    requireSafeIdentity(consumerId, 'consumer_id');
    const prior = snapshotConsumer(consumerKind, consumerId);
    assertOperationBoundCleanupAuthorityRetained(prior.bindings, null, null);
    db.transaction(() => {
      // Once the owner explicitly unbinds this consumer, no active run may
      // read its payload. Cancel those claims and release their pins before
      // deleting the authority rows so a crashed run cannot retain decoded
      // bytes forever after its outbox item is otherwise resolved.
      cancelConsumerDispatches(consumerKind, consumerId);
      deleteConsumerRows(consumerKind, consumerId);
    })();
    return prior;
  };

  const finalizeConsumerReplacement = (
    prior: WebhookConsumerSnapshot,
  ): void => {
    if (prior.consumer_kind !== 'pack_install'
      && prior.consumer_kind !== 'local_recipe') {
      throw new WebhookConsumerStoreError('invalid', 'consumer_kind is invalid');
    }
    requireSafeIdentity(prior.consumer_id, 'consumer_id');
    const triggerIds = [...new Set(prior.triggers.map((row) => row.trigger_id))];
    if (triggerIds.length === 0) return;
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) {
      throw new WebhookConsumerStoreError('invalid', 'webhook consumer clock is invalid');
    }
    const cancelDispatch = db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'cancelled', claim_token = NULL, updated_at = ?
      WHERE trigger_id = ? AND state IN ('pending', 'running')
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
    db.transaction(() => {
      for (const triggerId of triggerIds) {
        requireSafeIdentity(triggerId, 'trigger_id');
        cancelDispatch.run(stamp, triggerId);
        releasePins.run(triggerId);
        releaseWaits.run(triggerId);
      }
    })();
  };

  const restoreConsumer = (snapshot: WebhookConsumerSnapshot): void => {
    requireSafeIdentity(snapshot.consumer_id, 'consumer_id');
    const restore = db.transaction(() => {
      // Any run created under the attempted replacement must lose authority
      // before the prior snapshot is restored. Dispatches belonging to the
      // prior snapshot were detached (not cancelled) by replaceConsumer and
      // regain their exact trigger ids below.
      cancelConsumerDispatches(snapshot.consumer_kind, snapshot.consumer_id);
      deleteConsumerRows(snapshot.consumer_kind, snapshot.consumer_id);
      for (const row of snapshot.bindings) insertBinding({ ...row });
      for (const row of snapshot.triggers) insertTrigger({ ...row });
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
      if (!enabled) cancelConsumerDispatches(consumerKind, consumerId);
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
        WHERE event_id = ? AND state IN ('pending', 'running')
      `).all(event.event_id) as DispatchSqlRow[];
      for (const dispatch of existing) {
        if (currentTriggerIds.has(dispatch.trigger_id)) continue;
        const triggerStillAttached = db.prepare(`
          SELECT 1 FROM webhook_recipe_triggers WHERE trigger_id = ?
        `).get(dispatch.trigger_id);
        if (!triggerStillAttached) {
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
        db.prepare(`
          UPDATE webhook_recipe_dispatches SET
            state = 'cancelled', claim_token = NULL, updated_at = ?
          WHERE dispatch_id = ? AND state IN ('pending', 'running')
        `).run(stamp, dispatch.dispatch_id);
        db.prepare('DELETE FROM webhook_payload_pins WHERE pin_id = ?')
          .run(dispatch.dispatch_id);
        db.prepare(`
          DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?
        `).run(dispatch.dispatch_id);
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
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
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
          );
          dispatch = db.prepare(`
            SELECT * FROM webhook_recipe_dispatches WHERE dispatch_id = ?
          `).get(dispatchId) as DispatchSqlRow;
        }
        result.push(preparedFrom(dispatch, target));
      }
      return result;
    });
    return prepare();
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
  }) => {
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
      if (dispatch.state === 'dispatched' || dispatch.state === 'cancelled') return null;
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
      const target = currentTargetById(
        dispatch.trigger_id,
        event.ingress_id,
        event.provider_event_type,
        delivery.received_at,
      );
      const stamp = now();
      if (!target
        || target.binding_id !== dispatch.binding_id
        || target.recipe_id !== dispatch.recipe_id
        || target.publisher_id !== dispatch.publisher_id) {
        db.prepare(`
          UPDATE webhook_recipe_dispatches SET
            state = 'cancelled', claim_token = NULL, updated_at = ?
          WHERE dispatch_id = ?
        `).run(stamp, dispatch_id);
        db.prepare('DELETE FROM webhook_payload_pins WHERE pin_id = ?')
          .run(dispatch_id);
        db.prepare(`
          DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?
        `).run(dispatch_id);
        return null;
      }
      const claimToken = newClaimToken();
      requireSafeIdentity(claimToken, 'claim_token');
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = 'running', attempt_count = attempt_count + 1,
          claim_token = ?, updated_at = ?
        WHERE dispatch_id = ?
      `).run(claimToken, stamp, dispatch_id);
      db.prepare(`
        INSERT INTO webhook_payload_pins (
          pin_id, event_id, run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pin_id) DO UPDATE SET
          event_id = excluded.event_id,
          run_id = excluded.run_id,
          updated_at = excluded.updated_at
      `).run(dispatch_id, event.event_id, dispatch.run_id, stamp, stamp);
      return {
        ...preparedFrom({
          ...dispatch,
          state: 'running',
          attempt_count: dispatch.attempt_count + 1,
          claim_token: claimToken,
          updated_at: stamp,
        }, target),
        claim_token: claimToken,
        attempt_count: dispatch.attempt_count + 1,
      };
    });
    return claim();
  };

  const finishDispatch = (
    dispatchId: string,
    claimToken: string,
    state: 'pending' | 'dispatched' | 'cancelled',
  ): void => {
    const finish = db.transaction(() => {
      const updated = db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = ?, claim_token = NULL, updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(state, now(), dispatchId, claimToken);
      if (updated.changes !== 1) {
        throw new WebhookConsumerStoreError(
          'stale_claim',
          'webhook recipe dispatch claim is stale',
        );
      }
      db.prepare('DELETE FROM webhook_payload_pins WHERE pin_id = ?')
        .run(dispatchId);
      db.prepare('DELETE FROM webhook_waiting_dispatches WHERE dispatch_id = ?')
        .run(dispatchId);
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
      db.prepare(`
        UPDATE webhook_recipe_dispatches SET updated_at = ?
        WHERE dispatch_id = ? AND state = 'running' AND claim_token = ?
      `).run(stamp, dispatchId, claimToken);
    });
    mark();
  };

  const selectAwaitingApprovalDispatches = (
    limit?: number,
  ): WebhookAwaitingApprovalDispatch[] => db.prepare(`
    SELECT
      waiting.dispatch_id AS dispatch_id,
      waiting.run_id AS run_id,
      dispatch.recipe_id AS recipe_id
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
  `).all(...(limit === undefined ? [] : [limit])) as WebhookAwaitingApprovalDispatch[];

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
      const terminalState: DispatchState = input.outcome === 'succeeded'
        ? 'dispatched'
        : 'cancelled';
      const updated = db.prepare(`
        UPDATE webhook_recipe_dispatches SET
          state = ?, claim_token = NULL, updated_at = ?
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
    finalizeConsumerReplacement,
    removeConsumer,
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
    doorContractIdForRecipe,
    hasDispatchTarget(ingressId, providerEventType) {
      return currentTargets(ingressId, providerEventType).length > 0;
    },
    prepareDispatches,
    beginDispatch,
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
    markDispatchFailed(dispatchId, claimToken) {
      finishDispatch(dispatchId, claimToken, 'pending');
    },
    isRunAuthorized,
  };
};
