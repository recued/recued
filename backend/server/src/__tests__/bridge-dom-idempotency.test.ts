import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, BridgeResult, Commit, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { classifyAutomationFailure } from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import type { ResolvedCall } from '@recued/ingredients';
import { createInMemoryIdempotencyCache } from '../../../../apps/bridge/src/idempotency/cache.js';
import { executeReviewedBridgeDocument } from '../../../../apps/bridge/src/actions/reviewed-document.js';
import { buildGrant, createInMemoryBridgeGrantStore } from '../../../../apps/bridge/src/permissions/grants.js';
import { dispatchBridgeCommand, type BridgeActionExecutor } from '../../../../apps/bridge/src/queue/dispatcher.js';
import { createBridgeDispatcher, createBridgeResultListener, type BridgeDispatcher } from '../bridges/dispatcher.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createBridgeDomAdapter, describeBridgeDomCall } from '../bridges/dom-adapter.js';
import { handleExecute } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.useRealTimers(); vi.restoreAllMocks();
});
const target = 'https://app.fixture.invalid/*';
const fixture = async (write = false) => {
  const manifest: IngredientManifest = { slug: 'fixture-dom', version: 1, name: 'DOM identity fixture', description: '',
    author: 'fixture', kind: 'dom', category: 'data', risk_tier: write ? 'write' : 'read', surface_kind: write ? 'authoring' : 'reading',
    input: {}, output: { [target]: 'trigger', '#field': write ? 'dom.value' : 'title' } };
  const call: ResolvedCall = { slug: manifest.slug, risk_tier: manifest.risk_tier, input: { value: 'same' }, output: manifest.output,
    stepMeta: { recipe_id: 'fixture-repeat', step_id: 'read', run_id: 'first-run' } };
  const cache = createInMemoryIdempotencyCache(); const grants = createInMemoryBridgeGrantStore();
  const description = describeBridgeDomCall(manifest, call);
  await grants.put(buildGrant(description.ingredient, [target], Date.now()));
  const registry = createBridgeRegistry(); const listener = createBridgeResultListener(); cleanups.push(() => listener.clear?.());
  registry.attach({ client_token_id: 'bridge', client_label: 'Fixture bridge', session_id: 'fixture', online_since: 1, last_seen_at: 1,
    capabilities: { software_version: 'fixture', chrome_version: 'fixture', permissions_granted: [], granted_origins: [target],
      offscreen_supported: true, alarms_supported: true } });
  let executed = 0;
  const action = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status: 'ok',
    outputs: { text: 'fresh-' + ++executed, filled: true } }));
  const commands: BridgeCommand[] = []; const results: BridgeResult[] = []; let transferred = () => {};
  let beforeCommand: (command: BridgeCommand) => Promise<void> = async () => {};
  const cancellations = new Map<string, { signalled: boolean }>();
  let serial = 0;
  const dispatcher: BridgeDispatcher = createBridgeDispatcher({ registry, listener, generateCommandId: () => 'command-' + ++serial,
    transport: { cancel: async (_id, cancel) => {
      const signal = cancellations.get(cancel.command_id);
      if (signal) signal.signalled = true;
      return { ok: true };
    }, send: async (id, envelope) => {
      if (envelope.kind !== 'command') throw new Error('Expected a command');
      commands.push(envelope.command);
      await beforeCommand(envelope.command);
      const cancel = { signalled: false };
      cancellations.set(envelope.command.command_id, cancel);
      const outcome = await dispatchBridgeCommand(envelope.command, { bridge_version: 'fixture', now: Date.now,
        executor: { execute: action }, grants, idempotency: cache }, cancel)
        .finally(() => cancellations.delete(envelope.command.command_id));
      results.push(outcome.result);
      // Match production ownership routing before admitting a result frame.
      if (dispatcher.canResolve(outcome.result.command_id, id)) listener.resolveResult(outcome.result);
      transferred(); return { ok: true };
    } } });
  const adapter = createBridgeDomAdapter({ manifests: { get: () => manifest }, getDispatcher: () => dispatcher });
  const complete = async <T>(run: () => Promise<T>): Promise<T> => {
    const delivered = new Promise<void>(resolve => { transferred = resolve; });
    const execution = run().then(result => ({ result }), error => ({ error }));
    await Promise.race([delivered, execution]);
    // An incorrectly correlated cached response must fail without hanging the fixture.
    await vi.advanceTimersByTimeAsync(40_000);
    const outcome = await execution;
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  };
  return { manifest, call, cache, registry, listener, dispatcher, adapter, complete, commands, results, action,
    beforeDispatch: (hook: typeof beforeCommand) => { beforeCommand = hook; } };
};

describe('DOM invocation identity through the server dispatcher and bridge cache', () => {
  it('keeps the original cancellation stopped while allowing an explicit retry to replay the confirmed write', async () => {
    vi.useFakeTimers(); const f = await fixture(true);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.action.mockImplementationOnce(async () => { await held; return { status: 'ok', outputs: { filled: true } }; });
    const first = f.complete(() => f.adapter(f.call)).catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.action).toHaveBeenCalledOnce();
    expect(await f.dispatcher.cancel(f.commands[0]!.command_id, 'Owner cancelled')).toEqual({ ok: true });
    release();
    expect(await first).toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect(f.results).toHaveLength(1);
    expect(f.results[0]).toMatchObject({ status: 'cancelled', outputs: undefined });
    expect((await f.cache.inspectInFlight()).count).toBe(0);
    const original = structuredClone(f.results[0]);
    expect(await f.complete(() => f.adapter(structuredClone(f.call)))).toEqual({ written: 1, fields: ['value'], failed: [] });
    expect(f.results[0]).toEqual(original);
    expect(f.results[1]).toMatchObject({ status: 'ok', idempotency_key_seen: true, command_id: f.commands[1]!.command_id });
    expect(f.action).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a timed-out write stopped and only replays a confirmed late completion on an explicit retry', async () => {
    vi.useFakeTimers(); const f = await fixture(true);
    let release!: (outcome: Awaited<ReturnType<BridgeActionExecutor['execute']>>) => void;
    f.action.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.complete(() => f.adapter(f.call)).catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await first).toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect((await f.cache.inspectInFlight()).count).toBe(1);
    const timeoutReply = structuredClone(f.results[0]);
    release({ status: 'ok', outputs: { filled: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.cache.inspectInFlight()).count).toBe(0);
    expect(f.results).toEqual([timeoutReply]); // No second result frame or automatic continuation.
    expect(await f.complete(() => f.adapter(structuredClone(f.call)))).toEqual({ written: 1, fields: ['value'], failed: [] });
    expect(f.action).toHaveBeenCalledOnce();
    expect(f.results[1]).toMatchObject({ status: 'ok', idempotency_key_seen: true, command_id: f.commands[1]!.command_id });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops unattended replay of an unfinished admission without falling through to another bridge', async () => {
    vi.useFakeTimers(); const f = await fixture(true);
    f.registry.attach({ client_token_id: 'other-bridge', client_label: 'Other healthy bridge', session_id: 'other',
      online_since: 0, last_seen_at: 0, capabilities: { software_version: 'fixture', chrome_version: 'fixture',
        permissions_granted: [], granted_origins: [target], offscreen_supported: true, alarms_supported: true } });
    f.beforeDispatch(async command => {
      // The old worker committed admission, then stopped before recording an
      // outcome. This worker receives a fresh command id for the same intent.
      await f.cache.claim('interrupted-worker-command', command.idempotency_key);
    });
    const error = await f.complete(() => f.adapter(f.call)).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect(f.action).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(1);
    expect(f.results).toMatchObject([{ command_id: f.commands[0]!.command_id, status: 'error',
      error: { code: 'delivery_uncertain' }, idempotency_key_seen: true }]);
    expect(await f.cache.list()).toEqual([]); // An uncertain reply is not a completion.
    expect((await f.cache.claim('another-retry', f.commands[0]!.idempotency_key)).kind).toBe('in_flight');
    expect(classifyAutomationFailure({ code: (error as { code: string }).code })).toMatchObject({ stop: 'first_failure' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops unattended execution when a reviewed write loses its browser acknowledgement', async () => {
    vi.useFakeTimers(); const f = await fixture(true);
    const document = { tab_id: 4, document_id: 'reviewed', url: 'https://app.fixture.invalid/record/1' };
    const injection = vi.fn(async () => { throw new Error('Acknowledgement lost after the page changed'); });
    f.action.mockImplementation(req => executeReviewedBridgeDocument({ executeScript: injection },
      document, req.action, req.command.args));
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await f.complete(() => f.adapter(f.call)).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
      expect(classifyAutomationFailure({ code: (error as { code: string }).code })).toMatchObject({ stop: 'first_failure' });
    }
    expect(injection).toHaveBeenCalledOnce();
    expect(f.results).toMatchObject([
      { status: 'error', error: { code: 'delivery_uncertain' }, idempotency_key_seen: false },
      { status: 'error', error: { code: 'delivery_uncertain' }, idempotency_key_seen: true },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('executes the same recipe again under its newly minted run id', async () => {
    vi.useFakeTimers(); const f = await fixture(); const minted: string[] = [];
    const manifests = createManifestRegistry('/nonexistent'); manifests.register(f.manifest);
    const recipes = createRecipeStore('/nonexistent');
    const recipe: RecipeDefinition = { recipe_id: 'fixture-repeat', version: 1, ttl: 0,
      metadata: { name: 'Repeat read', description: 'Run identity fixture.', author: 'fixture', supported_platforms: [] },
      variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient: f.manifest.slug, input: {} }], output: { render: [] } };
    recipes.register(recipe); const commits = createCommitStore(createInMemoryCollection<Commit>());
    const run = () => handleExecute({ recipeStore: recipes, baseVault: {}, commitStore: commits,
      executorConfig: { manifests, bridgeDispatcherRef: () => f.dispatcher } }, { recipe_id: recipe.recipe_id,
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } },
    { onRunMinted: run_id => { minted.push(run_id); } });
    expect((await f.complete(run)).success).toBe(true); expect((await f.complete(run)).success).toBe(true);
    expect(minted).toHaveLength(2); expect(minted[0]).not.toBe(minted[1]);
    expect(f.commands.map(command => command.recipe_run_id)).toEqual(minted);
    expect(f.commands[1]!.idempotency_key).not.toBe(f.commands[0]!.idempotency_key);
    expect(f.action).toHaveBeenCalledTimes(2); expect(await f.cache.list()).toHaveLength(2);
    for (const [index, run_id] of minted.entries()) {
      expect(await commits.listByRun(run_id)).toMatchObject([{ status: 'succeeded', output: { title: 'fresh-' + (index + 1) } }]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('replays a retry to its new command id, then executes a separate run afresh (write: %s)', async write => {
    vi.useFakeTimers(); const f = await fixture(write);
    const first = await f.complete(() => f.adapter(f.call));
    expect(await f.complete(() => f.adapter(structuredClone(f.call)))).toEqual(first);
    expect(f.action).toHaveBeenCalledOnce();
    expect(f.commands[1]!.command_id).not.toBe(f.commands[0]!.command_id);
    expect(f.commands[1]!.idempotency_key).toBe(f.commands[0]!.idempotency_key);
    expect(f.results[1]).toMatchObject({ command_id: f.commands[1]!.command_id, idempotency_key_seen: true });
    expect((await f.cache.lookup(f.commands[0]!.command_id))?.result).toMatchObject({
      command_id: f.commands[0]!.command_id, idempotency_key_seen: false,
    });
    await f.complete(() => f.adapter({ ...f.call, stepMeta: { ...f.call.stepMeta!, run_id: 'second-run' } }));
    expect(f.action).toHaveBeenCalledTimes(2); expect(f.commands[2]!.recipe_run_id).toBe('second-run');
    expect(f.commands[2]!.idempotency_key).not.toBe(f.commands[0]!.idempotency_key);
    expect(f.results[2]!.idempotency_key_seen).toBe(false);
    for (const command of f.commands) expect(f.dispatcher.canResolve(command.command_id, 'bridge')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: 'error', code: 'selector_not_found', recipe_code: 'DOM_SELECTOR_NOT_FOUND' },
    { status: 'error', code: 'mv3_lifecycle_killed', recipe_code: 'ACTION_DELIVERY_UNCERTAIN' },
    { status: 'rejected', code: 'authority_invalid_grant_scope', recipe_code: 'INGREDIENT_SCOPE_INSUFFICIENT' },
    { status: 'cancelled', code: 'unknown', recipe_code: 'ACTION_DELIVERY_UNCERTAIN' },
    { status: 'timeout', code: 'unknown', recipe_code: 'ACTION_DELIVERY_UNCERTAIN' },
  ] as const)('correlates a cached $status receipt without repeating the write', async ({ status, code, recipe_code }) => {
    vi.useFakeTimers(); const f = await fixture(true);
    f.action.mockResolvedValueOnce({ status, error: { code, message: 'Fixture failure receipt' } });
    await expect(f.complete(() => f.adapter(f.call))).rejects.toMatchObject({ code: recipe_code });
    const saved = structuredClone(await f.cache.lookup(f.commands[0]!.command_id));
    await expect(f.complete(() => f.adapter(structuredClone(f.call)))).rejects.toMatchObject({ code: recipe_code });
    expect(f.action).toHaveBeenCalledOnce();
    expect(f.results[1]).toMatchObject({ status, command_id: f.commands[1]!.command_id,
      error: { code, message: 'Fixture failure receipt' }, idempotency_key_seen: true });
    expect(await f.cache.lookup(f.commands[0]!.command_id)).toEqual(saved);
    for (const command of f.commands) expect(f.dispatcher.canResolve(command.command_id, 'bridge')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
