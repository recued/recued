import { randomUUID } from 'node:crypto';
import type { RehearsalTarget, RehearsalDocument, RehearsalCase, Dish } from '@recued/contracts';
import { resourceFixture } from './preapproval-resources-fixture.js';
import { createCircuitBreakerStore } from '../auto-run-scheduler.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createAutomationRehearsalHost } from '../automation-rehearsal-host.js';
import { createAutomationRehearsalStore } from '../storage/automation-rehearsal-store.js';

export const rehearsalFixture = async (kind: RehearsalTarget['kind'] = 'trigger') => {
  const { vi } = await import('vitest');
  const f = await resourceFixture(); f.clock.now = Date.parse('2026-10-19T00:10:00Z');
  const recipe = { ...f.recipe, recipe_id: 'rehearsal-fixture', steps: [], auto_run: { interval_ms: 300_000 } };
  f.execution.recipeStore.save(recipe, 'core', 'inline', f.clock.now);
  const dish: Dish = { dish_id: 'rehearsal-dish', recipe_id: recipe.recipe_id, publisher_id: 'core',
    name: 'Rehearsal dish', is_default: true, enabled: true, config_overlay: {}, created_at: f.clock.now };
  f.sources.dishes.set(dish);
  f.sources.triggers.create({ trigger_id: 'rehearsal-trigger', recipe_id: recipe.recipe_id, publisher_id: 'core', dish_id: dish.dish_id,
    enabled: false, pattern: 'data.task.main.task.created', filter: { 'record.status': 'ready' }, created_at: f.clock.now, origin: 'user' });
  f.sources.schedules.set({ schedule_id: 'rehearsal-schedule', recipe_id: recipe.recipe_id, publisher_id: 'core', dish_id: dish.dish_id,
    enabled: false, cron_expression: '*/5 * * * *', time_zone: 'UTC', missed_policy: 'skip', created_at: f.clock.now,
    last_run_at: null, next_run_at: null, last_status: null, last_error: null });
  f.sources.autoRun.setEnabled(dish.dish_id, recipe.recipe_id, false);
  const circuit = createCircuitBreakerStore(f.db), changedRules = vi.fn(), settingsGate = vi.fn();
  let zone = 'UTC'; const key = { locked: false }, codec = createPreapprovalCodec(() => key.locked ? null : new Uint8Array(32).fill(9));
  const { host, store } = rehearsalStores(f, codec, { circuit, changedRules, settingsGate, zone: () => zone });
  const target: RehearsalTarget = { kind, id: kind === 'trigger' ? 'rehearsal-trigger' : kind === 'schedule' ? 'rehearsal-schedule' : dish.dish_id };
  const actor = JSON.stringify([f.token.token_id, f.clients.get(f.token.token_id)?.metadata?.instance_id]);
  const check = () => { if (f.clients.get(f.token.token_id)?.revoked_at !== null) throw new Error('Owner revoked'); };
  const document = (): RehearsalDocument => {
    const current = host.context(target).current!;
    const first: RehearsalCase = { id: 'selected', name: 'Selected fixture', expected: 'start', input: kind === 'trigger'
      ? { kind: 'event', source_ready: true, chat_mail: false, event: { platform: 'task', slug: 'main', entity_type: 'task', event_kind: 'created', record_id: 'fixture-record', at: f.clock.now, record: { status: 'ready' } } }
      : { kind: 'clock', at: f.clock.now, last_run_at: null, next_run_at: f.clock.now, running: false, auto_disabled: false } };
    const second = structuredClone(first); second.id = 'excluded'; second.name = 'Excluded fixture'; second.expected = 'skip';
    if (second.input.kind === 'event') second.input.event.record = { status: 'blocked' };
    else if (kind === 'timer') second.input.next_run_at = f.clock.now + 60_000;
    else second.input.at += 120_000;
    return { title: 'Private automation scenarios', candidate: { ...current, enabled: true }, cases: [first, second] };
  };
  const save = async (doc = document()) => { const current = await store.read(target, actor, check);
    return store.save({ target, expected_revision: current.revision, expected_live_digest: current.live_digest, request_id: randomUUID(), document: doc }, actor, check); };
  const ready = async (doc = document()) => { const saved = await save(doc), tested = await store.test({ target, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, actor, check);
    const review = await store.prepare({ target, expected_revision: tested.revision, draft_revision: tested.draft!.revision, receipt_id: tested.qualification!.receipt_id }, actor, check);
    return { saved, tested, review, request: { target, expected_revision: tested.revision, review_id: review.review_id, request_id: randomUUID() } }; };
  return { ...f, target, host, store, codec, key, actor, check, document, save, ready, dish, testedRecipe: recipe, circuit, changedRules, settingsGate,
    setZone: (value: string) => { zone = value; }, reopenStore: () => createAutomationRehearsalStore(f.db, codec, host, () => f.clock.now),
    reopenRehearsals: async () => { const next = await f.reopen(); return { ...next, ...rehearsalStores(next, codec) }; } };
};

export const rehearsalStores = (f: Awaited<ReturnType<typeof resourceFixture>>, codec: ReturnType<typeof createPreapprovalCodec>, options: {
  circuit?: ReturnType<typeof createCircuitBreakerStore>; changedRules?: () => void; settingsGate?: () => void; zone?: () => string;
} = {}) => {
  const circuit = options.circuit ?? createCircuitBreakerStore(f.db);
  const host = createAutomationRehearsalHost({ db: f.db, recipes: f.execution.recipeStore, dishes: f.sources.dishes,
    schedules: { store: f.sources.schedules, instanceId: 'fixture', serverTimeZone: options.zone ?? (() => 'UTC'), now: () => f.clock.now,
      unattendedSettings: { assertStart: options.settingsGate ?? (() => {}) }, missingPackDepsForRecipe: () => [] },
    triggers: { store: f.sources.triggers, onRulesChanged: options.changedRules ?? (() => {}), unattendedSettings: { assertStart: options.settingsGate ?? (() => {}) } },
    timers: { recipeStore: f.execution.recipeStore, settingsStore: f.sources.autoRun, circuitStore: circuit, getHandle: () => undefined,
      dishStore: f.sources.dishes, unattendedSettings: { assertStart: options.settingsGate ?? (() => {}) } } });
  const store = createAutomationRehearsalStore(f.db, codec, host, () => f.clock.now);
  return { host, store, circuit };
};
