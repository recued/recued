/** D-148 P3 — bridge dispatcher tests (D-169 P0 Slice 2A amends).
 *
 *  Covers:
 *   - Idempotency replay (cache hit by command_id + by idempotency_key)
 *   - D-169 § A.7 two-way grant intersection (replaces the retired
 *     three-way intersection that included per-command authority verify)
 *   - Cooperative cancel during execution
 *   - Timeout discipline (per-command)
 *   - Output-key validation
 *   - Retained-receipt replay after a reconnect within one worker lifetime
 */

import { describe, it, expect, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createIndexedDbIdempotencyCache, BRIDGE_IN_FLIGHT_STORE_NAME } from '../idempotency/indexed-db-cache.js';
import {
  type BridgeCommand,
  type BridgeIngredientRef,
  BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  BRIDGE_COMMAND_MAX_TIMEOUT_MS,
} from '@recued/contracts';
import {
  dispatchBridgeCommand,
  clampCommandTimeout,
  resolveCommandAction,
} from '../queue/dispatcher.js';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { buildGrant, createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import type { BridgeActionExecutor, ActionExecutorOutcome } from '../queue/dispatcher.js';

const ingredient: BridgeIngredientRef = {
  publisher_id: 'recued-core',
  slug: 'draft-email-reader-hubspot',
  version: '1.0.0',
  surface_kind: 'reading',
  domain_allowlist: ['*://app.hubspot.com/*'],
  domain_allowlist_signature: 'PUB_SIG',
};

const buildCommand = (
  id: string,
  override: Partial<BridgeCommand> = {},
): BridgeCommand => ({
  command_id: id,
  recipe_run_id: 'run-1',
  step_id: 'step-1',
  ingredient,
  action: 'read_dom',
  target_domain_pattern: '*://app.hubspot.com/*',
  args: { selector: '#email-subject' },
  expects_output_keys: ['text'],
  timeout_ms: 5_000,
  idempotency_key: `idem-${id}`,
  ...override,
});

const buildExecutor = (
  outcome: ActionExecutorOutcome | (() => Promise<ActionExecutorOutcome>),
): BridgeActionExecutor => ({
  execute:
    typeof outcome === 'function'
      ? async () => (outcome as () => Promise<ActionExecutorOutcome>)()
      : async () => outcome,
});

const buildDeps = (
  executor: BridgeActionExecutor,
  grants = createInMemoryBridgeGrantStore(),
  idempotency = createInMemoryIdempotencyCache({ now: () => 1_000 }),
) => ({
  bridge_version: '0.0.1',
  now: () => 1_500,
  executor,
  grants,
  idempotency,
});

describe('D-148 P3 — dispatcher idempotency replay', () => {
  it.each(['memory', 'IndexedDB'])('refuses overlapping %s admissions and later replays the original completion', async storage => {
    const idempotency = storage === 'memory' ? createInMemoryIdempotencyCache() : createIndexedDbIdempotencyCache({
      indexedDB: new IDBFactory(), scope: { server_public_key: 'server', token_id: 'client' } });
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn<BridgeActionExecutor['execute']>(async () => {
      entered(); await held; return { status: 'ok', outputs: { text: 'original' } };
    });
    const deps = buildDeps({ execute }, grants, idempotency);
    const first = dispatchBridgeCommand(buildCommand('original', { idempotency_key: 'same-key' }), deps);
    try {
      await started;
      const overlapping = await dispatchBridgeCommand(buildCommand('overlap', { idempotency_key: 'same-key' }), deps);
      expect(overlapping.result).toMatchObject({ command_id: 'overlap', status: 'error',
        error: { code: 'delivery_uncertain' }, idempotency_key_seen: true });
      expect(execute).toHaveBeenCalledOnce();
    } finally { release(); await first; }
    const replay = await dispatchBridgeCommand(buildCommand('retry', { idempotency_key: 'same-key' }), deps);
    expect(replay.result).toMatchObject({ command_id: 'retry', status: 'ok', outputs: { text: 'original' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('waits for marker transaction completion before calling the executor', async () => {
    const idempotency = createIndexedDbIdempotencyCache({ indexedDB: new IDBFactory(),
      scope: { server_public_key: 'server', token_id: 'client' } });
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    let committed = false; let committedAtExecution = false; let calledBeforeRequestSuccess = false;
    const execute = vi.fn<BridgeActionExecutor['execute']>(async () => {
      committedAtExecution = committed; return { status: 'ok', outputs: { text: 'served' } };
    });
    const add = IDBObjectStore.prototype.add;
    const observe = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = add.call(this, value, key);
      if (this.name === BRIDGE_IN_FLIGHT_STORE_NAME) {
        request.addEventListener('success', () => { calledBeforeRequestSuccess = execute.mock.calls.length > 0; });
        this.transaction.addEventListener('complete', () => { committed = true; });
      }
      return request;
    });
    try {
      await dispatchBridgeCommand(buildCommand('original'), buildDeps({ execute }, grants, idempotency));
      expect(calledBeforeRequestSuccess).toBe(false);
      expect(committedAtExecution).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
    } finally { observe.mockRestore(); }
  });

  it('does not execute when a marker write aborts after request success', async () => {
    const indexedDB = new IDBFactory();
    const scope = { server_public_key: 'server', token_id: 'client' };
    const idempotency = createIndexedDbIdempotencyCache({ indexedDB, scope });
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const execute = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status: 'ok' }));
    const add = IDBObjectStore.prototype.add;
    const abort = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = add.call(this, value, key);
      if (this.name === BRIDGE_IN_FLIGHT_STORE_NAME) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    try {
      await expect(dispatchBridgeCommand(buildCommand('original'), buildDeps({ execute }, grants, idempotency))).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    } finally { abort.mockRestore(); }
    expect((await createIndexedDbIdempotencyCache({ indexedDB, scope }).claim('retry', 'idem-original')).kind).toBe('claimed');
  });

  it('cache-hit by command_id replays prior result', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const idempotency = createInMemoryIdempotencyCache({ now: () => 1_000 });

    let exec_count = 0;
    const executor = buildExecutor(async () => {
      exec_count++;
      return { status: 'ok', outputs: { text: 'first' } };
    });
    const deps = buildDeps(executor, grants, idempotency);

    const command = buildCommand('cmd-1');
    await dispatchBridgeCommand(command, deps);
    expect(exec_count).toBe(1);

    // Server retries with same command_id — bridge replays.
    const replay = await dispatchBridgeCommand(command, deps);
    expect(exec_count).toBe(1);
    expect(replay.replayed_from_cache).toBe(true);
    expect(replay.result.idempotency_key_seen).toBe(true);
    expect(replay.result.outputs?.text).toBe('first');
  });

  it('cache-hit by idempotency_key (different command_id) also replays', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const idempotency = createInMemoryIdempotencyCache({ now: () => 1_000 });

    let exec_count = 0;
    const executor = buildExecutor(async () => {
      exec_count++;
      return { status: 'ok', outputs: { text: 'first' } };
    });
    const deps = buildDeps(executor, grants, idempotency);

    await dispatchBridgeCommand(buildCommand('cmd-1'), deps);

    // Server retries with a fresh command_id but same idempotency_key.
    const second = buildCommand('cmd-2', { idempotency_key: 'idem-cmd-1' });
    const out = await dispatchBridgeCommand(second, deps);
    expect(exec_count).toBe(1);
    expect(out.replayed_from_cache).toBe(true);
    expect(out.result.idempotency_key_seen).toBe(true);
    expect(out.command_id).toBe('cmd-2');
    expect(out.result.command_id).toBe('cmd-2');
    expect(out.result.outputs).toEqual({ text: 'first' });
    expect((await idempotency.lookup('cmd-1'))?.result).toMatchObject({
      command_id: 'cmd-1', idempotency_key_seen: false, outputs: { text: 'first' },
    });
  });
});

describe('D-169 § A.7 — two-way grant intersection', () => {
  it('missing per-ingredient grant → status: rejected, code: authority_invalid_grant_scope', async () => {
    const grants = createInMemoryBridgeGrantStore(); // no grant
    const executor = buildExecutor({ status: 'ok', outputs: { text: 'never' } });
    const out = await dispatchBridgeCommand(
      buildCommand('cmd-1'),
      buildDeps(executor, grants),
    );
    expect(out.result.status).toBe('rejected');
    expect(out.result.error?.code).toBe('authority_invalid_grant_scope');
    expect(out.result.error?.message).toContain('no per-ingredient grant');
  });

  it('target_domain_pattern outside the user\'s grant → rejected', async () => {
    const grants = createInMemoryBridgeGrantStore();
    // Grant allows app.hubspot.com but command targets linkedin.com — patterns
    // mismatch on the grant axis even when allowlist would permit.
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const executor = buildExecutor({ status: 'ok', outputs: { text: 'never' } });

    const cmd = buildCommand('cmd-1', { target_domain_pattern: '*://linkedin.com/*' });
    const out = await dispatchBridgeCommand(cmd, buildDeps(executor, grants));
    expect(out.result.status).toBe('rejected');
    expect(out.result.error?.code).toBe('authority_invalid_grant_scope');
    expect(out.result.error?.detail).toBe('*://linkedin.com/*');
  });

  it('target_domain_pattern matches both allowlist + grant → executor runs', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    let exec_count = 0;
    const executor = buildExecutor(async () => {
      exec_count++;
      return { status: 'ok', outputs: { text: 'served' } };
    });
    const out = await dispatchBridgeCommand(
      buildCommand('cmd-1'),
      buildDeps(executor, grants),
    );
    expect(out.result.status).toBe('ok');
    expect(out.result.outputs?.text).toBe('served');
    expect(exec_count).toBe(1);
  });
});

describe('D-148 P3 — cooperative cancel + timeout', () => {
  it.each(['throw', 'reject'])('releases its deadline when an executor fails by %s and retains uncertainty', async failure => {
    vi.useFakeTimers();
    try {
      const grants = createInMemoryBridgeGrantStore();
      await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
      const execute = vi.fn<BridgeActionExecutor['execute']>(() => {
        if (failure === 'throw') throw new Error('Executor lost acknowledgement');
        return Promise.reject(new Error('Executor lost acknowledgement'));
      });
      const deps = buildDeps({ execute }, grants);
      const original = buildCommand('original');
      await expect(dispatchBridgeCommand(original, deps)).rejects.toThrow('lost acknowledgement');
      expect(vi.getTimerCount()).toBe(0);
      const retry = await dispatchBridgeCommand({ ...original, command_id: 'retry' }, deps);
      expect(retry.result.error?.code).toBe('delivery_uncertain');
      expect(execute).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('cooperative cancel mid-execution → status: cancelled', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));

    const cancel_signal = { signalled: false };
    const executor: BridgeActionExecutor = {
      async execute(req) {
        // Caller flips signal during executor await; executor returns
        // ok but dispatcher overrides to cancelled.
        req.cancel.signalled = true;
        return { status: 'ok', outputs: { text: 'partial' } };
      },
    };

    const out = await dispatchBridgeCommand(
      buildCommand('cmd-1'),
      buildDeps(executor, grants),
      cancel_signal,
    );
    expect(out.result.status).toBe('cancelled');
    expect(out.result.outputs).toBeUndefined(); // cancelled status drops outputs
  });

  it('timeout discipline returns status: timeout', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));

    const executor: BridgeActionExecutor = {
      async execute() {
        // Delay longer than timeout — never resolves before timer fires.
        return new Promise((resolve) =>
          setTimeout(() => resolve({ status: 'ok', outputs: { text: 'late' } }), 200),
        );
      },
    };

    const out = await dispatchBridgeCommand(
      buildCommand('cmd-1', { timeout_ms: 50 }),
      buildDeps(executor, grants),
    );
    expect(out.result.status).toBe('timeout');
  });
});

describe('D-148 P3 — output-key passthrough', () => {
  it('executor outputs pass through verbatim (dispatcher does not validate output keys)', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const executor = buildExecutor({
      status: 'ok',
      outputs: { unexpected_key: 'should pass through' },
    });
    // The output-key validate gate lives in actions/executor.ts; the
    // dispatcher trusts the executor's outcome verbatim.
    const out = await dispatchBridgeCommand(
      buildCommand('cmd-1'),
      buildDeps(executor, grants),
    );
    expect(out.result.status).toBe('ok');
    expect(out.result.outputs).toEqual({ unexpected_key: 'should pass through' });
  });
});

describe('D-169 P0 Slice 2A — clamp + resolve helpers', () => {
  it('clampCommandTimeout enforces max 60s', () => {
    expect(clampCommandTimeout(70_000)).toBe(BRIDGE_COMMAND_MAX_TIMEOUT_MS);
  });

  it('clampCommandTimeout falls back to default for invalid', () => {
    expect(clampCommandTimeout(undefined)).toBe(BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS);
    expect(clampCommandTimeout(0)).toBe(BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS);
    expect(clampCommandTimeout(-1)).toBe(BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS);
    expect(clampCommandTimeout(NaN)).toBe(BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS);
  });

  it('resolveCommandAction reads the new `action` envelope field', () => {
    expect(resolveCommandAction(buildCommand('cmd-1', { action: 'click' }))).toBe('click');
    expect(resolveCommandAction(buildCommand('cmd-2', { action: 'read_dom' }))).toBe('read_dom');
  });
});

describe('D-148 P3 — retained-receipt replay', () => {
  it('server retries after reconnect and receives the retained result with idempotency_key_seen: true', async () => {
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const idempotency = createInMemoryIdempotencyCache({ now: () => 1_000 });

    let exec_count = 0;
    const executor = buildExecutor(async () => {
      exec_count++;
      return { status: 'ok', outputs: { text: `attempt-${exec_count}` } };
    });
    const deps = buildDeps(executor, grants, idempotency);

    await dispatchBridgeCommand(buildCommand('cmd-original'), deps);

    // The same worker and cache receive a retry with the same command_id.
    const retry = await dispatchBridgeCommand(buildCommand('cmd-original'), deps);
    expect(retry.replayed_from_cache).toBe(true);
    expect(retry.result.idempotency_key_seen).toBe(true);
    expect(retry.result.outputs?.text).toBe('attempt-1');
    expect(exec_count).toBe(1); // Executor never re-ran
  });
});
