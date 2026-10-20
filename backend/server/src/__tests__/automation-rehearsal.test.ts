import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MAIL_FACT_EVENT_PLATFORM, parseRehearsalDocument } from '@recued/contracts';
import { rehearsalFixture } from './automation-rehearsal-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';
import { createAutomationRehearsalStore } from '../storage/automation-rehearsal-store.js';
import { createScheduler } from '../scheduler.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';

afterEach(async () => { vi.restoreAllMocks(); for (const close of resourceFixtureDisposers.splice(0).reverse()) await close(); });
for (const kind of ['trigger', 'schedule', 'timer'] as const) {
  it('rehearses ' + kind + ' selection without writes, cursors, dispatch or provider calls', async () => {
    const f = await rehearsalFixture(kind), saved = await f.save();
    const before = { schedules: f.sources.schedules.list(), triggers: f.sources.triggers.list(), timers: f.sources.autoRun.list(), circuit: f.circuit.list() };
    const result = await f.store.test({ target: f.target, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
    expect(result.comparison.cases.map(item => [item.current.verdict, item.candidate.verdict])).toEqual([['skip', 'start'], ['skip', 'skip']]);
    expect(result.qualification).not.toBeNull(); expect(f.sources.schedules.list()).toEqual(before.schedules);
    expect(f.sources.triggers.list()).toEqual(before.triggers); expect(f.sources.autoRun.list()).toEqual(before.timers); expect(f.circuit.list()).toEqual(before.circuit);
    expect(f.calendarUpdates).not.toHaveBeenCalled(); expect(f.calendarDeletes).not.toHaveBeenCalled(); expect(f.changedRules).not.toHaveBeenCalled();
    expect(JSON.stringify(f.db.prepare('SELECT * FROM automation_rehearsals').all())).not.toContain('Private automation scenarios');
  });
  it('atomically activates reviewed ' + kind + ' configuration and recovers its exact receipt', async () => {
    const f = await rehearsalFixture(kind), { request } = await f.ready(), refresh = vi.spyOn(f.host, 'refresh');
    const applied = await f.store.activate(request, f.actor, f.check); expect(applied.activated?.sequence).toBe(1);
    expect(f.host.context(f.target).current?.enabled).toBe(true); expect(applied.qualification).toBeNull();
    const again = await f.reopenStore().activate(request, f.actor, f.check); expect(again.activated).toEqual(applied.activated);
    expect(again.mutation_revision).toBe(applied.mutation_revision); expect(refresh).toHaveBeenCalledTimes(1);
  });
}
for (const change of ['configuration', 'configuration-aba', 'dish', 'recipe', 'realm', 'owner', 'lock', 'expiry', 'parked', 'settings'] as const) {
  it('refuses activation after ' + change, async () => {
    const f = await rehearsalFixture(), { request } = await f.ready();
    if (change === 'configuration' || change === 'configuration-aba') { f.sources.triggers.update(f.target.id, { pattern: 'data.file.**' }); if (change === 'configuration-aba') f.sources.triggers.update(f.target.id, { pattern: 'data.task.main.task.created' }); }
    if (change === 'dish') f.sources.dishes.set({ ...f.dish, config_overlay: { changed: true } });
    if (change === 'recipe') f.execution.recipeStore.save({ ...f.testedRecipe, version: 2 }, 'core', 'inline');
    if (change === 'realm') f.db.prepare('UPDATE preapproval_state SET lineage=? WHERE singleton=1').run(randomUUID());
    if (change === 'owner') f.clients.revoke(f.token.token_id, 'revoked', f.clock.now);
    if (change === 'lock') f.key.locked = true;
    if (change === 'expiry') f.clock.now += 300_001;
    if (change === 'parked') f.db.prepare("INSERT INTO preapproval_activations(future_ref,target_kind,target_key,target_incarnation,target_revision,original_enabled,owner_mode,owner_changed,due_at,selector_sequence,retired_at) VALUES('parked','next_trigger',?,'fixture',1,0,'retain',0,NULL,0,NULL)").run(f.target.id);
    if (change === 'settings') f.settingsGate.mockImplementation(() => { throw new Error('Required settings changed'); });
    await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow();
    expect(f.sources.triggers.get(f.target.id)?.enabled).toBe(false);
  });
}
for (const field of ['missed_policy', 'time_zone'] as const) it('fences a schedule ' + field + ' edit and undo', async () => {
  const f = await rehearsalFixture('schedule'), { request } = await f.ready(), original = f.sources.schedules.get(f.target.id)!;
  f.sources.schedules.set({ ...original, [field]: field === 'missed_policy' ? 'ask' : 'Asia/Hong_Kong' }); f.sources.schedules.set(original);
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toMatchObject({ code: 'automation_rehearsal_conflict' });
});
it('requires fresh proof and isolates it to the paired owner that ran the scenarios', async () => {
  const f = await rehearsalFixture(), { request } = await f.ready();
  expect((await f.store.read(f.target, 'other-owner', f.check)).qualification).toBeNull();
  await expect(f.store.activate(request, 'other-owner', f.check)).rejects.toThrow();
});
it('invalidates passing proof before an interrupted newer test opens private cases', async () => {
  const f = await rehearsalFixture(), { saved, request } = await f.ready();
  vi.spyOn(f.codec, 'open').mockRejectedValueOnce(new Error('Interrupted decrypt'));
  await expect(f.store.test({ target: f.target, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check)).rejects.toThrow();
  expect((await f.store.read(f.target, f.actor, f.check)).qualification).toBeNull();
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow();
});
it('fails unsupported scenarios rather than treating them as safe skips', async () => {
  const f = await rehearsalFixture(), doc = f.document(); doc.cases[0]!.input = { kind: 'clock', at: f.clock.now, next_run_at: f.clock.now, last_run_at: null, running: false, auto_disabled: false }; doc.cases[0]!.expected = 'skip';
  const saved = await f.save(doc), result = await f.store.test({ target: f.target, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(result.comparison.cases[0]?.candidate.verdict).toBe('unsupported'); expect(result.qualification).toBeNull();
});
it('rechecks the private read at the loader return boundary', async () => {
  const f = await rehearsalFixture(); await f.save(); const open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec, 'open').mockImplementationOnce(async encrypted => { const value = await open(encrypted);
    queueMicrotask(() => queueMicrotask(() => f.clients.revoke(f.token.token_id, 'revoked after private load', f.clock.now))); return value; });
  await expect(f.store.read(f.target, f.actor, f.check)).rejects.toThrow('Owner revoked');
});
it('rolls configuration and receipt back if final history persistence fails', async () => {
  const f = await rehearsalFixture(), { request } = await f.ready(), prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => { if (sql.includes('INSERT INTO automation_rehearsals')) throw new Error('Injected history failure'); return prepare(sql); });
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow('Injected');
  expect(f.sources.triggers.get(f.target.id)?.enabled).toBe(false); expect(f.changedRules).not.toHaveBeenCalled();
  vi.restoreAllMocks(); expect((await f.store.read(f.target, f.actor, f.check)).history).toHaveLength(0);
});
it('holds activation if configuration changes while encrypting the completion receipt', async () => {
  const f = await rehearsalFixture(), { request } = await f.ready(), seal = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec, 'seal').mockImplementationOnce(async state => { const encrypted = await seal(state); f.sources.triggers.update(f.target.id, { pattern: 'data.file.**' }); return encrypted; });
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow(); expect(f.sources.triggers.get(f.target.id)?.enabled).toBe(false);
});
it('permits only one of two competing activation requests', async () => {
  const f = await rehearsalFixture(), { request } = await f.ready();
  const result = await Promise.allSettled([f.store.activate(request, f.actor, f.check), f.store.activate({ ...request, request_id: randomUUID() }, f.actor, f.check)]);
  expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect((await f.store.read(f.target, f.actor, f.check)).history).toHaveLength(1);
});
it('retains versioned working copies without silently replacing the saved head', async () => {
  const f = await rehearsalFixture(), first = await f.save(), second = f.document(); second.title = 'Later cases'; const latest = await f.save(second);
  const selected = await f.store.read(f.target, f.actor, f.check, first.draft!.revision);
  expect(selected.revision).toBe(latest.revision); expect(selected.draft!.document.title).toBe('Later cases'); expect(selected.selected_draft!.document.title).toBe(first.draft!.document.title);
});
it('deletes private history after the target is removed while keeping a monotonic tombstone', async () => {
  const f = await rehearsalFixture(), saved = await f.save(); f.sources.triggers.remove(f.target.id); const requestId = randomUUID();
  const deleted = await f.store.delete(f.target, saved.revision, requestId, f.actor, f.check);
  expect(await f.store.delete(f.target, saved.revision, requestId, f.actor, f.check)).toEqual(deleted);
  const read = await f.store.read(f.target, f.actor, f.check); expect(read.supported).toBe(false); expect(read.draft).toBeNull(); expect(read.revision).toBe(2);
});
it('requires a same-realm writer and private history store', async () => {
  const first = await rehearsalFixture(), other = await rehearsalFixture();
  expect(() => createAutomationRehearsalStore(first.db, first.codec, other.host)).toThrow('same realm');
});
it('reuses mail-fact field filtering and initial-drain suppression', async () => {
  const f = await rehearsalFixture(); f.sources.triggers.update(f.target.id, { pattern: 'data.' + MAIL_FACT_EVENT_PLATFORM + '.main.*.*', filter: null });
  const doc = f.document(); if (doc.candidate.kind !== 'trigger') throw new Error('fixture'); doc.candidate.pattern = 'data.' + MAIL_FACT_EVENT_PLATFORM + '.main.*.*'; doc.candidate.filter = null;
  const event = doc.cases[0]!.input; if (event.kind !== 'event') throw new Error('fixture'); event.event.platform = MAIL_FACT_EVENT_PLATFORM; event.event.entity_type = 'shipment'; event.event.event_kind = 'updated';
  event.event.prev = {}; event.event.changed_fields = ['last_email_at']; doc.cases = [{ ...doc.cases[0]!, expected: 'skip' }];
  const saved = await f.save(doc), result = await f.store.test({ target: f.target, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(result.comparison.cases[0]?.candidate.verdict).toBe('skip');
  doc.cases[0]!.input = { ...event, event: { ...event.event, in_drain: true } }; expect(f.host.evaluate(f.target, doc).cases[0]?.candidate.verdict).toBe('skip');
});
it('rehearses circuit reset without clearing the live circuit until activation', async () => {
  const f = await rehearsalFixture('timer'); f.circuit.set({ dish_id: f.target.id, recipe_id: f.testedRecipe.recipe_id, consecutive_failures: 5, auto_disabled: true });
  const doc = f.document(); if (doc.candidate.kind !== 'timer') throw new Error('fixture'); doc.candidate.reset_circuit = true;
  for (const item of doc.cases) if (item.input.kind === 'clock') item.input.auto_disabled = true;
  const { request } = await f.ready(doc); expect(f.circuit.get(f.target.id)?.auto_disabled).toBe(true);
  const applied = await f.store.activate(request, f.actor, f.check); expect(f.circuit.get(f.target.id)).toBeNull();
  expect(applied.activated?.circuit_reset).toBe(true); expect((await f.store.read(f.target, f.actor, f.check)).history[0]?.circuit_reset).toBe(true);
});
it('keeps the commit receipt when runtime refresh fails and never repeats a reset on retry', async () => {
  const f = await rehearsalFixture('timer'), { request } = await f.ready(); vi.spyOn(f.host, 'refresh').mockRejectedValue(new Error('Runtime unavailable'));
  const first = await f.store.activate(request, f.actor, f.check); expect(first.refresh_warning).toContain('Configuration committed');
  expect(f.sources.autoRun.isEnabled(f.target.id)).toBe(true); expect((await f.store.activate(request, f.actor, f.check)).activated).toEqual(first.activated);
});
it('matches live regular scheduling in the declared time zone and deduplicates the minute', async () => {
  const f = await rehearsalFixture('schedule'); f.clock.now = Date.parse('2026-10-19T01:00:00Z');
  f.sources.schedules.set({ ...f.sources.schedules.get(f.target.id)!, enabled: true, cron_expression: '0 9 * * *', time_zone: 'Asia/Hong_Kong' });
  const doc = f.document(); doc.cases = [doc.cases[0]!]; doc.cases[0]!.input = { kind: 'clock', at: f.clock.now, last_run_at: null, next_run_at: f.clock.now, running: false, auto_disabled: false };
  expect(f.host.evaluate(f.target, doc).cases[0]?.candidate.verdict).toBe('start');
  const execute = vi.fn().mockResolvedValue({ success: true, errors: [], outputs: {}, sidebar: [] });
  const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, execute, now: () => f.clock.now, serverTimeZone: () => 'UTC' });
  expect(await scheduler.tick()).toContain(f.target.id); expect(await scheduler.tick()).not.toContain(f.target.id); expect(execute).toHaveBeenCalledTimes(1);
});
it('rejects forged authority, proof, results and configuration identities', async () => {
  const f = await rehearsalFixture(), doc = f.document();
  for (const key of ['source', 'authority', 'passed', 'qualification']) expect(() => parseRehearsalDocument({ ...doc, [key]: true })).toThrow();
  expect(() => parseRehearsalDocument({ ...doc, candidate: { ...doc.candidate, dish_id: 'other' } })).toThrow();
});

it('bounds retained scenario versions and refuses replay after pruning its saved result', async () => {
  const f = await rehearsalFixture(), view = await f.store.read(f.target, f.actor, f.check);
  const request = { target: f.target, expected_revision: view.revision, expected_live_digest: view.live_digest, request_id: randomUUID(), document: f.document() };
  await f.store.save(request, f.actor, f.check);
  for (let index = 0; index < 12; index++) { const doc = f.document(); doc.title += ' ' + index; await f.save(doc); }
  const latest = await f.store.read(f.target, f.actor, f.check); expect(latest.drafts).toHaveLength(10);
  await expect(f.store.save(request, f.actor, f.check)).rejects.toMatchObject({ code: 'automation_rehearsal_conflict' });
});
for (const kind of ['trigger', 'schedule', 'timer'] as const) for (const point of ['inside-transaction', 'before-refresh', 'after-commit'] as const) {
  it(`recovers ${kind} activation after actual process death ${point}`, async () => {
    const f = await rehearsalFixture(kind), { request } = await f.ready(), root = fileURLToPath(new URL('../../../../', import.meta.url)), child = join(f.dir, 'rehearsal-child.mts');
    const url = (path: string) => pathToFileURL(join(root, path)).href;
    writeFileSync(child, [
      `import {resourceFixture} from ${JSON.stringify(url('backend/server/src/__tests__/preapproval-resources-fixture.ts'))};`,
      `import {rehearsalStores} from ${JSON.stringify(url('backend/server/src/__tests__/automation-rehearsal-fixture.ts'))};`,
      `import {createPreapprovalCodec} from ${JSON.stringify(url('backend/server/src/storage/preapproval-codec.ts'))};`,
      `const spies={fn:()=>Object.assign(()=>{},{mockClear(){}}),spyOn:(object,key)=>object[key].bind(object)};`,
      `const f=await resourceFixture(${JSON.stringify({ dir: f.dir, clock: f.clock, token: f.token })},{spies});`,
      `const {host,store}=rehearsalStores(f,createPreapprovalCodec(()=>new Uint8Array(32).fill(9)));`,
      ...(point === 'inside-transaction' ? [`const apply=host.apply.bind(host);host.apply=(...args)=>{apply(...args);process.exit(86);};`] : []),
      ...(point === 'before-refresh' ? [`host.refresh=()=>process.exit(88);`] : []),
      `await store.activate(${JSON.stringify(request)},${JSON.stringify(f.actor)},()=>{});process.exit(87);`,
    ].join('\n'));
    await f.close();
    const result = spawnSync(process.execPath, ['--import', url('node_modules/tsx/dist/loader.mjs'), child], { cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.test.json') } });
    expect(result.status, result.stdout + result.stderr).toBe(point === 'inside-transaction' ? 86 : point === 'before-refresh' ? 88 : 87);
    const next = await f.reopenRehearsals(); expect(next.host.context(f.target).current?.enabled).toBe(point !== 'inside-transaction');
    const recovered = await next.store.activate(request, f.actor, () => {}); expect(recovered.activated?.sequence).toBe(1);
    if (point === 'before-refresh') expect(recovered.refresh_warning).toContain('Configuration committed'); else expect(recovered.activated?.refresh_confirmed).toBe(true);
    expect((await next.store.read(f.target, f.actor, () => {})).history.map(item => item.sequence)).toEqual([1]);
  }, 45_000);
}

it('retains unconfirmed runtime refresh on retry and reopen without resetting a later circuit', async () => {
  const f = await rehearsalFixture('timer'), doc = f.document(); if (doc.candidate.kind !== 'timer') throw new Error('fixture'); doc.candidate.reset_circuit = true;
  const { request } = await f.ready(doc), refresh = vi.spyOn(f.host, 'refresh').mockRejectedValue(new Error('Refresh failed'));
  const committed = await f.store.activate(request, f.actor, f.check); expect(committed.refresh_warning).toContain('Configuration committed');
  f.circuit.set({ dish_id: f.target.id, recipe_id: f.testedRecipe.recipe_id, consecutive_failures: 5, auto_disabled: true });
  const replay = await f.reopenStore().activate(request, f.actor, f.check);
  expect(replay.refresh_warning).toContain('Configuration committed'); expect(refresh).toHaveBeenCalledTimes(1); expect(f.circuit.get(f.target.id)?.auto_disabled).toBe(true);
});
it('records a successful runtime refresh durably for activation receipt recovery', async () => {
  const f = await rehearsalFixture(), { request } = await f.ready(), committed = await f.store.activate(request, f.actor, f.check);
  expect(committed.activated?.refresh_confirmed).toBe(true);
  expect((await f.reopenStore().activate(request, f.actor, f.check)).activated?.refresh_confirmed).toBe(true);
  expect((await f.store.read(f.target, f.actor, f.check)).history[0]?.refresh_confirmed).toBe(true);
});

it('matches the live recipe-wide run-outcome loop guard for sibling dish triggers', async () => {
  const f = await rehearsalFixture(); f.sources.triggers.update(f.target.id, { pattern: 'run.**', filter: null });
  f.sources.triggers.create({ trigger_id: 'sibling-dish-trigger', recipe_id: f.testedRecipe.recipe_id, publisher_id: 'core', enabled: true, pattern: 'run.**', created_at: f.clock.now });
  f.sources.triggers.create({ trigger_id: 'other-recipe-trigger', recipe_id: 'other-recipe', publisher_id: 'core', enabled: true, pattern: 'run.**', created_at: f.clock.now });
  const doc = f.document(); doc.cases = [doc.cases[0]!]; doc.cases[0]!.expected = 'skip'; const input = doc.cases[0]!.input; if (input.kind !== 'event') throw new Error('fixture');
  input.event.platform = 'run'; input.event.record = { origin_trigger_id: 'sibling-dish-trigger' };
  expect(f.host.evaluate(f.target, doc).cases[0]?.candidate.verdict).toBe('skip');
  input.event.record.origin_trigger_id = 'other-recipe-trigger'; expect(f.host.evaluate(f.target, doc).cases[0]?.candidate.verdict).toBe('start');
  const bus = createWarehouseEventBus(), capture = vi.spyOn(f.composed.driver, 'captureTrigger');
  const dispatcher = createEventTriggerDispatcher({ store: f.sources.triggers, bus, runtime: { runRecipe: vi.fn() }, getPreapprovalDriver: () => f.composed.driver });
  try { dispatcher.rebuild(); input.event.record.origin_trigger_id = 'sibling-dish-trigger'; bus.emit({ ...input.event, event_kind: 'completed' });
    expect(capture.mock.calls.some(([trigger]) => trigger.trigger_id === f.target.id)).toBe(false);
  } finally { dispatcher.dispose(); bus.dispose(); }
});
it('keeps a newer proposal when runtime confirmation loses a save race', async () => {
  const f = await rehearsalFixture(), { request } = await f.ready(), seal = f.codec.seal.bind(f.codec); let count = 0;
  vi.spyOn(f.codec, 'seal').mockImplementation(async state => {
    const encrypted = await seal(state);
    if (++count === 2) { const newer = f.document(); newer.title = 'Later private proposal'; newer.candidate.enabled = false; await f.save(newer); }
    return encrypted;
  });
  const result = await f.store.activate(request, f.actor, f.check);
  expect(result.refresh_warning).toContain('Configuration committed'); expect(result.draft?.document.title).toBe('Later private proposal');
  expect(result.revision).toBe(3); expect(f.sources.triggers.get(f.target.id)?.enabled).toBe(true);
});
it('preserves source and entity routing filters in shared live and rehearsal selection', async () => {
  const f = await rehearsalFixture(); f.sources.triggers.update(f.target.id, { pattern: 'data.task.**', filter: { slug: 'wanted-source', entity_type: 'wanted-entity' } });
  const doc = f.document(), first = doc.cases[0]!; if (first.input.kind !== 'event') throw new Error('fixture');
  first.input.event.slug = 'wanted-source'; first.input.event.entity_type = 'wanted-entity';
  const wrongSource = structuredClone(first); wrongSource.id = 'wrong-source'; wrongSource.expected = 'skip'; if (wrongSource.input.kind === 'event') wrongSource.input.event.slug = 'other-source';
  const wrongEntity = structuredClone(first); wrongEntity.id = 'wrong-entity'; wrongEntity.expected = 'skip'; if (wrongEntity.input.kind === 'event') wrongEntity.input.event.entity_type = 'other-entity';
  doc.cases = [first, wrongSource, wrongEntity];
  expect(f.host.evaluate(f.target, doc).cases.map(item => item.candidate.verdict)).toEqual(['start', 'skip', 'skip']);
});
