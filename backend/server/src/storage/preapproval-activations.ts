/** One logical activation path over parked legacy automation rows. This module
 * performs only synchronous realm-DB work; the engine starts after claimRun. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, matchesTriggerDispatchFilter, type AutoRunStatusEntry, type Checkpoint, type EventTrigger, type PreparePreapproval } from '@recued/contracts';
import { eventPath, matchesPattern, type WarehouseEvent } from '@recued/warehouse-events';
import { nextCronMatch, type Schedule } from '@recued/scheduler';
import type { AutoRunSettingsStore, CircuitBreakerStore } from '../auto-run-scheduler.js';
import { triggerPreapprovalMaterial, type EventTriggersStore } from '../triggers/store.js';
import type { RecipeStore } from '../recipe-store.js';
import { schedulePreapprovalMaterial, type ScheduleStore } from '../schedule-store.js';
import type { PreparedFutureExecution, PreapprovalActivationRecord, PreapprovalTargetBinding } from '../preapproval-model.js';
import type { PreapprovalTriggerIngress } from './preapproval-trigger-ingress.js';
import { triggerEventContext } from '../triggers/event-context.js';
import {
  advancePreapprovalOccurrence, createPreapprovalOwnedIdentity, initializePreapprovalLifecycle, preapprovalLogicalEnabled,
  projectPreapprovalAutomation, synchronizePreapprovalIdentity,
} from './preapproval-lifecycle.js';

interface ActivationRow {
  future_ref: string; target_kind: PreapprovalTargetBinding['kind']; target_key: string;
  target_incarnation: string; target_revision: number; original_enabled: number;
  owner_mode: 'owner' | 'contract'; owner_changed: number; due_at: number | null;
  selector_sequence: number; retired_at: number | null;
}
export type AutomationActivation =
  | { kind: 'ordinary' }
  | { kind: 'disabled' }
  | { kind: 'preapproved'; future_execution_ref: string; target_kind: PreapprovalTargetBinding['kind'];
      target_key: string; due_at: number | null; status: string; selector_sequence: number };
export type TriggerOccurrence =
  | { kind: 'ordinary'; trigger_id: string; incarnation: string; revision: number; event_key: string }
  | { kind: 'preapproved'; trigger_id: string; future_execution_ref: string; event_key: string };

export interface PreapprovalAutomationDeps {
  db: Database.Database; schedules: ScheduleStore; autoRun: AutoRunSettingsStore;
  circuits: CircuitBreakerStore; triggers: EventTriggersStore; recipes: RecipeStore;
  now?: () => number;
}

function stale(): never { throw new RpcError('preapproval_stale', 'The automation changed. Review a new execution.', 409); }

export const createPreapprovalActivations = (deps: PreapprovalAutomationDeps) => {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  initializePreapprovalLifecycle(db);
  const logical = (kind: string, key: string, value: boolean) => preapprovalLogicalEnabled(db, kind, key, value);
  const active = (kind: string, key: string): ActivationRow | null =>
    db.prepare('SELECT * FROM preapproval_activations WHERE target_kind = ? AND target_key = ? AND retired_at IS NULL')
      .get(kind, key) as ActivationRow | undefined ?? null;
  const material = (kind: PreapprovalTargetBinding['kind'], key: string): { value: unknown; enabled: boolean; recipe_id: string; publisher_id: string } | null => {
    if (kind === 'one_shot' || kind === 'next_schedule') {
      const row = deps.schedules.get(key);
      if (!row) return null;
      const enabled = logical(kind, key, row.enabled);
      return { value: schedulePreapprovalMaterial({ ...row, enabled }), enabled,
        recipe_id: row.recipe_id, publisher_id: row.publisher_id };
    }
    if (kind === 'next_trigger') {
      const row = deps.triggers.get(key);
      if (!row) return null;
      const enabled = logical(kind, key, row.enabled);
      return { value: triggerPreapprovalMaterial({ ...row, enabled }), enabled,
        recipe_id: row.recipe_id, publisher_id: row.publisher_id };
    }
    const stored = deps.recipes.getStored(key);
    const recipe = deps.recipes.get(key);
    if (!stored || !recipe?.auto_run) return null;
    const enabled = logical(kind, key, deps.autoRun.isEnabled(key, recipe.auto_run.default_enabled ?? true));
    return { value: { enabled, dish_id: deps.autoRun.getDishId(key) }, enabled,
      recipe_id: recipe.recipe_id, publisher_id: stored.publisher_id };
  };
  const validate = (plan: PreparedFutureExecution, selecting = false): void => {
    const target = plan.target;
    const current = material(target.kind, target.key);
    // A pending one-shot exists only inside its immutable proposal. Acceptance
    // atomically creates its resource identity and parked legacy schedule.
    if (target.kind === 'one_shot' && !current && !active(target.kind, target.key)
      && !db.prepare('SELECT 1 FROM preapproval_resource_identity WHERE kind=? AND key=?').get(target.kind, target.key)) {
      if (selecting || target.revision !== 1 || target.qualifying_sequence !== 0) stale();
      return;
    }
    const identity = target.kind === 'one_shot' && !current && !active(target.kind, target.key)
      ? db.prepare('SELECT * FROM preapproval_resource_identity WHERE kind = ? AND key = ? AND present = 1')
        .get(target.kind, target.key) as { incarnation: string; revision: number; qualifying_sequence: number } | undefined
      : synchronizePreapprovalIdentity(db, target.kind, target.key, current?.value ?? null);
    if (!identity || identity.incarnation !== target.incarnation || identity.revision !== target.revision) stale();
    if (!selecting && identity.qualifying_sequence !== target.qualifying_sequence) stale();
    if (target.kind === 'next_auto_run' && deps.circuits.get(target.key)?.auto_disabled) stale();
    if (current && (current.recipe_id !== plan.recipe.recipe_id || current.publisher_id !== plan.recipe.publisher_id)) stale();
  };
  const consumedTrigger = (triggerId: string, incarnation: string, eventKey: string) =>
    !!db.prepare(`SELECT 1 FROM preapproval_occurrences WHERE target_kind='next_trigger'
      AND target_key=? AND incarnation=? AND occurrence_key=?`).get(triggerId, incarnation, eventKey);
  const describeAutomation = (requestedKind: PreapprovalTargetBinding['kind'], key: string):
    Pick<AutoRunStatusEntry, 'enabled' | 'lifecycle_revision' | 'preapproval'> | null => db.transaction(() => {
      const kind = requestedKind === 'next_schedule' && db.prepare(`SELECT 1 FROM preapproval_resource_identity
        WHERE kind='one_shot' AND key=?`).get(key) ? 'one_shot' : requestedKind;
      const current = material(kind, key);
      if (!current) return null;
      const identity = synchronizePreapprovalIdentity(db, kind, key, current.value)!;
      const managed = active(kind, key);
      const execution = managed ? db.prepare('SELECT proposal_id,state,stop_requested FROM preapproval_executions WHERE future_ref=?')
        .get(managed.future_ref) as { proposal_id: string; state: string; stop_requested: number } | undefined : undefined;
      const usable = execution && !execution.stop_requested && ['active', 'running', 'held', 'in_doubt'].includes(execution.state);
      return { enabled: managed ? !!usable : current.enabled, lifecycle_revision: identity.revision,
        ...(managed && execution ? { preapproval: { proposal_id: execution.proposal_id,
          future_execution_ref: managed.future_ref, execution_status: execution.state as NonNullable<AutoRunStatusEntry['preapproval']>['execution_status'] } } : {}) };
    }).immediate();

  return {
    /** Owner status and preparation revision use the same logical target as
     * the driver. Physical parked settings must not look like a disarmed job. */
    describeAutoRun(recipeId: string): Pick<AutoRunStatusEntry, 'enabled' | 'lifecycle_revision' | 'preapproval'> | null {
      return describeAutomation('next_auto_run', recipeId);
    },
    describeTrigger: (triggerId: string) => describeAutomation('next_trigger', triggerId),
    describeSchedule: (scheduleId: string) => describeAutomation('next_schedule', scheduleId),
    /** Host preparation only. Original origin and activation permission are
     * checked by the caller, then checked again in the decision transaction. */
    prepareTarget(request: PreparePreapproval): PreapprovalTargetBinding {
      return db.transaction((): PreapprovalTargetBinding => {
        const activation = request.activation;
        if (activation.kind === 'one_shot') {
          const key = `pa_schedule_${randomUUID()}`;
          // No resource is created until the owner accepts this proposal.
          return { kind: 'one_shot', key, incarnation: randomUUID(), revision: 1,
            qualifying_sequence: 0, due_at: activation.run_at, was_enabled: false };
        }
        const key = activation.kind === 'next_schedule' ? activation.schedule_id
          : activation.kind === 'next_trigger' ? activation.trigger_id : activation.recipe_id;
        if (active(activation.kind, key)) throw new RpcError('preapproval_already_claimed', 'This automation already has a reviewed execution.', 409);
        const current = material(activation.kind, key);
        if (!current || request.subject.kind !== 'recipe' || current.recipe_id !== request.subject.recipe_id
          || current.publisher_id !== request.subject.publisher_id) stale();
        const identity = synchronizePreapprovalIdentity(db, activation.kind, key, current.value)!;
        if (identity.revision !== activation.expected_revision) stale();
        const schedule = activation.kind === 'next_schedule' ? deps.schedules.get(key)! : null;
        const due = schedule ? (schedule.mode === 'one_shot' ? schedule.run_at ?? schedule.next_run_at
          : nextCronMatch(schedule.cron_expression.trim().split(/\s+/), Math.floor(now() / 60_000) * 60_000 + 60_000)) : null;
        if (schedule && (due === null || due === undefined || due <= now())) stale();
        return { kind: activation.kind, key, incarnation: identity.incarnation, revision: identity.revision,
          qualifying_sequence: identity.qualifying_sequence, due_at: due ?? null, was_enabled: current.enabled };
      }).immediate();
    },
    validate,
    /** Synchronous bus entry. Stamp all matching source events before testing
     * ownership so an already queued ordinary event cannot take a later slot. */
    captureTrigger(trigger: EventTrigger, event: WarehouseEvent, ingress: PreapprovalTriggerIngress): TriggerOccurrence | null {
      return db.transaction((): TriggerOccurrence | null => {
        const observed = ingress.observe(event);
        const current = material('next_trigger', trigger.trigger_id);
        if (!current || current.recipe_id !== trigger.recipe_id || current.publisher_id !== trigger.publisher_id) return null;
        const actual = deps.triggers.get(trigger.trigger_id)!;
        const immutable = observed.event;
        const context = triggerEventContext(trigger.trigger_id, immutable).event as { payload: Record<string, unknown> };
        if (!matchesPattern(actual.pattern, eventPath(immutable.platform, immutable.slug, immutable.entity_type, immutable.event_kind))
          || !matchesTriggerDispatchFilter(actual, context.payload)) return null;
        const identity = synchronizePreapprovalIdentity(db, 'next_trigger', trigger.trigger_id, current.value)!;
        if (consumedTrigger(trigger.trigger_id, identity.incarnation, observed.identity.event_key)) return null;
        const managed = active('next_trigger', trigger.trigger_id);
        if (!managed) return current.enabled ? { kind: 'ordinary', trigger_id: trigger.trigger_id,
          incarnation: identity.incarnation, revision: identity.revision, event_key: observed.identity.event_key } : null;
        const execution = db.prepare('SELECT state,stop_requested FROM preapproval_executions WHERE future_ref=?')
          .get(managed.future_ref) as { state: string; stop_requested: number } | undefined;
        const window = db.prepare('SELECT after_ingress_sequence FROM preapproval_trigger_windows WHERE future_ref=?')
          .get(managed.future_ref) as { after_ingress_sequence: number } | undefined;
        if (managed.owner_changed || !execution || execution.state !== 'active' || execution.stop_requested
          || !window || observed.identity.ingress_sequence <= window.after_ingress_sequence) return null;
        const first = ingress.offer(managed.future_ref, trigger.trigger_id, observed);
        if (!first || first.event_key !== observed.identity.event_key) return null;
        return { kind: 'preapproved', trigger_id: trigger.trigger_id, future_execution_ref: managed.future_ref, event_key: first.event_key };
      }).immediate();
    },
    /** An ordinary queued event retains its captured generation. Once a new
     * owner approval owns the rule, the old event can neither inherit it nor
     * bypass it through the ordinary path. */
    claimOrdinaryTrigger(observed: Extract<TriggerOccurrence, { kind: 'ordinary' }>): boolean {
      return db.transaction(() => {
        const current = material('next_trigger', observed.trigger_id);
        if (!current?.enabled || active('next_trigger', observed.trigger_id)) return false;
        const identity = synchronizePreapprovalIdentity(db, 'next_trigger', observed.trigger_id, current.value)!;
        if (identity.incarnation !== observed.incarnation || identity.revision !== observed.revision
          || consumedTrigger(observed.trigger_id, identity.incarnation, observed.event_key)) return false;
        const sequence = advancePreapprovalOccurrence(db, 'next_trigger', observed.trigger_id);
        db.prepare(`INSERT INTO preapproval_occurrences(target_kind,target_key,incarnation,occurrence_key,
          sequence,payload_hash,future_ref,consumed_at) VALUES('next_trigger',?,?,?,?,?,NULL,?)`)
          .run(observed.trigger_id, observed.incarnation, observed.event_key, sequence, '', now());
        return true;
      }).immediate();
    },
    /** Capture an ordinary poll before entering the engine. The returned host
     * closure cannot be reconstructed from a public recipe/run identifier. A
     * poll begun before owner acceptance must not take that owner's slot. */
    ordinaryAutoRunPoll(recipeId: string, prior?: NonNullable<Checkpoint['auto_run_qualification']>) {
      if (prior && prior.recipe_id !== recipeId) stale();
      const observed = prior ?? db.transaction(() => {
        const current = material('next_auto_run', recipeId);
        if (!current?.enabled || active('next_auto_run', recipeId) || deps.circuits.get(recipeId)?.auto_disabled) stale();
        return synchronizePreapprovalIdentity(db, 'next_auto_run', recipeId, current.value)!;
      }).immediate();
      let used = false;
      const qualification = { recipe_id: recipeId, incarnation: observed.incarnation,
        revision: observed.revision, qualifying_sequence: observed.qualifying_sequence };
      return { qualification, qualify: () => db.transaction(() => {
        if (used) stale();
        const current = material('next_auto_run', recipeId);
        if (!current?.enabled || active('next_auto_run', recipeId) || deps.circuits.get(recipeId)?.auto_disabled) stale();
        const identity = synchronizePreapprovalIdentity(db, 'next_auto_run', recipeId, current.value)!;
        if (identity.incarnation !== observed.incarnation || identity.revision !== observed.revision
          || identity.qualifying_sequence !== observed.qualifying_sequence) stale();
        advancePreapprovalOccurrence(db, 'next_auto_run', recipeId);
        used = true;
      }).immediate() };
    },
    activate(plan: PreparedFutureExecution, record: PreapprovalActivationRecord): void {
      if (!db.inTransaction) throw new Error('Activation must be part of the owner decision transaction.');
      validate(plan);
      const target = plan.target;
      if (active(target.kind, target.key)) throw new RpcError('preapproval_already_claimed', 'Another approval owns this automation.', 409);
      if (target.kind === 'one_shot'
        && !db.prepare('SELECT 1 FROM preapproval_resource_identity WHERE kind=? AND key=?').get(target.kind, target.key)) {
        createPreapprovalOwnedIdentity(db, target.kind, target.key, target.incarnation,
          schedulePreapprovalMaterial(oneShotSchedule(plan, record.accepted_at)));
      }
      db.prepare(`INSERT INTO preapproval_activations(future_ref,target_kind,target_key,target_incarnation,
        target_revision,original_enabled,owner_mode,due_at,selector_sequence) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(record.future_execution_ref, target.kind, target.key, target.incarnation, target.revision,
          target.was_enabled ? 1 : 0, plan.origin.mode, target.due_at, target.qualifying_sequence);
      if (target.kind === 'next_trigger') db.prepare(`INSERT INTO preapproval_trigger_windows(future_ref,after_ingress_sequence)
        SELECT ?,COALESCE(MAX(ingress_sequence),0) FROM preapproval_trigger_ingress`).run(record.future_execution_ref);
      projectPreapprovalAutomation(db, () => {
        if (target.kind === 'one_shot') deps.schedules.set(oneShotSchedule(plan, record.accepted_at));
        else if (target.kind === 'next_schedule') deps.schedules.updateRun(target.key, { enabled: false });
        else if (target.kind === 'next_trigger') deps.triggers.update(target.key, { enabled: false });
        else deps.autoRun.setEnabled(target.key, false);
      });
    },
    /** All scheduler and UI readers use this projection. The physical row
     * remains disabled for readers that do not implement this protocol. */
    resolveAutomationActivation(kind: PreapprovalTargetBinding['kind'], key: string, legacyEnabled: boolean): AutomationActivation {
      const row = active(kind, key) ?? (kind === 'next_schedule' ? active('one_shot', key) : null);
      if (!row) return { kind: legacyEnabled ? 'ordinary' : 'disabled' };
      const execution = db.prepare('SELECT state, stop_requested FROM preapproval_executions WHERE future_ref = ?')
        .get(row.future_ref) as { state: string; stop_requested: number } | undefined;
      if (!execution || execution.stop_requested || !['active', 'running', 'held', 'in_doubt'].includes(execution.state)) return { kind: 'disabled' };
      return { kind: 'preapproved', future_execution_ref: row.future_ref, target_kind: row.target_kind,
        target_key: key, due_at: row.due_at, status: execution.state, selector_sequence: row.selector_sequence };
    },
    /** Must run in the repository's run-claim transaction. Duplicate durable
     * events return their existing sequence; they never allocate another use. */
    selectOccurrence(plan: PreparedFutureExecution, futureRef: string, occurrenceKey: string, payloadHash: string): number {
      if (!db.inTransaction) throw new Error('Occurrence selection must be atomic with run claim.');
      validate(plan, true);
      const target = plan.target;
      const activation = active(target.kind, target.key);
      if (!activation || activation.future_ref !== futureRef || activation.owner_changed) stale();
      if (target.kind === 'next_trigger') {
        const selected = db.prepare(`SELECT c.event_key,c.payload_hash,c.trigger_id,c.ingress_sequence,w.after_ingress_sequence
          FROM preapproval_trigger_candidates c JOIN preapproval_trigger_windows w ON w.future_ref=c.future_ref
          WHERE c.future_ref=?`).get(futureRef) as { event_key: string; payload_hash: string; trigger_id: string;
            ingress_sequence: number; after_ingress_sequence: number } | undefined;
        if (!selected || selected.trigger_id !== target.key || selected.event_key !== occurrenceKey
          || selected.payload_hash !== payloadHash || selected.ingress_sequence <= selected.after_ingress_sequence) stale();
      }
      const prior = db.prepare(`SELECT sequence,payload_hash,future_ref FROM preapproval_occurrences
        WHERE target_kind=? AND target_key=? AND incarnation=? AND occurrence_key=?`)
        .get(target.kind, target.key, target.incarnation, occurrenceKey) as { sequence: number; payload_hash: string; future_ref: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== payloadHash || prior.future_ref !== futureRef) stale();
        return prior.sequence;
      }
      const sequence = advancePreapprovalOccurrence(db, target.kind, target.key);
      db.prepare(`INSERT INTO preapproval_occurrences(target_kind,target_key,incarnation,occurrence_key,
        sequence,payload_hash,future_ref,consumed_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(target.kind, target.key, target.incarnation, occurrenceKey, sequence, payloadHash, futureRef, now());
      return sequence;
    },
    /** Never restore while any effect may still be running. Uncertain attempts
     * require provider evidence before a separate retirement can be allowed. */
    retire(futureRef: string): boolean {
      return db.transaction(() => {
        const row = db.prepare('SELECT * FROM preapproval_activations WHERE future_ref=? AND retired_at IS NULL')
          .get(futureRef) as ActivationRow | undefined;
        if (!row) return true;
        const execution = db.prepare('SELECT state,status_reason,occurrence_key FROM preapproval_executions WHERE future_ref=?')
          .get(futureRef) as { state: string; status_reason: string | null; occurrence_key: string | null } | undefined;
        if (!execution || ['prepared','active','running','held','in_doubt'].includes(execution.state)) return false;
        const current = material(row.target_kind, row.target_key);
        const identity = current ? synchronizePreapprovalIdentity(db, row.target_kind, row.target_key, current.value) : null;
        const restore = row.owner_mode === 'owner' && row.original_enabled === 1 && !row.owner_changed
          && execution.status_reason !== 'restored_lineage' && row.target_kind !== 'one_shot'
          && (row.target_kind !== 'next_schedule' || deps.schedules.get(row.target_key)?.mode !== 'one_shot')
          && identity?.incarnation === row.target_incarnation && identity.revision === row.target_revision
          && (row.target_kind !== 'next_auto_run' || !deps.circuits.get(row.target_key)?.auto_disabled);
        if (row.due_at !== null) {
          // A cancelled selected occurrence is also retired. This tombstone
          // skips it without inventing a future last_run_at statistic.
          db.prepare(`INSERT OR IGNORE INTO preapproval_occurrences(target_kind,target_key,incarnation,
            occurrence_key,sequence,payload_hash,future_ref,consumed_at) VALUES(?,?,?,?,?,'',?,?)`)
            .run(row.target_kind, row.target_key, row.target_incarnation, `due:${row.due_at}`,
              row.selector_sequence, row.future_ref, now());
        }
        if (row.target_kind === 'next_trigger') {
          // A cancelled first candidate must not reappear as an ordinary event
          // when the owner's recurring rule is restored.
          db.prepare(`INSERT OR IGNORE INTO preapproval_occurrences(target_kind,target_key,incarnation,
            occurrence_key,sequence,payload_hash,future_ref,consumed_at)
            SELECT 'next_trigger',?,?,event_key,?,payload_hash,future_ref,? FROM preapproval_trigger_candidates WHERE future_ref=?`)
            .run(row.target_key, row.target_incarnation, row.selector_sequence, now(), row.future_ref);
        }
        projectPreapprovalAutomation(db, () => {
          // ⛔⛔ AN APPROVED EXECUTION THAT NEVER RAN USED TO LEAVE NO TRACE.
          // The outcome below is keyed on `occurrence_key`, which is only set once
          // the run is CLAIMED — so `succeeded` and `failed` recorded a status and
          // `expired` / `invalidated` recorded nothing at all. The owner approved a
          // specific future execution, it did not happen, and no surface said so.
          //
          // 🔑 AND D-266 STRUCTURALLY CANNOT COVER IT. While the activation is live
          // the schedule is parked `enabled: false`, and `buildMissedRunReport`
          // skips disabled rows (`packages/scheduler/src/backfill.ts`). By the time
          // retirement re-enables it, the `next_run_at` written a few lines below
          // has already advanced PAST the missed occurrence. Neither the parked
          // window nor the resumed schedule can see it — so this is the only place
          // the miss can be recorded.
          //
          // ⚠ `cancelled` DELIBERATELY STAYS SILENT. The owner cancelled it; they
          // do not need to be told. Only outcomes they did not choose are reported.
          const ranTerminal = execution.occurrence_key !== null && row.due_at !== null;
          const missedUnrun = !ranTerminal && row.due_at !== null
            && (execution.state === 'expired' || execution.state === 'invalidated');
          const outcome = ranTerminal ? {
            last_run_at: row.due_at,
            last_status: execution.state === 'succeeded' ? 'success' as const : 'error' as const,
            last_error: execution.state === 'succeeded' ? null : execution.status_reason ?? execution.state,
          } : missedUnrun ? {
            // `skipped`, not `error`: nothing ran and nothing failed. The reason
            // carries the explanation, and the breaker is untouched — this writes
            // no `consecutive_failures`, so an expired window never disarms a
            // schedule.
            //
            // ⛔ AND DELIBERATELY NO `last_run_at`. The branch above sets it
            // because that execution was CLAIMED — it started and then failed, so
            // a timestamp is a fact. An expired or invalidated window never
            // started, and stamping `last_run_at` would invent a run that did not
            // happen and move the cron dedupe anchor with it. A pre-existing test
            // (`d-261-service`: "expires a missed scheduled window without
            // provider dispatch") pins `last_run_at: null` for exactly this case,
            // and it was right — the first draft of this branch set it and that
            // test caught the over-reach.
            last_status: 'skipped' as const,
            last_error: execution.status_reason ?? execution.state,
          } : {};
          if (row.target_kind === 'next_schedule') {
            const schedule = deps.schedules.get(row.target_key);
            if (schedule) deps.schedules.updateRun(row.target_key, {
              enabled: restore,
              ...outcome,
              next_run_at: schedule.mode === 'one_shot' ? null
                : nextCronMatch(schedule.cron_expression.trim().split(/\s+/), Math.max(now(), row.due_at ?? 0) + 60_000),
            });
          } else if (row.target_kind === 'next_trigger' && current) deps.triggers.update(row.target_key, { enabled: restore });
          else if (row.target_kind === 'next_auto_run' && current) deps.autoRun.setEnabled(row.target_key, restore);
          else if (row.target_kind === 'one_shot') deps.schedules.updateRun(row.target_key, { enabled: false, next_run_at: null, ...outcome });
        });
        db.prepare('UPDATE preapproval_activations SET retired_at=? WHERE future_ref=? AND retired_at IS NULL').run(now(), futureRef);
        return true;
      }).immediate();
    },
    listManaged(): Array<{ future_execution_ref: string; target_kind: PreapprovalTargetBinding['kind']; target_key: string }> {
      return db.prepare('SELECT future_ref AS future_execution_ref,target_kind,target_key FROM preapproval_activations WHERE retired_at IS NULL')
        .all() as Array<{ future_execution_ref: string; target_kind: PreapprovalTargetBinding['kind']; target_key: string }>;
    },
  };
};

const oneShotSchedule = (plan: PreparedFutureExecution, createdAt: number): Schedule => ({
  schedule_id: plan.target.key, recipe_id: plan.recipe.recipe_id, publisher_id: plan.recipe.publisher_id,
  mode: 'one_shot', cron_expression: '', run_at: plan.target.due_at!, enabled: false,
  created_at: createdAt, last_run_at: null, next_run_at: plan.target.due_at,
  last_status: null, last_error: null,
});
export type PreapprovalActivations = ReturnType<typeof createPreapprovalActivations>;
