import type Database from 'better-sqlite3';
import { RpcError, AUTO_RUN_SERVER_FLOOR_MS, cronZoneFor, type EventTrigger, type RehearsalTarget,
  type RehearsalConfiguration, type RehearsalDocument, type RehearsalDecision, type RehearsalComparison } from '@recued/contracts';
import { createAutoRunScheduler, MIN_CRON_INTERVAL_MS, validateCronInterval } from '@recued/scheduler';
import { isValidPattern, type WarehouseEvent } from '@recued/warehouse-events';
import type { ScheduleHandlerDeps } from './schedule-handler.js';
import { updateSchedule } from './schedule-handler.js';
import type { TriggersRpcDeps } from './triggers/handler.js';
import { triggerPreapprovalMaterial } from './triggers/store.js';
import type { AutoRunRpcDeps } from './auto-run-handler.js';
import type { RecipeStore } from './recipe-store.js';
import type { DishStore } from './dish-store.js';
import { schedulePreapprovalMaterial } from './schedule-store.js';
import { synchronizePreapprovalIdentity, preapprovalLogicalEnabled } from './storage/preapproval-lifecycle.js';
import { selectTriggerEvent, selectRecurringScheduleTick, isTriggerRunOutcomeLoop } from './automation-start-decisions.js';
import { preapprovalHash as digest } from './preapproval-invocations.js';
import { emitSchedule, emitAutomationRule } from './events/emit-sites.js';

export interface AutomationRehearsalHostDeps {
  db: Database.Database; schedules: ScheduleHandlerDeps; triggers: TriggersRpcDeps; timers: AutoRunRpcDeps;
  recipes: RecipeStore; dishes: DishStore;
}
export const REHEARSAL_COVERAGE = [
  'Scenarios select a possible run from a synthetic event or one clock tick. They execute no recipe, provider, watcher, queue or approval.',
  'Event cases reuse pattern and payload filters, including mail-fact field rules. Chat-mail and source-readiness flags belong to the fixture; no mailbox or backfill is queried.',
  'Clock cases reuse cron/missed-run selection and the isolated auto-run scheduler. Their last-run, due-time, overlap and circuit state are fixture values, not live cursors.',
  'Live read visibility, event coalescing, source availability, required child calls, connection health, execution permissions and recipe trigger steps still apply. Situation feeds need separate qualification.',
];
export const createAutomationRehearsalHost = (deps: AutomationRehearsalHostDeps) => {
  for (const store of [deps.schedules.store, deps.triggers.store, deps.timers.settingsStore, deps.timers.circuitStore, deps.recipes, deps.dishes]) {
    if (store.realmDatabase !== deps.db) throw new Error('Automation configuration and rehearsal history must share the same realm database.');
  }
  const lifecycleKind = (target: RehearsalTarget) => target.kind === 'trigger' ? 'next_trigger' : target.kind === 'timer' ? 'next_auto_run' : 'next_schedule';
  const context = (target: RehearsalTarget) => deps.db.transaction(() => {
    const trigger = target.kind === 'trigger' ? deps.triggers.store.get(target.id) : null;
    const schedule = target.kind === 'schedule' ? deps.schedules.store.get(target.id) : null;
    const timer = target.kind === 'timer' ? deps.timers.settingsStore.get(target.id) : null;
    const recipeId = trigger?.recipe_id ?? schedule?.recipe_id ?? timer?.recipe_id ?? null;
    const recipe = recipeId ? deps.recipes.get(recipeId) : null, stored = recipeId ? deps.recipes.getStored(recipeId) : null;
    const dishId = trigger?.dish_id ?? schedule?.dish_id ?? timer?.dish_id ?? null;
    const dish = dishId ? deps.dishes.get(dishId) : null;
    const zone = cronZoneFor(schedule ?? {}, deps.schedules.serverTimeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const circuit = target.kind === 'timer' ? deps.timers.circuitStore.get(target.id) : null;
    const liveCircuit = target.kind === 'timer' ? deps.timers.getHandle()?.roster.get(target.id) : undefined;
    const parked = deps.db.prepare('SELECT future_ref FROM preapproval_activations WHERE target_kind=? AND target_key=? AND retired_at IS NULL')
      .get(lifecycleKind(target), target.id) ?? null;
    const lineage = deps.db.prepare("SELECT 1 FROM sqlite_master WHERE name='preapproval_state'").get()
      ? deps.db.prepare('SELECT lineage FROM preapproval_state WHERE singleton=1').pluck().get() : null;
    let current: RehearsalConfiguration | null = null;
    if (trigger) current = { kind: 'trigger', enabled: deps.triggers.store.ownerEnabled(target.id), pattern: trigger.pattern,
      filter: trigger.filter as Record<string, string | number | boolean> ?? null, fields: trigger.fields ?? null,
      watch_interval_ms: trigger.watch_interval_ms ?? null };
    if (schedule) current = { kind: 'schedule', enabled: preapprovalLogicalEnabled(deps.db, lifecycleKind(target), target.id, schedule.enabled),
      cron_expression: schedule.cron_expression, missed_policy: schedule.missed_policy ?? 'auto' };
    if (timer) current = { kind: 'timer', enabled: deps.timers.settingsStore.ownerEnabled(target.id), reset_circuit: false };
    const publisher = trigger?.publisher_id ?? schedule?.publisher_id ?? dish?.publisher_id;
    let reason: string | undefined;
    if (!current || !recipe || !stored) reason = 'Choose an existing automation of an installed recipe.';
    else if (!dish || dish.recipe_id !== recipeId || dish.publisher_id !== publisher || stored.publisher_id !== publisher) reason = 'This automation needs its original installed recipe and dish.';
    else if (!lineage) reason = 'Automation rehearsal is unavailable on this server.';
    else if (parked) reason = 'This automation has a reviewed future run. Resolve or cancel that review before changing its configuration here.';
    else if (schedule?.mode === 'one_shot') reason = 'One-shot schedules keep their existing retry and review controls. Rehearsal covers recurring schedules.';
    else if (trigger?.read_contract_id) reason = 'Contract-bound subscriptions keep their existing controls. Rehearsal covers ordinary event triggers.';
    else if (timer && !recipe.auto_run) reason = 'The recipe no longer declares an automatic timer.';
    if (!reason) {
      if (trigger) synchronizePreapprovalIdentity(deps.db, 'next_trigger', target.id,
        triggerPreapprovalMaterial({ ...trigger, enabled: deps.triggers.store.ownerEnabled(target.id) }));
      if (schedule) synchronizePreapprovalIdentity(deps.db, 'next_schedule', target.id,
        schedulePreapprovalMaterial({ ...schedule, enabled: current!.enabled }));
      if (timer) synchronizePreapprovalIdentity(deps.db, 'next_auto_run', target.id, { enabled: current!.enabled });
    }
    const pins = [
      [lifecycleKind(target), target.id], ['dish', dishId ?? ''], ['recipe', recipeId ?? ''],
    ].map(([kind, key]) => deps.db.prepare('SELECT kind,key,incarnation,revision,content_hash,present FROM preapproval_resource_identity WHERE kind=? AND key=?').get(kind, key) ?? null);
    const basis = { target, current, recipe, publisher: stored?.publisher_id, dish, pins, lineage, parked, zone,
      circuit, live_circuit: liveCircuit ? { auto_disabled: liveCircuit.auto_disabled, failures: liveCircuit.consecutive_failures } : null };
    return { target, label: (recipe?.metadata.name ?? target.id) + ' · ' + target.kind, supported: !reason, ...(reason ? { reason } : {}),
      recipe_id: recipeId, dish_id: dishId, time_zone: zone,
      interval_ms: recipe?.auto_run ? Math.max(AUTO_RUN_SERVER_FLOOR_MS, recipe.auto_run.interval_ms) : null,
      live_digest: digest(basis), current, trigger, schedule, timer, dish, recipe,
      circuit_tripped: circuit?.auto_disabled === true || liveCircuit?.auto_disabled === true };
  }).immediate();
  const project = (target: RehearsalTarget, candidate: RehearsalConfiguration) => {
    const live = context(target);
    if (!live.supported || !live.current) throw new RpcError('automation_rehearsal_unsupported', live.reason!, 409);
    if (candidate.kind !== target.kind) throw new RpcError('bad_request', 'The proposed configuration must match the automation kind.', 400);
    if (candidate.kind === 'trigger') {
      if (!isValidPattern(candidate.pattern)) throw new RpcError('bad_request', 'Use a valid warehouse event pattern.', 400);
      if (live.trigger?.origin === 'recipe' && digest({ ...candidate, enabled: live.current.enabled }) !== digest(live.current)) {
        throw new RpcError('automation_rehearsal_unsupported', 'This trigger comes from its recipe. Only its switch can change here; edit its pattern and filters in the recipe.', 409);
      }
    }
    if (candidate.kind === 'schedule') {
      const check = validateCronInterval(candidate.cron_expression, deps.schedules.cronFloorMs ?? MIN_CRON_INTERVAL_MS);
      if (!check.valid) throw new RpcError('invalid_cron', check.error ?? 'Invalid cron expression.', 400);
    }
    if (candidate.enabled) {
      const gate = target.kind === 'trigger' ? deps.triggers.unattendedSettings : target.kind === 'timer' ? deps.timers.unattendedSettings : deps.schedules.unattendedSettings;
      gate?.assertStart({ recipe_id: live.recipe_id!, dish_id: live.dish_id! });
      const missing = deps.schedules.missingPackDepsForRecipe?.(live.recipe_id!) ?? [];
      if (missing.length) throw new RpcError('automation_rehearsal_unsupported', 'Install the recipe’s required packs before enabling this automation.', 409);
    }
    return live;
  };
  const evaluate = (target: RehearsalTarget, document: RehearsalDocument): RehearsalComparison => {
    const live = project(target, document.candidate);
    const decide = (configuration: RehearsalConfiguration, item: RehearsalDocument['cases'][number]): RehearsalDecision => {
      const answer = (verdict: RehearsalDecision['verdict'], detail: string): RehearsalDecision => ({ verdict, detail });
      if (configuration.kind === 'trigger') {
        if (item.input.kind !== 'event') return answer('unsupported', 'An event trigger needs an event scenario.');
        const event = item.input.event as WarehouseEvent;
        if (event.platform === 'situation') return answer('unsupported', 'Situation feed checkpoints need separate qualification.');
        if (!configuration.enabled || !live.dish?.enabled) return answer('skip', 'The trigger or its dish is switched off.');
        if (!item.input.source_ready || event.in_drain) return answer('skip', 'The fixture source is still draining.');
        if (isTriggerRunOutcomeLoop(live.trigger!, event, id => deps.triggers.store.get(id))) return answer('skip', 'A run-outcome event cannot restart its own recipe through a sibling trigger.');
        if (event.platform === 'mail' && item.input.chat_mail) return answer('skip', 'The fixture marks this mail as a conversation with Recued.');
        const trigger: EventTrigger = { ...live.trigger!, ...configuration,
          filter: configuration.filter ?? undefined, fields: configuration.fields ?? undefined, watch_interval_ms: configuration.watch_interval_ms ?? undefined };
        return selectTriggerEvent(trigger, event) ? answer('start', 'Pattern and payload filters select a possible run before later live checks.')
          : answer('skip', 'The event does not meet the pattern, payload filter, changed-field or self-loop rules.');
      }
      if (item.input.kind !== 'clock') return answer('unsupported', 'A timer or recurring schedule needs a clock scenario.');
      const clock = item.input;
      if (!configuration.enabled || !live.dish?.enabled) return answer('skip', 'The automation or its dish is switched off.');
      if (clock.running) return answer('skip', 'The fixture has an overlapping run.');
      if (configuration.kind === 'schedule') {
        const schedule = { ...live.schedule!, ...configuration, last_run_at: clock.last_run_at,
          missed_answer: undefined };
        const selection = selectRecurringScheduleTick(schedule, clock.at, live.time_zone);
        if (selection === 'regular' && clock.last_run_at !== null && Math.floor(clock.last_run_at / 60_000) === Math.floor(clock.at / 60_000)) return answer('skip', 'This fixture already fired in the current cron minute.');
        if (selection === 'regular' || selection === 'fire') return answer('start', selection === 'regular' ? 'The clock matches a regular cron occurrence.' : 'The missed-run policy selects a catch-up.');
        return answer(selection === 'ask' ? 'ask' : 'skip', selection === 'ask' ? 'The missed-run policy waits for the owner.' : 'No occurrence is selected by this clock and missed-run policy.');
      }
      const scheduler = createAutoRunScheduler({ mintProcessId: () => 'rehearsal' });
      scheduler.setRoster([{ recipe_id: live.recipe_id!, dish_id: target.id, publisher_id: live.dish!.publisher_id,
        interval_ms: live.interval_ms!, dynamic: live.recipe!.auto_run?.dynamic ?? false, process_id: 'rehearsal',
        next_run_at: clock.next_run_at, consecutive_failures: 0, auto_disabled: clock.auto_disabled && !configuration.reset_circuit }]);
      const result = scheduler.tick(clock.at);
      return answer(result.fired.length ? 'start' : 'skip', result.fired.length ? 'The isolated timer selects a due run.' : result.skipped_circuit.length ? 'The fixture circuit is tripped.' : 'The fixture timer is not due.');
    };
    const cases = document.cases.map(item => {
      let before: RehearsalDecision, after: RehearsalDecision;
      try { before = decide(live.current!, item); after = decide(document.candidate, item); }
      catch (error) { before = after = { verdict: 'unsupported', detail: error instanceof Error ? error.message : 'This scenario cannot be evaluated.' }; }
      return { id: item.id, name: item.name, expected: item.expected, current: before, candidate: after, passed: after.verdict === item.expected };
    });
    return { cases, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, coverage: [...REHEARSAL_COVERAGE] };
  };
  return { context, project, evaluate, sharesRealm: (db: Database.Database): boolean => deps.db === db,
    apply(target: RehearsalTarget, candidate: RehearsalConfiguration): void {
      if (!deps.db.inTransaction) throw new Error('Reviewed automation activation requires the realm transaction.');
      const live = project(target, candidate);
      if (candidate.kind === 'trigger') deps.triggers.store.update(target.id, { enabled: candidate.enabled, pattern: candidate.pattern,
        filter: candidate.filter, fields: candidate.fields, watch_interval_ms: candidate.watch_interval_ms });
      else if (candidate.kind === 'schedule') {
        const { eventBus: _eventBus, auditLog: _audit, ...quiet } = deps.schedules;
        updateSchedule(quiet, target.id, { enabled: candidate.enabled, cron_expression: candidate.cron_expression, missed_policy: candidate.missed_policy });
      } else {
        if (live.current?.enabled !== candidate.enabled) deps.timers.settingsStore.setEnabled(target.id, live.recipe_id!, candidate.enabled);
        if (candidate.reset_circuit) deps.timers.circuitStore.clear(target.id);
      }
    },
    async refresh(target: RehearsalTarget, configuration: RehearsalConfiguration): Promise<void> {
      if (target.kind === 'trigger') { deps.triggers.dispatcher?.rebuild(); deps.triggers.onRulesChanged?.(); emitAutomationRule(deps.triggers.eventBus, 'event_trigger'); }
      else if (target.kind === 'schedule') emitSchedule(deps.schedules.eventBus, 'updated');
      else {
        if (configuration.kind === 'timer' && configuration.reset_circuit) deps.timers.getHandle()?.resetCircuit(target.id);
        await deps.timers.getHandle()?.refreshRoster(); emitAutomationRule(deps.timers.eventBus, 'auto_run');
      }
    },
  };
};
export type AutomationRehearsalHost = ReturnType<typeof createAutomationRehearsalHost>;
