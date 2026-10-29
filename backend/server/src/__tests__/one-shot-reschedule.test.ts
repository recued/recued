import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Schedule } from '@recued/scheduler';
import { SERVER_RPC_METHOD_SET } from '@recued/contracts';
import { createScheduleStore } from '../schedule-store.js';
import { listSchedules, rescheduleOneShot, updateSchedule, makeScheduleHandlers, type ScheduleHandlerDeps } from '../schedule-handler.js';
import { createScheduler } from '../scheduler.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createAutoRunSettingsStore, createCircuitBreakerStore } from '../auto-run-scheduler.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { createPreapprovalActivations } from '../storage/preapproval-activations.js';
import { registerPreapprovalInvalidator } from '../storage/preapproval-lifecycle.js';
import { fixtureRecipe, preparedPlan, repositoryFixture, decisionInput, ownerResponder } from './d-261-fixtures.js';

const databases: Database.Database[] = [], dirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = Date.UTC(2030, 0, 1);
const schedule = (enabled = true): Schedule => ({
  schedule_id: 'one-off', recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core', dish_id: 'saved-dish',
  mode: 'one_shot', run_at: NOW + 3_600_000, cron_expression: '0 1 1 1 *', time_zone: 'UTC',
  enabled, created_at: NOW - 1000, last_run_at: null, prev_run_at: null,
  next_run_at: NOW + 3_600_000, last_status: null, last_error: null, missed_policy: 'ask',
});
const connect = (db = new Database(':memory:'), clock = { now: NOW }) => {
  databases.push(db);
  const store = createScheduleStore(db), recipes = createRecipeStore('/no-bundled-recipes', db);
  recipes.save(fixtureRecipe, 'core', 'inline');
  const deps: ScheduleHandlerDeps = { store, now: () => clock.now, instanceId: 'local-test', serverTimeZone: () => 'Asia/Hong_Kong' };
  const view = () => listSchedules(deps, {}).schedules[0]!;
  const move = (at: number, revision = view().reschedule_revision!) => rescheduleOneShot(deps, {
    schedule_id: 'one-off', run_at: at, expected_revision: revision,
  }).schedule;
  const executeDeps = { recipeStore: recipes,
    executorConfig: { manifests: createManifestRegistry('/no-bundled-manifests'), vault: {} }, baseVault: {}, instanceId: 'local-test' };
  return { db, store, recipes, clock, deps, view, move, executeDeps };
};
const result = () => ({ recipe_id: fixtureRecipe.recipe_id, recipe_hash: 'fixture', success: false,
  output: { render: [], sidebar: [] }, steps: [], errors: [{ code: 'fixture', message: 'Local execution only' }], duration_ms: 0 });

// Behavioral contracts: no provider, real SQLite identities and scheduler admission.
describe('pending one-off rescheduling', () => {
  it.each([true, false])('preserves the saved instance and state (enabled=%s), with an absolute time and matching stored cron', enabled => {
    const f = connect(), original = schedule(enabled); f.store.set(original);
    f.deps.dishStore = { get: () => ({ dish_id: 'saved-dish', recipe_id: original.recipe_id, publisher_id: 'core',
      name: 'Saved settings', is_default: false, config_overlay: { destination: 'saved@example.test' }, enabled: true, created_at: NOW }) };
    const revision = f.view().reschedule_revision!;
    const after = f.move(NOW + 3 * 86_400_000 + 12 * 3_600_000);
    expect(f.store.get('one-off')).toEqual({ ...original, run_at: after.run_at, next_run_at: after.run_at, cron_expression: '0 12 4 1 *' });
    expect(after.config_overlay).toEqual({ destination: 'saved@example.test' });
    expect(after.reschedule_revision).not.toBe(revision);
    expect(after.enabled).toBe(enabled);
    expect(SERVER_RPC_METHOD_SET.has('schedules.reschedule')).toBe(true);
    expect(makeScheduleHandlers(f.deps)?.methods).toContain('schedules.reschedule');
    // An unchanged time cannot create another revision or retire a review.
    expect(f.move(after.run_at!).reschedule_revision).toBe(after.reschedule_revision);
  });

  it('rejects malformed, non-future and out-of-range times without changing the row', () => {
    const f = connect(); f.store.set(schedule());
    const before = f.view();
    for (const at of [null, '2030-01-04T12:00', NaN, Infinity, NOW, NOW - 1, NOW + 0.5, 8_640_000_000_000_001]) {
      expect(() => rescheduleOneShot(f.deps, { schedule_id: 'one-off', expected_revision: before.reschedule_revision, run_at: at }))
        .toThrow(/future date and time/);
    }
    expect(() => rescheduleOneShot(f.deps, { schedule_id: 'one-off', run_at: NOW + 1000 })).toThrow(/expected_revision/);
    expect(f.view()).toEqual(before);
  });

  it('refuses due, recurring and completed runs, and older store implementations', () => {
    const f = connect(); f.store.set(schedule());
    const revision = f.view().reschedule_revision!;
    f.clock.now = schedule().run_at!;
    expect(f.view().reschedule_revision).toBeUndefined();
    expect(() => f.move(f.clock.now + 1000, revision)).toThrow(/has not started/);
    f.clock.now = NOW;
    f.store.set({ ...schedule(), mode: 'recurring' });
    expect(() => f.move(NOW + 5000, revision)).toThrow(/one-off/);
    f.store.set({ ...schedule(), last_run_at: NOW - 1 });
    expect(() => f.move(NOW + 5000, revision)).toThrow(/has not started/);
    f.store.set(schedule());
    const { rescheduleOneShot: _unsupported, ...legacy } = f.store;
    f.deps.store = legacy;
    expect(f.view().reschedule_revision).toBeUndefined();
    expect(() => f.move(NOW + 5000, revision)).toThrow(/cannot reschedule/);
  });

  it('refuses a stale edit after a competing pause or deletion and recreation with the same ID', () => {
    const f = connect(); f.store.set(schedule());
    const originalRevision = f.view().reschedule_revision!;
    updateSchedule(f.deps, 'one-off', { enabled: false });
    expect(() => f.move(NOW + 7200_000, originalRevision)).toThrow(/schedule changed/);
    const pausedRevision = f.view().reschedule_revision!;
    f.store.delete('one-off'); f.store.set(schedule(false));
    expect(f.view().reschedule_revision).not.toBe(pausedRevision);
    expect(() => f.move(NOW + 7200_000, pausedRevision)).toThrow(/schedule changed/);
    expect(f.store.get('one-off')).toEqual(schedule(false));
  });

  it('does not attach a newer version token to a stale schedule snapshot', () => {
    const f = connect(); f.store.set(schedule());
    const snapshot = f.store.list();
    updateSchedule(f.deps, 'one-off', { enabled: false });
    const current = f.view();
    const stale = listSchedules({ ...f.deps, store: { ...f.store, list: () => snapshot } }, {}).schedules[0]!;
    expect(stale.enabled).toBe(true);
    expect(stale.reschedule_revision).toBeUndefined();
    expect(current.reschedule_revision).toBeDefined();
  });

  it('rechecks the clock after entering the write transaction', () => {
    const f = connect(); f.store.set(schedule());
    const revision = f.view().reschedule_revision!;
    let checks = 0;
    f.deps.now = () => ++checks === 1 ? NOW : schedule().run_at! + 1000;
    expect(() => f.move(NOW + 7200_000, revision)).toThrow(/has not started/);
    expect(f.store.get('one-off')).toEqual(schedule());
  });

  it('persists the new time across reopen and runs once at that time, never at the old time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-reschedule-')); dirs.push(dir);
    const file = join(dir, 'realm.sqlite'), f = connect(new Database(file));
    const original = { ...schedule(), dish_id: undefined }; f.store.set(original);
    const next = original.run_at! + 86_400_000;
    f.move(next); f.db.close();
    const reopened = connect(new Database(file), { now: original.run_at! });
    let executions = 0;
    const scheduler = createScheduler({ store: reopened.store, executeDeps: reopened.executeDeps, now: () => reopened.clock.now,
      execute: async () => { executions++; return result(); } });
    expect(await scheduler.tick()).toEqual([]);
    reopened.clock.now = next;
    expect(await scheduler.tick()).toEqual(['one-off']);
    expect(await scheduler.tick()).toEqual([]);
    expect(executions).toBe(1);
    expect(reopened.store.get('one-off')).toMatchObject({ run_at: next, last_run_at: next, enabled: false });
  });

  it('rejects an admitted unfinished run even after the clock moves backwards and SQLite is reopened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-reschedule-admitted-')); dirs.push(dir);
    const file = join(dir, 'realm.sqlite'), f = connect(new Database(file));
    f.store.set({ ...schedule(), dish_id: undefined });
    const revision = f.view().reschedule_revision!, identity = f.view().reschedule_identity!;
    let complete!: () => void;
    const waiting = new Promise<void>(resolve => { complete = resolve; });
    const scheduler = createScheduler({ store: f.store, executeDeps: f.executeDeps, now: () => schedule().run_at!,
      execute: async () => { await waiting; return result(); } });
    const running = scheduler.tick();
    try {
      expect(f.store.get('one-off')?.last_run_at).toBeNull();
      const other = connect(new Database(file));
      expect(other.view().reschedule_revision).toBeUndefined();
      expect(other.view().reschedule_identity).toBe(identity);
      expect(() => other.move(NOW + 7200_000, revision)).toThrow(/has not started/);
      expect(other.store.get('one-off')?.run_at).toBe(schedule().run_at);
    } finally { complete(); await running; }
  });
});

describe('rescheduling and reviewed timing', () => {
  const reviewed = () => {
    const f = connect(new Database(':memory:'), { now: 1_000 });
    const activations = createPreapprovalActivations({ db: f.db, schedules: f.store, recipes: f.recipes,
      autoRun: createAutoRunSettingsStore(f.db), circuits: createCircuitBreakerStore(f.db), triggers: createEventTriggersStore(f.db), now: () => f.clock.now });
    const state = { now: 1_000, locked: false };
    const { repository } = repositoryFixture(f.db, state, {
      validateLive: (plan, stage) => activations.validate(plan, !['prepare', 'decide'].includes(stage)),
      activate: activations.activate,
      selectOccurrence: (plan, candidate) => activations.selectOccurrence(plan, candidate.future_execution_ref, candidate.occurrence_key, candidate.payload_hash),
    });
    registerPreapprovalInvalidator(f.db, (kind, key, incarnation) => repository.invalidateDependency(kind, key, incarnation));
    f.deps.preapprovalStatus = activations.describeSchedule;
    f.store.set({ ...schedule(), dish_id: undefined, run_at: 10_000, next_run_at: 10_000 });
    const plan = preparedPlan();
    plan.origin = { mode: 'owner', owner_id: 'realm', entry: 'owner_ui', credential_id: ownerResponder.key,
      entry_tool_grants: [], recipe_grant_key: null, display_name: 'You', credential_label: null,
      source: { channel: 'user', actor: 'user_self', user_id: 'realm', client_token_id: ownerResponder.key } };
    plan.request.activation = { kind: 'next_schedule', schedule_id: 'one-off', expected_revision: f.view().lifecycle_revision! };
    plan.target = activations.prepareTarget(plan.request);
    return { ...f, activations, repository, plan };
  };

  it('invalidates a pending review instead of letting the old decision approve the new time', async () => {
    const f = reviewed(), prepared = await f.repository.prepare(f.plan, false);
    const decision = await decisionInput(f.repository, prepared.proposal_id);
    f.move(20_000);
    await expect(f.repository.decide(decision, ownerResponder)).rejects.toThrow();
    expect((await f.repository.inspect(prepared.proposal_id)).execution_status).toBe('invalidated');
    expect(f.store.get('one-off')).toMatchObject({ run_at: 20_000, enabled: true, last_run_at: null });
  });

  it('moves an execution-owned one-shot under its actual lifecycle kind without carrying its approval', async () => {
    const f = reviewed(); f.store.delete('one-off');
    const plan = preparedPlan(); plan.target = f.activations.prepareTarget(plan.request);
    const prepared = await f.repository.prepare(plan, false);
    await f.repository.decide(await decisionInput(f.repository, prepared.proposal_id), ownerResponder);
    const before = listSchedules(f.deps, {}).schedules[0]!;
    const moved = rescheduleOneShot(f.deps, { schedule_id: before.schedule_id, expected_revision: before.reschedule_revision, run_at: 20_000 }).schedule;
    expect(moved).toMatchObject({ schedule_id: before.schedule_id, run_at: 20_000, enabled: false, last_run_at: null });
    expect((await f.repository.inspect(prepared.proposal_id)).execution_status).toBe('invalidated');
    f.activations.retire(prepared.future_execution_ref);
    expect(f.store.get(before.schedule_id)).toMatchObject({ run_at: 20_000, enabled: false, last_run_at: null });
  });

  it('invalidates active authority atomically and keeps the moved run paused after retirement', async () => {
    const f = reviewed(), prepared = await f.repository.prepare(f.plan, false);
    await f.repository.decide(await decisionInput(f.repository, prepared.proposal_id), ownerResponder);
    expect(f.view().enabled).toBe(true); expect(f.store.get('one-off')?.enabled).toBe(false);
    const before = f.view();
    f.db.exec("CREATE TRIGGER refuse_schedule_move BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT, 'move refused'); END");
    expect(() => f.move(20_000)).toThrow('move refused');
    expect((await f.repository.inspect(prepared.proposal_id)).execution_status).toBe('active');
    expect(f.view()).toEqual(before);
    f.db.exec('DROP TRIGGER refuse_schedule_move');
    expect(f.move(20_000)).toMatchObject({ run_at: 20_000, enabled: false });
    expect((await f.repository.inspect(prepared.proposal_id)).execution_status).toBe('invalidated');
    expect(() => f.move(10_000)).toThrow(/previous reviewed run/);
    expect(f.activations.retire(prepared.future_execution_ref)).toBe(true);
    expect(f.store.get('one-off')).toMatchObject({ run_at: 20_000, enabled: false, last_run_at: null });
    // Retiring the unused old window must not pretend the moved recipe ran.
    expect(f.view().reschedule_revision).toBeDefined();
    expect(() => f.move(10_000)).toThrow(/previous reviewed run/);
    expect(f.store.get('one-off')?.run_at).toBe(20_000);
    expect(f.move(30_000)).toMatchObject({ run_at: 30_000, enabled: false });
  });
});
