/** D-402 slice C — a trial of a draft (`recipe.try`): a write that is not a browser change is held before
 *  its step, as an "always ask" action is, though the Run button's owner trust would admit it; and the
 *  run stays a trial past each approval, so the write after one asks too. Through the real
 *  `handleExecute`, the gateway, the checkpoint and the preflight resumer. */
import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ExecutionSource, RecipeDefinition } from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type AuditLogStore, type CheckpointStore,
} from '@recued/storage';

import { browserTrials } from '../bridges/browser-trials.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { makeRecipeTryHandlers } from '../recipe-try-handler.js';
import { createRecipeRunCaptureStore, TRIAL_NOT_FINISHED } from '../storage/recipe-run-capture-store.js';
import { regressionFixture } from './recipe-regression-fixture.js';
import type { WsClient } from '../ws-server.js';

const recipe = {
  recipe_id: 'draft-two-notes', version: 1, ttl: 0,
  metadata: { name: 'Two notes', description: 'Keeps two notes.', author: 'you', supported_platforms: [] },
  variables: {},
  steps: [
    { id: 'first', op: 'core.storage.shared.write', args: { key: 'data.shared.trial.first', value: { n: 1 } } },
    { id: 'second', op: 'core.storage.shared.write', args: { key: 'data.shared.trial.second', value: { n: 2 } } },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** As the Run button and Kitchen's rpc run a recipe: the owner, at the owner's own trust. */
const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'webclient-1' } as ExecutionSource;

const stand = (failOn?: string) => {
  const written: string[] = [];
  const checkpoints = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: vi.fn(async (c: Checkpoint) => { checkpoints.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => checkpoints.get(id) ?? null),
    delete: vi.fn(async (id: string) => { checkpoints.delete(id); }),
    listByRun: vi.fn(async (run: string) => [...checkpoints.values()].filter((c) => c.run_id === run)),
    list: vi.fn(async () => [...checkpoints.values()]),
    size: vi.fn(async () => checkpoints.size),
  } as unknown as CheckpointStore;
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({ askStore, channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()) });
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()) as AuditLogStore;
  const deps = {
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: createManifestRegistry(),
      kernelDispatchers: { write: async (input: { key: string }) => {
        if (input.key === failOn) throw new Error('The store refused this key.');
        written.push(input.key); return { key: input.key, revision: written.length };
      } } },
    baseVault: {}, instanceId: 'd402-trial', auditLog, checkpointStore, preflightNotifier: block,
  } as unknown as ExecuteHandlerDeps;
  const settled: unknown[] = [];
  registerPreflightHandler(block, { checkpointStore, resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog,
    onRunSettled: (run) => { settled.push(run.result); } }) });
  const answerNext = async (option: 'approve' | 'deny') => {
    const [ask] = await askStore.listByStatus('open');
    expect(ask, 'an open ask').toBeDefined();
    await block.submitAnswer({ ask_id: ask!.ask_id, option, via: 'ui' });
  };
  const approveNext = () => answerNext('approve');
  const declineNext = () => answerNext('deny');
  return { deps, written, checkpoints, askStore, approveNext, declineNext, settled };
};

const run = (deps: ExecuteHandlerDeps, trial: boolean) => handleExecute(deps,
  { recipe: recipe as unknown as Record<string, unknown>, config: {}, trigger_source: 'manual', execution_source: owner },
  trial ? { trial: true } : {}) as Promise<{ success?: boolean; awaiting_approval?: boolean; errors?: unknown[] }>;

describe('D-402 slice C — a trial asks before a write the owner\'s own run would make silently', () => {
  it('outside a trial, the Run button\'s run writes both notes without asking', async () => {
    const s = stand();
    const out = await run(s.deps, false);
    expect(out.awaiting_approval).not.toBe(true);
    expect(s.written).toEqual(['data.shared.trial.first', 'data.shared.trial.second']);
    expect(await s.askStore.listByStatus('open')).toEqual([]);
  });

  it('a trial holds the first write; approved, it holds the second too, the checkpoint carrying the trial', async () => {
    const s = stand();
    const out = await run(s.deps, true);
    expect(out.awaiting_approval).toBe(true);
    expect(s.written).toEqual([]);
    expect([...s.checkpoints.values()].map((c) => [c.gated_step_id, c.trial])).toEqual([['first', true]]);
    await s.approveNext();
    // The resumed run wrote the first note and stopped before the second: a trial still.
    await expect.poll(() => s.written).toEqual(['data.shared.trial.first']);
    await expect.poll(async () => (await s.askStore.listByStatus('open')).length).toBe(1);
    expect([...s.checkpoints.values()].map((c) => [c.gated_step_id, c.trial])).toEqual([['second', true]]);
    await s.approveNext();
    await expect.poll(() => s.written).toEqual(['data.shared.trial.first', 'data.shared.trial.second']);
    await expect.poll(() => s.settled.length).toBe(2);
    expect(await s.askStore.listByStatus('open')).toEqual([]);
  });

  it('a trial asks for each item of a foreach, where one approval covers the rest of them otherwise', async () => {
    const s = stand();
    const each = { ...recipe, recipe_id: 'draft-notes-each', steps: [{ id: 'notes', op: 'core.storage.shared.write',
      foreach: [{ k: 'a' }, { k: 'b' }], args: { key: 'data.shared.trial.{{item.k}}', value: { n: 1 } } }] } as unknown as RecipeDefinition;
    const out = await handleExecute(s.deps, { recipe: each as unknown as Record<string, unknown>, config: {}, trigger_source: 'manual',
      execution_source: owner }, { trial: true }) as { awaiting_approval?: boolean };
    expect(out.awaiting_approval).toBe(true);
    await s.approveNext();
    await expect.poll(() => s.written).toEqual(['data.shared.trial.a']);
    // The second item is asked about for itself.
    await expect.poll(async () => (await s.askStore.listByStatus('open')).length).toBe(1);
    expect(s.written).toEqual(['data.shared.trial.a']);
    await s.approveNext();
    await expect.poll(() => s.written).toEqual(['data.shared.trial.a', 'data.shared.trial.b']);
  });

  it('a trial runs under no pre-approval', async () => {
    const s = stand();
    await expect(handleExecute(s.deps, { recipe: recipe as unknown as Record<string, unknown>, config: {}, trigger_source: 'manual',
      execution_source: owner }, { trial: true, preapproval_run: {} })).rejects.toMatchObject({ code: 'trial_preapproval' });
    expect(s.written).toEqual([]);
  });
});

describe('D-402 slice C — Kitchen\'s "Try it" (`recipe.try`)', () => {
  const tokens = { get: (id: string) => id === 'webclient-1'
    ? { client_kind: 'webclient', revoked_at: null, metadata: { instance_id: 'browser-1' } } : null } as never;
  const webclient = { client_kind: 'webclient', client_token_id: 'webclient-1', token_instance_id: 'browser-1', user_id: 'owner-1' } as unknown as WsClient;
  const tryIt = (deps: ExecuteHandlerDeps, args: unknown, client = webclient) =>
    makeRecipeTryHandlers({ clientTokens: tokens }, deps).handlers['recipe.try'](args as never, client) as Promise<{ awaiting_approval?: boolean }>;

  it('only from the owner\'s paired webclient', async () => {
    const s = stand();
    await expect(tryIt(s.deps, { recipe }, { ...webclient, client_kind: 'bridge' } as unknown as WsClient)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(tryIt(s.deps, { recipe }, { ...webclient, token_instance_id: 'another-browser' } as unknown as WsClient))
      .rejects.toMatchObject({ code: 'unauthorized' });
    expect(s.written).toEqual([]);
  });

  it('a recipe the editor would not pass is refused with what to fix; a draft that passes is run as a trial', async () => {
    const s = stand();
    await expect(tryIt(s.deps, { recipe: { ...recipe, steps: [{ id: 'first', op: 'core.no.such.op', args: {} }] } }))
      .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('Fix the recipe before trying it') });
    const out = await tryIt(s.deps, { recipe, config: {} });
    // The Run button would write at once; the trial is held before its first write.
    expect(out.awaiting_approval).toBe(true);
    expect([...s.checkpoints.values()].map((c) => c.trial)).toEqual([true]);
    expect(s.written).toEqual([]);
  });
});

describe('D-402 slice C — the trial as the recipe\'s saved test (§8.3)', () => {
  const tokens = { get: (id: string) => id === 'webclient-1'
    ? { client_kind: 'webclient', revoked_at: null, metadata: { instance_id: 'browser-1' } } : null } as never;
  const webclient = { client_kind: 'webclient', client_token_id: 'webclient-1', token_instance_id: 'browser-1', user_id: 'owner-1' } as unknown as WsClient;
  const actor = JSON.stringify(['webclient-1', 'browser-1']);
  const owner = (): void => undefined;
  const setup = (failOn?: string) => {
    const s = stand(failOn);
    const f = regressionFixture();
    const captures = createRecipeRunCaptureStore(f.codec, f.store);
    const tryIt = (draft: RecipeDefinition) => makeRecipeTryHandlers({ clientTokens: tokens, captures }, s.deps)
      .handlers['recipe.try']({ recipe: draft, config: {} } as never, webclient) as Promise<{ awaiting_approval?: boolean; run_id?: string;
        capture?: { capture_id: string; state: string; trial?: true; reason?: string; run_outcome?: string } }>;
    return { s, f, captures, tryIt };
  };

  it('a trial held at two writes, approved at each, is one capture of the recipe tried, keyed by its run; kept, it is the saved test', async () => {
    const { s, f, captures, tryIt } = setup();
    const started = await tryIt(recipe);
    expect(started).toMatchObject({ awaiting_approval: true, capture: { state: 'running', trial: true, run_outcome: 'held' } });
    await s.approveNext();
    await expect.poll(() => s.written).toEqual(['data.shared.trial.first']);
    await expect.poll(async () => (await s.askStore.listByStatus('open')).length).toBe(1);
    await s.approveNext();
    await expect.poll(() => captures.list(recipe.recipe_id, actor, owner).captures[0]?.state).toBe('ready');
    const [capture] = captures.list(recipe.recipe_id, actor, owner).captures;
    expect(captures.list(recipe.recipe_id, actor, owner).captures).toHaveLength(1);
    expect(capture).toMatchObject({ trial: true, run_outcome: 'passed', run_id: expect.any(String) });
    const read = await captures.read(capture!.capture_id, actor, owner);
    // Both writes, each from its own part of the run, in the case: the step before the first hold and the one after it.
    expect(read.draft!.case.assertions).toEqual(expect.arrayContaining([
      { kind: 'run_status', expected: 'passed' },
      { kind: 'step_status', phase: 'sequential', step_id: 'first', expected: 'passed' },
      { kind: 'step_status', phase: 'sequential', step_id: 'second', expected: 'passed' },
    ]));
    expect(read.draft!.recipe.recipe_id).toBe(recipe.recipe_id);
    // The owner keeps it, once the recipe is saved: Kitchen's own import, as for any capture.
    const saved = await captures.import({ capture_id: capture!.capture_id, recipe_digest: read.draft!.recipe_digest, expected_revision: 0,
      request_id: 'keep-1', reviewed: true, case: read.draft!.case }, actor, owner);
    expect(saved.version?.suite.cases.map((one) => one.id)).toEqual([capture!.capture_id]);
    expect((await f.store.read(recipe.recipe_id, undefined, owner)).version?.suite.baseline.recipe_id).toBe(recipe.recipe_id);
    expect(s.written).toEqual(['data.shared.trial.first', 'data.shared.trial.second']);
  });

  it('a trial the owner declines at its hold is no saved test at once, and its recorder is let go', async () => {
    const { s, captures, tryIt } = setup();
    expect(await tryIt(recipe)).toMatchObject({ awaiting_approval: true, capture: { state: 'running', run_outcome: 'held' } });
    const [held] = [...s.checkpoints.values()];
    expect(browserTrials.recorderOf(held!.run_id), 'kept while it waits').toBeDefined();
    await s.declineNext();
    // Nothing of the run reports again, so the decline itself settles it, long before the capture's ten minutes.
    await expect.poll(() => captures.list(recipe.recipe_id, actor, owner).captures[0]?.state).toBe('unavailable');
    expect(captures.list(recipe.recipe_id, actor, owner).captures[0]).toMatchObject({ trial: true, run_id: held!.run_id,
      run_outcome: 'failed', reason: TRIAL_NOT_FINISHED });
    expect(browserTrials.recorderOf(held!.run_id)).toBeUndefined();
    expect(s.written).toEqual([]);
    // An approval that comes too late changes nothing.
    expect(await s.askStore.listByStatus('open')).toEqual([]);
  });

  it('a trial that settled keeps what it settled as, if it is told late that it ended', async () => {
    const { captures } = setup();
    const trial = captures.trial('draft-late', actor, owner);
    // No input reached the capture: it settles at once as none, with that reason.
    trial.recorder.result({ success: false, steps: [], errors: [], output: { render: [], sidebar: [] } } as never);
    expect((await trial.done).reason).toBe('The recipe did not reach the capture boundary.');
    trial.recorder.ended!();
    expect(captures.list('draft-late', actor, owner).captures[0]?.reason).toBe('The recipe did not reach the capture boundary.');
  });

  it('a trial that failed is no saved test; a recipe with a step that reads the clock says why it has none', async () => {
    const failing = setup('data.shared.trial.second');
    expect(await failing.tryIt(recipe)).toMatchObject({ awaiting_approval: true });
    await failing.s.approveNext();
    await expect.poll(async () => (await failing.s.askStore.listByStatus('open')).length).toBe(1);
    await failing.s.approveNext();
    await expect.poll(() => failing.captures.list(recipe.recipe_id, actor, owner).captures[0]?.state).toBe('unavailable');
    expect(failing.captures.list(recipe.recipe_id, actor, owner).captures[0]?.reason).toContain('The trial did not finish');
    // No write, so no hold: the trial settles in the call, which says at once that it is a saved test,
    // its replay built before the answer.
    const counted = { ...recipe, recipe_id: 'draft-count', steps: [{ id: 'count', transform: 'count', input: [1, 2, 3] }],
      output: { render: [{ type: 'json', source: 'step.count', label: 'Count' }] } } as unknown as RecipeDefinition;
    expect((await setup().tryIt(counted)).capture).toMatchObject({ state: 'ready', trial: true, run_outcome: 'passed' });
    // And says at once why there is none.
    const dated = { ...recipe, recipe_id: 'draft-today', steps: [{ id: 'today', transform: 'date_period', period: 'today' }] } as unknown as RecipeDefinition;
    const clock = setup();
    const out = await clock.tryIt(dated);
    expect(out.capture).toMatchObject({ state: 'unavailable', trial: true, reason: expect.stringContaining('Clock-dependent date steps') });
  });
});

