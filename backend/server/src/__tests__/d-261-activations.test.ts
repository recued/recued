import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Schedule } from '@recued/scheduler';
import { PREAPPROVAL_LIMITS } from '@recued/contracts';
import { createScheduleStore } from '../schedule-store.js';
import { createAutoRunSettingsStore, createCircuitBreakerStore } from '../auto-run-scheduler.js';
import { listAutoRun } from '../auto-run-handler.js';
import { createPreapprovalTriggerIngress } from '../storage/preapproval-trigger-ingress.js';
import type { WarehouseEvent } from '@recued/warehouse-events';
import { createEventTriggersStore } from '../triggers/store.js';
import { createRecipeStore } from '../recipe-store.js';
import { createDishStore } from '../dish-store.js';
import { createDishGroupStore } from '../dish-group-store.js';
import { createPreapprovalRecipeSources } from '../preapproval-recipe-sources.js';
import { createScheduler } from '../scheduler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import { createPreapprovalActivations } from '../storage/preapproval-activations.js';
import { registerPreapprovalInvalidator } from '../storage/preapproval-lifecycle.js';
import { fixtureRecipe, preparedPlan, repositoryFixture, decisionInput, ownerResponder } from './d-261-fixtures.js';

const databases: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const schedule = (): Schedule => ({
  schedule_id: 'schedule-reviewed', recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core',
  cron_expression: '* * * * *', enabled: true, created_at: 0, last_run_at: null,
  next_run_at: 60_000, last_status: null, last_error: null,
});
const connect = (db = new Database(':memory:'), state = { now: 1_000, locked: false }) => {
  databases.push(db);
  const schedules = createScheduleStore(db);
  const autoRun = createAutoRunSettingsStore(db);
  const circuits = createCircuitBreakerStore(db);
  const triggers = createEventTriggersStore(db);
  const recipes = createRecipeStore('/d261-no-bundled-recipes', db);
  const activations = createPreapprovalActivations({ db, schedules, autoRun, circuits, triggers, recipes, now: () => state.now });
  const { repository, codec } = repositoryFixture(db, state, {
    validateLive: (plan, stage) => activations.validate(plan, !['prepare', 'decide'].includes(stage)),
    activate: activations.activate,
    selectOccurrence: (plan, candidate) => activations.selectOccurrence(plan, candidate.future_execution_ref,
      candidate.occurrence_key, candidate.payload_hash),
  });
  registerPreapprovalInvalidator(db, (kind, key, incarnation) => repository.invalidateDependency(kind, key, incarnation));
  const triggerIngress = createPreapprovalTriggerIngress(db, codec, () => state.now);
  return { db, state, schedules, autoRun, circuits, triggers, recipes, activations, repository, triggerIngress };
};
type Fixture = ReturnType<typeof connect>;
const planFor = (f: Fixture, owner = true) => {
  const plan = preparedPlan();
  if (owner) plan.origin = { mode: 'owner', owner_id: 'realm', entry: 'owner_ui', credential_id: ownerResponder.key,
    entry_tool_grants: [], recipe_grant_key: null, display_name: 'You', credential_label: null,
    source: { channel: 'user', actor: 'user_self', user_id: 'realm', client_token_id: ownerResponder.key } };
  plan.request.activation = { kind: 'next_schedule', schedule_id: schedule().schedule_id, expected_revision: 1 };
  plan.request.decision_deadline = 50_000; plan.request.dispatch_deadline = 90_000;
  plan.target = f.activations.prepareTarget(plan.request);
  return plan;
};
const approve = async (f: Fixture, plan = planFor(f)) => {
  const result = await f.repository.prepare(plan, false);
  const input = await decisionInput(f.repository, result.proposal_id);
  await f.repository.decide(input, ownerResponder);
  return { ...result, plan };
};

describe('D-261 activation in actual automation stores', () => {
  it('retains the first event and its acceptance sequence across a real SQLite reopen and competing root claims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd261-trigger-')); dirs.push(dir);
    const path = join(dir, 'realm.sqlite'); const f = connect(new Database(path));
    const trigger = f.triggers.create({ trigger_id: 'event-trigger', recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core',
      enabled: true, pattern: 'data.test.live.item.updated', created_at: 1_000 });
    const event: WarehouseEvent = { platform: 'test', slug: 'live', entity_type: 'item', event_kind: 'updated', record_id: 'a', at: 1_001,
      record: { message: 'Keep the first event' } };
    const old = f.activations.captureTrigger(trigger, event, f.triggerIngress)!;
    expect(old.kind).toBe('ordinary');
    const plan = preparedPlan(); plan.request.activation = { kind: 'next_trigger', trigger_id: trigger.trigger_id, expected_revision: 1 };
    plan.target = f.activations.prepareTarget(plan.request);
    const approved = await approve(f, plan);
    expect(f.activations.captureTrigger(trigger, event, f.triggerIngress)).toBeNull();
    const next = { ...event, at: 1_002 };
    expect(f.activations.captureTrigger(trigger, next, f.triggerIngress)).toMatchObject({ kind: 'preapproved' });
    expect(f.activations.captureTrigger(trigger, { ...next, at: 1_003 }, f.triggerIngress)).toBeNull();
    f.db.close();
    const reopened = connect(new Database(path));
    const second = connect(new Database(path));
    const selected = await reopened.triggerIngress.read(approved.future_execution_ref);
    expect(selected.event).toEqual(next);
    expect(reopened.activations.captureTrigger(trigger, { ...next, at: 1_004 }, reopened.triggerIngress)).toBeNull();
    const attempts = await Promise.allSettled([reopened, second].map((reader, i) => reader.repository.claimRun({
      future_execution_ref: approved.future_execution_ref, run_id: `event-run-${i}`, worker_id: `worker-${i}`,
      occurrence_key: selected.candidate.event_key, occurrence_sequence: 1, payload_hash: selected.candidate.payload_hash,
    })));
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const winner = attempts.find(item => item.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Missing winning event claim');
    await reopened.repository.finishRun(winner.value, 'succeeded');
    reopened.activations.retire(approved.future_execution_ref);
    expect(reopened.activations.captureTrigger(trigger, next, reopened.triggerIngress)).toBeNull();
    const fresh = reopened.activations.captureTrigger(trigger, { ...next, at: 1_005 }, reopened.triggerIngress);
    // The fixture has contract origin: retirement cannot create an owner rule.
    expect(fresh).toBeNull();
    expect(reopened.db.prepare('SELECT * FROM preapproval_occurrences WHERE future_ref=?').all(approved.future_execution_ref)).toHaveLength(1);
  });
  it('bounds qualification history and unfinished polls without granting or reviving a pruned poll', async () => {
    const f = connect();
    f.recipes.save({ ...fixtureRecipe, auto_run: { interval_ms: 60_000, default_enabled: false } }, 'core', 'inline');
    const plan = preparedPlan(); plan.request.activation = { kind: 'next_auto_run', recipe_id: fixtureRecipe.recipe_id,
      publisher_id: 'core', expected_revision: 1 }; plan.target = f.activations.prepareTarget(plan.request);
    const approved = await approve(f, plan);
    const oldest = (await f.repository.beginAutoRunPoll(approved.future_execution_ref, 'worker')).binding;
    f.db.prepare('INSERT INTO checkpoints(key,data) VALUES(?,?)').run('old-poll-checkpoint', JSON.stringify({ run_id: oldest.run_id }));
    f.db.prepare('UPDATE preapproval_polls SET checkpoint_id=? WHERE poll_id=?').run('old-poll-checkpoint', oldest.poll_id);
    f.repository.finishPoll(oldest);
    const replaced = (await f.repository.beginAutoRunPoll(approved.future_execution_ref, 'worker')).binding;
    f.db.prepare('INSERT INTO checkpoints(key,data) VALUES(?,?)').run('replaced-checkpoint', JSON.stringify({ run_id: 'another-run' }));
    f.db.prepare('UPDATE preapproval_polls SET checkpoint_id=? WHERE poll_id=?').run('replaced-checkpoint', replaced.poll_id);
    f.repository.finishPoll(replaced);
    for (let index = 0; index < PREAPPROVAL_LIMITS.candidate_calls + 2; index++) {
      f.repository.finishPoll((await f.repository.beginAutoRunPoll(approved.future_execution_ref, 'worker')).binding);
    }
    expect(f.db.prepare("SELECT count(*) AS count FROM preapproval_polls WHERE state='finished'").get()).toEqual({ count: PREAPPROVAL_LIMITS.candidate_calls });
    expect(f.db.prepare('SELECT data FROM checkpoints WHERE key=?').get('old-poll-checkpoint')).toBeUndefined();
    expect(f.db.prepare('SELECT data FROM checkpoints WHERE key=?').get('replaced-checkpoint')).toEqual({ data: JSON.stringify({ run_id: 'another-run' }) });
    await expect(f.repository.validatePoll(oldest)).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    for (let index = 0; index < PREAPPROVAL_LIMITS.candidate_calls; index++) await f.repository.beginAutoRunPoll(approved.future_execution_ref, 'worker');
    await expect(f.repository.beginAutoRunPoll(approved.future_execution_ref, 'worker')).rejects.toMatchObject({ code: 'preapproval_limit_exceeded' });
    const inspection = await f.repository.inspect(approved.proposal_id);
    expect(inspection.execution_status).toBe('active'); expect(inspection.members.every(member => member.status === 'available')).toBe(true);
  });
  it('the real Arm status exposes a lifecycle revision and projects a reviewed next run while its legacy row is parked', async () => {
    const f = connect();
    f.recipes.save({ ...fixtureRecipe, auto_run: { interval_ms: 60_000, default_enabled: false } }, 'core', 'inline');
    const status = () => listAutoRun({ recipeStore: f.recipes, settingsStore: f.autoRun, circuitStore: f.circuits,
      getHandle: () => undefined, preapprovalStatus: f.activations.describeAutoRun }).entries[0]!;
    expect(status()).toMatchObject({ recipe_id: fixtureRecipe.recipe_id, enabled: false, lifecycle_revision: 1 });
    const plan = preparedPlan();
    plan.request.activation = { kind: 'next_auto_run', recipe_id: fixtureRecipe.recipe_id,
      publisher_id: 'core', expected_revision: status().lifecycle_revision! };
    plan.target = f.activations.prepareTarget(plan.request);
    const approved = await approve(f, plan);
    expect(f.autoRun.isEnabled(fixtureRecipe.recipe_id, false)).toBe(false);
    expect(status()).toMatchObject({ enabled: true, lifecycle_revision: 1, preapproval: {
      proposal_id: approved.proposal_id, future_execution_ref: approved.future_execution_ref, execution_status: 'active',
    } });
    f.repository.cancelExecution(approved.future_execution_ref);
    expect(status()).toMatchObject({ enabled: false, preapproval: { execution_status: 'cancelled' } });
    expect(f.activations.retire(approved.future_execution_ref)).toBe(true);
    expect(status()).toMatchObject({ enabled: false });
    expect(status().preapproval).toBeUndefined();
  });
  it('a real activation write failure rolls back the decision, grant, challenge use and parking together', async () => {
    const f = connect(); f.schedules.set(schedule());
    const result = await f.repository.prepare(planFor(f), false);
    const decision = await decisionInput(f.repository, result.proposal_id);
    f.db.exec(`CREATE TRIGGER fail_preapproval_activation BEFORE INSERT ON preapproval_activations
      BEGIN SELECT RAISE(ABORT, 'activation failed'); END`);
    await expect(f.repository.decide(decision, ownerResponder)).rejects.toThrow('activation failed');
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(true);
    expect(f.db.prepare('SELECT * FROM preapproval_decisions').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM preapproval_grants').all()).toHaveLength(0);
    f.db.exec('DROP TRIGGER fail_preapproval_activation');
    await expect(f.repository.decide(decision, ownerResponder)).resolves.toMatchObject({ decision: 'approve' });
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(false);
  });
  it('parks the actual schedule atomically; statistics retain identity, legacy enabling is refused', async () => {
    const f = connect(); f.schedules.set(schedule());
    const approved = await approve(f);
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(false);
    expect(f.activations.resolveAutomationActivation('next_schedule', schedule().schedule_id, false))
      .toMatchObject({ kind: 'preapproved', future_execution_ref: approved.future_execution_ref, due_at: 60_000 });
    f.schedules.updateRun(schedule().schedule_id, { last_status: 'skipped', last_error: null });
    expect(() => f.activations.validate(approved.plan)).not.toThrow();
    expect(() => f.schedules.updateRun(schedule().schedule_id, { enabled: true }))
      .toThrow(/Cancel it before enabling/);
    expect((await f.repository.inspect(approved.proposal_id)).execution_status).toBe('active');
    f.repository.cancelExecution(approved.future_execution_ref);
    expect(f.activations.retire(approved.future_execution_ref)).toBe(true);
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(true);
    expect(f.schedules.wasPreapprovalOccurrenceConsumed!(schedule().schedule_id, 'due:60000')).toBe(true);
    expect(f.schedules.get(schedule().schedule_id)?.last_run_at).toBeNull();
  });

  it('honors an explicit pause of a physically parked row and deletion/recreation never revives approval', async () => {
    const f = connect(); f.schedules.set(schedule());
    const approved = await approve(f);
    f.schedules.updateRun(schedule().schedule_id, { enabled: false });
    expect((await f.repository.inspect(approved.proposal_id)).execution_status).toBe('invalidated');
    f.activations.retire(approved.future_execution_ref);
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(false);
    const original = approved.plan.target.incarnation;
    f.schedules.delete(schedule().schedule_id); f.schedules.set(schedule());
    const next = planFor(f);
    expect(next.target.incarnation).not.toBe(original);
    expect((await f.repository.inspect(approved.proposal_id)).execution_status).toBe('invalidated');
  });

  it('fails a decision after an ordinary qualifying fire even when the configuration is unchanged', async () => {
    const f = connect(); f.schedules.set(schedule());
    const plan = planFor(f); const result = await f.repository.prepare(plan, false);
    const input = await decisionInput(f.repository, result.proposal_id);
    f.schedules.noteQualifyingOccurrence!(schedule().schedule_id, 'due:60000');
    await expect(f.repository.decide(input, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(true);
    expect(f.db.prepare('SELECT * FROM preapproval_activations').all()).toHaveLength(0);
  });

  it('the actual cron loop skips the cancelled occurrence after restoring the recurring rule', async () => {
    const f = connect(); f.schedules.set(schedule()); const approved = await approve(f);
    f.repository.cancelExecution(approved.future_execution_ref); f.activations.retire(approved.future_execution_ref);
    f.state.now = 60_000;
    let dispatched = 0;
    const scheduler = createScheduler({ store: f.schedules, now: () => f.state.now,
      executeDeps: { recipeStore: f.recipes } as ExecuteHandlerDeps,
      execute: async () => { dispatched++; throw new Error('Unexpected cancelled dispatch'); } });
    expect(await scheduler.tick()).toEqual([]);
    expect(dispatched).toBe(0);
  });

  it('pins saved config sources; a new default or delete/recreate of the recipe seals existing approval', async () => {
    const f = connect(); f.schedules.set(schedule()); f.recipes.save(fixtureRecipe, 'core', 'inline');
    const dishes = createDishStore(f.db); const groups = createDishGroupStore(f.db);
    const plan = planFor(f);
    const load = createPreapprovalRecipeSources({ db: f.db, recipes: f.recipes, dishes, groups,
      schedules: f.schedules, autoRun: f.autoRun, triggers: f.triggers }, { ...plan.recipe, target: plan.target });
    const source = load(plan.recipe.recipe_id, plan.recipe.publisher_id)!;
    expect(source).not.toBeNull(); plan.dependencies.push(...source.dependencies);
    const approved = await approve(f, plan);
    dishes.set({ dish_id: 'dsh_default', recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core',
      name: '', is_default: true, config_overlay: { to: 'changed@example.com' }, enabled: true, created_at: 2_000 });
    expect((await f.repository.inspect(approved.proposal_id)).execution_status).toBe('invalidated');
    f.activations.retire(approved.future_execution_ref);
    // Restore the original material to demonstrate that invalidation is final.
    dishes.delete('dsh_default');
    f.recipes.delete(fixtureRecipe.recipe_id); f.recipes.save(fixtureRecipe, 'core', 'inline');
    expect((await f.repository.inspect(approved.proposal_id)).execution_status).toBe('invalidated');
    expect(load(plan.recipe.recipe_id, plan.recipe.publisher_id)!.dependencies.find(pin => pin.kind === 'recipe')!.incarnation)
      .not.toBe(source.dependencies.find(pin => pin.kind === 'recipe')!.incarnation);
  });

  it('two SQLite connections select one run/occurrence and never restore while it is running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd261-activation-')); dirs.push(dir);
    const file = join(dir, 'realm.db'); const state = { now: 1_000, locked: false };
    const first = connect(new Database(file), state); first.db.pragma('journal_mode = WAL');
    first.schedules.set(schedule()); const second = connect(new Database(file), state);
    const approved = await approve(first); state.now = 60_000;
    const attempts = await Promise.allSettled([first, second].map((f, i) => f.repository.claimRun({
      future_execution_ref: approved.future_execution_ref, run_id: `run-${i}`, worker_id: `worker-${i}`,
      occurrence_key: 'due:60000', occurrence_sequence: 1,
    })));
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(first.db.prepare('SELECT * FROM preapproval_occurrences').all()).toHaveLength(1);
    expect(second.activations.retire(approved.future_execution_ref)).toBe(false);
    const winner = attempts.find(item => item.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('No winner');
    await first.repository.finishRun(winner.value, 'succeeded');
    expect(second.activations.retire(approved.future_execution_ref)).toBe(true);
    expect(first.schedules.get(schedule().schedule_id)).toMatchObject({ enabled: true, last_run_at: 60_000 });
    expect(first.schedules.get(schedule().schedule_id)!.next_run_at).toBeGreaterThan(60_000);
  });

  it('a dispatching cancelled attempt keeps its rule parked, including after an uncertain outcome', async () => {
    const f = connect(); f.schedules.set(schedule()); const approved = await approve(f);
    f.state.now = 60_000;
    const run = await f.repository.claimRun({ future_execution_ref: approved.future_execution_ref,
      run_id: 'run', worker_id: 'worker', occurrence_key: 'due:60000', occurrence_sequence: 1 });
    const claim = await f.repository.claimMember(run, approved.plan.members[0]!);
    f.repository.cancelExecution(approved.future_execution_ref);
    expect(f.activations.retire(approved.future_execution_ref)).toBe(false);
    await f.repository.settleMember(claim, { status: 'in_doubt', message: 'No response', result: null });
    await f.repository.finishRun(run, 'failed');
    expect(f.activations.retire(approved.future_execution_ref)).toBe(false);
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(false);
  });

  it('same-run retries retain the exact event payload identity', async () => {
    const f = connect(); f.schedules.set(schedule()); const approved = await approve(f);
    f.state.now = 60_000;
    const candidate = { future_execution_ref: approved.future_execution_ref,
      run_id: 'run', worker_id: 'worker', occurrence_key: 'due:60000', occurrence_sequence: 1,
      payload_hash: preapprovalHash({ event: 'first' }) };
    const binding = await f.repository.claimRun(candidate);
    expect(await f.repository.claimRun(candidate)).toEqual(binding);
    await expect(f.repository.claimRun({ ...candidate, payload_hash: preapprovalHash({ event: 'different' }) }))
      .rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.db.prepare('SELECT * FROM preapproval_occurrences').all()).toHaveLength(1);
  });

  it('an external contract never falls back to the owner/system recurring rule', async () => {
    const f = connect(); f.schedules.set(schedule()); const approved = await approve(f, planFor(f, false));
    f.repository.cancelExecution(approved.future_execution_ref); f.activations.retire(approved.future_execution_ref);
    expect(f.schedules.get(schedule().schedule_id)?.enabled).toBe(false);
  });

  it('one-shot approval creates only a disabled schedule and its deletion invalidates the grant', async () => {
    const f = connect(); const plan = preparedPlan();
    plan.target = f.activations.prepareTarget(plan.request);
    expect(f.schedules.list()).toHaveLength(0);
    const approved = await approve(f, plan);
    expect(f.schedules.get(plan.target.key)).toMatchObject({ enabled: false, mode: 'one_shot', run_at: 10_000 });
    f.schedules.delete(plan.target.key);
    expect((await f.repository.inspect(approved.proposal_id)).execution_status).toBe('invalidated');
  });

  it('trigger edits and auto-run pause/circuit changes reach the same lifecycle coordinator', async () => {
    const f = connect();
    f.triggers.create({ trigger_id: 'trigger', recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core',
      enabled: true, pattern: 'data.file.received', created_at: 1_000, filter: { kind: 'pdf' } });
    const triggerPlan = preparedPlan(); triggerPlan.request.activation = { kind: 'next_trigger', trigger_id: 'trigger', expected_revision: 1 };
    triggerPlan.target = f.activations.prepareTarget(triggerPlan.request);
    const triggerApproval = await approve(f, triggerPlan);
    expect(f.triggers.get('trigger')?.enabled).toBe(false);
    f.triggers.update('trigger', { last_error: 'stats only' });
    expect((await f.repository.inspect(triggerApproval.proposal_id)).execution_status).toBe('active');
    f.triggers.update('trigger', { pattern: 'data.mail.received' });
    expect((await f.repository.inspect(triggerApproval.proposal_id)).execution_status).toBe('invalidated');

    f.recipes.save({ ...fixtureRecipe, auto_run: { interval_ms: 60_000 } }, 'core', 'inline');
    f.autoRun.setEnabled(fixtureRecipe.recipe_id, true);
    const autoPlan = preparedPlan(); autoPlan.request.activation = { kind: 'next_auto_run', recipe_id: fixtureRecipe.recipe_id,
      publisher_id: 'core', expected_revision: 1 }; autoPlan.target = f.activations.prepareTarget(autoPlan.request);
    const autoApproval = await approve(f, autoPlan);
    expect(f.autoRun.isEnabled(fixtureRecipe.recipe_id)).toBe(false);
    f.circuits.set({ recipe_id: fixtureRecipe.recipe_id, consecutive_failures: 3, auto_disabled: true });
    expect((await f.repository.inspect(autoApproval.proposal_id)).execution_status).toBe('invalidated');
    f.activations.retire(autoApproval.future_execution_ref);
    expect(f.autoRun.isEnabled(fixtureRecipe.recipe_id)).toBe(false);
  });
});
