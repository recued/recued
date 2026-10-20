import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Commit, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { calendarStep, recordStep, resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';

afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
});

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

const httpFixture = (registered: boolean) => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipes = createRecipeStore('/nonexistent');
  const manifest: IngredientManifest = { slug: 'budget-read', version: 1, name: 'Read', description: '', author: 'fixture',
    kind: 'http', category: 'data', risk_tier: 'read', input: { method: 'GET', url: 'https://fixture.invalid/budget' }, output: {} };
  manifests.register(manifest);
  for (const id of ['budgeted', 'independent']) {
    const recipe: RecipeDefinition = { recipe_id: id, version: 1, ttl: 0,
      metadata: { name: id, description: 'Run budget fence fixture.', author: 'fixture', supported_platforms: [],
        ...(id === 'budgeted' ? { budget_ms: 1_000 } : {}) },
      variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient: manifest.slug, input: {} }], output: { render: [] } };
    recipes.register(recipe);
  }
  const store = createCommitStore(createInMemoryCollection<Commit>());
  const lanes = new LaneSemaphore({ external_io_n: 2 });
  const registry = new InFlightRegistry(lanes);
  const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, executorConfig: { manifests },
    commitStore: store, laneGovernor: lanes, ...(registered ? { inFlightRegistry: registry } : {}) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"value":"receipt"}', {
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  const ids = new Map<string, string>();
  return { store, fetch, lanes, registry,
    commits: (id = 'budgeted') => store.listByRun(ids.get(id)!),
    run: (id = 'budgeted') => handleExecute(deps, { recipe_id: id,
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } },
    { onRunMinted: run_id => { ids.set(id, run_id); } }),
  };
};

describe('each run fences commits with its own budget', () => {
  it.each([true, false])('refuses dispatch after a delayed pending write with live registration %s', async registered => {
    vi.useFakeTimers(); const f = httpFixture(registered); const entered = gate(); const held = gate();
    const write = f.store.writePending.bind(f.store);
    vi.spyOn(f.store, 'writePending').mockImplementationOnce(async pending => {
      await write(pending); entered.release(); await held.promise;
    });
    const execution = f.run();
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
      expect((await f.commits())[0]).not.toHaveProperty('output');
    } finally { held.release(); await execution; }
  });

  it.each([true, false].flatMap(registered => ['resolve', 'reject'].map(outcome => ({ registered, outcome }))))
    ('drains an admitted $outcome after expiry with live registration $registered', async ({ registered, outcome }) => {
      vi.useFakeTimers(); const f = httpFixture(registered); const entered = gate(); const held = gate();
      f.fetch.mockImplementationOnce(async () => {
        entered.release(); await held.promise;
        if (outcome === 'reject') throw new Error('Provider connection lost');
        return new Response('{"value":"late receipt"}', { headers: { 'content-type': 'application/json' } });
      });
      let settled = false;
      const execution = f.run().then(result => { settled = true; return result; });
      try {
        await entered.promise; await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(false);
        expect(f.lanes.gatedEntries()).toMatchObject([{ state: 'running' }]);
        expect(await f.commits()).toMatchObject([{ status: 'pending' }]);
        held.release();
        expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
        expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
        expect((await f.commits())[0]).not.toHaveProperty('output');
        expect(f.lanes.gatedEntries()).toEqual([]);
        expect(f.registry.activeRunCount()).toBe(0);
      } finally { held.release(); await execution; }
    });

  it('does not lend an expired budget to a concurrent independent run', async () => {
    vi.useFakeTimers(); const f = httpFixture(true); const firstEntered = gate(); const secondEntered = gate();
    const first = gate(); const second = gate();
    f.fetch.mockImplementationOnce(async () => { firstEntered.release(); await first.promise; return new Response('{}'); });
    f.fetch.mockImplementationOnce(async () => { secondEntered.release(); await second.promise; return new Response('{}'); });
    const expiring = f.run(); await firstEntered.promise;
    const independent = f.run('independent');
    try {
      await secondEntered.promise; await vi.advanceTimersByTimeAsync(1_000);
      first.release(); expect((await expiring).success).toBe(false);
      second.release(); expect((await independent).success).toBe(true);
      expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
      expect(await f.commits('independent')).toMatchObject([{ status: 'succeeded' }]);
    } finally { first.release(); second.release(); await Promise.all([expiring, independent]); }
  });

  it('retains a timely result after the retired budget would have expired', async () => {
    vi.useFakeTimers(); const f = httpFixture(true);
    expect((await f.run()).success).toBe(true);
    const before = await f.commits();
    expect(before).toMatchObject([{ status: 'succeeded' }]);
    expect(before[0]).toHaveProperty('output');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await f.commits()).toEqual(before);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});

describe('ordinary local writes respect their run budget', () => {
  it('refuses a Calendar mutation prepared across expiry', async () => {
    const f = await ordinaryLocalFixture(); f.recipe.metadata.budget_ms = 1_000;
    const approval = await f.hold([calendarStep(), recordStep('b')]);
    const entered = gate(); const held = gate(); const prepare = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => {
      const prepared = await prepare(input); entered.release(); await held.promise; return prepared;
    });
    vi.useFakeTimers(); const execution = approval.resume();
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(1_000); held.release(); await execution;
      expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
      expect(f.row('b')!.title).toBe('b');
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
      expect(await f.execution.commitStore!.listByRun(approval.action.run_id)).toMatchObject([{ status: 'cancelled' }]);
      expect((await f.execution.auditLog!.get(approval.action.run_id))!.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
    } finally { held.release(); await execution; }
  });

  it('refuses a Records mutation admitted across a delayed pending write', async () => {
    const f = await ordinaryLocalFixture(); f.recipe.metadata.budget_ms = 1_000;
    const approval = await f.hold([recordStep('a'), recordStep('b')]);
    const entered = gate(); const held = gate(); const write = f.execution.commitStore!.writePending.bind(f.execution.commitStore);
    vi.spyOn(f.execution.commitStore!, 'writePending').mockImplementationOnce(async pending => {
      await write(pending); entered.release(); await held.promise;
    });
    vi.useFakeTimers(); const execution = approval.resume();
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(1_000); held.release(); await execution;
      expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
      expect(f.row('b')!.title).toBe('b');
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
      expect(await f.execution.commitStore!.listByRun(approval.action.run_id)).toMatchObject([{ status: 'cancelled' }]);
      expect((await f.execution.auditLog!.get(approval.action.run_id))!.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
    } finally { held.release(); await execution; }
  });

  it('preserves atomic proof for a Calendar write committed before expiry', async () => {
    const f = await ordinaryLocalFixture(); f.recipe.metadata.budget_ms = 1_000;
    const approval = await f.hold([calendarStep(), recordStep('b')]);
    const committed = gate(); const held = gate(); const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
    vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementationOnce(async (...args) => {
      await apply(...args); committed.release(); await held.promise;
    });
    vi.useFakeTimers(); const execution = approval.resume();
    try {
      await committed.promise; await vi.advanceTimersByTimeAsync(1_000); held.release(); await execution;
      expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
      expect(f.row('b')!.title).toBe('b');
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
      expect(await f.execution.commitStore!.listByRun(approval.action.run_id))
        .toMatchObject([{ status: 'succeeded', local_receipt: { kind: 'local_calendar' } }]);
      expect(await f.execution.gatedActionStore!.get(approval.action.action_ref)).toMatchObject({ status: 'succeeded', local_receipt: {} });
      expect((await f.execution.auditLog!.get(approval.action.run_id))!.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
    } finally { held.release(); await execution; }
  });
});

describe('future-approved local writes respect their run budget', () => {
  it.each(['records', 'calendar'] as const)('rolls back a reviewed %s mutation after expiry', async kind => {
    const f = await resourceFixture(); f.recipe.metadata.budget_ms = 1_000;
    f.save([kind === 'records' ? recordStep('a') : calendarStep(), recordStep('b')]);
    const approval = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(approval.proposal_id), f.responder);
    const entered = gate(); const held = gate();
    if (kind === 'calendar') {
      const prepare = f.calendar.provider.updateEvent.bind(f.calendar.provider);
      f.calendarUpdates.mockImplementationOnce(async input => {
        const prepared = await prepare(input); entered.release(); await held.promise; return prepared;
      });
    } else {
      const scope = f.storage.repository.localMutationScope.bind(f.storage.repository);
      vi.spyOn(f.storage.repository, 'localMutationScope').mockImplementationOnce(async claim => {
        const participant = await scope(claim); entered.release(); await held.promise; return participant;
      });
    }
    vi.useFakeTimers(); const execution = f.run(approval.future_execution_ref);
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
      expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
      expect(f.row('b')!.title).toBe('b');
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
      expect((await f.storage.repository.inspect(approval.proposal_id)).members[0]!.status).not.toBe('succeeded');
    } finally { held.release(); await execution; }
  });

  it('preserves reviewed proof for a local write committed before expiry', async () => {
    const f = await resourceFixture(); f.recipe.metadata.budget_ms = 1_000;
    f.save([calendarStep(), recordStep('b')]);
    const approval = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(approval.proposal_id), f.responder);
    const committed = gate(); const held = gate(); const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
    vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementationOnce(async (...args) => {
      await apply(...args); committed.release(); await held.promise;
    });
    vi.useFakeTimers(); const execution = f.run(approval.future_execution_ref);
    try {
      await committed.promise; await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
      expect(f.row('b')!.title).toBe('b');
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
      expect((await f.storage.repository.inspect(approval.proposal_id)).members[0])
        .toMatchObject({ status: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    } finally { held.release(); await execution; }
  });
});
