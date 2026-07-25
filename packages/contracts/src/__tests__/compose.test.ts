import { describe, expect, it } from 'vitest';

import {
  composeHandlers,
  handlerSlice,
  type HandlerSlice,
  type RpcMethodSpec,
} from '../rpc/index.js';

// Minimal fake registry + Ctx used throughout. Two namespaces and a
// singleton method — enough to exercise every case below.
type TestRegistry = {
  'cache.get': RpcMethodSpec<{ key: string }, { value: string | null }>;
  'cache.put': RpcMethodSpec<{ key: string; value: string }, { ok: true }>;
  'prefs.get': RpcMethodSpec<void, { prefs: Record<string, unknown> }>;
  'ping': RpcMethodSpec<void, { pong: true }>;
};
interface TestCtx { instance_id: string }

const makeCacheSlice = (): HandlerSlice<TestRegistry, 'cache.get' | 'cache.put', TestCtx> =>
  handlerSlice<TestRegistry, 'cache.get' | 'cache.put', TestCtx>({
    methods: ['cache.get', 'cache.put'],
    handlers: {
      'cache.get': async ({ key }) => ({ value: key === 'known' ? 'hit' : null }),
      'cache.put': async () => ({ ok: true }),
    },
  });

const makePrefsSlice = (): HandlerSlice<TestRegistry, 'prefs.get', TestCtx> =>
  handlerSlice<TestRegistry, 'prefs.get', TestCtx>({
    methods: ['prefs.get'],
    handlers: {
      'prefs.get': async () => ({ prefs: {} }),
    },
  });

describe('composeHandlers', () => {
  it('merges multiple slices into one handler map', () => {
    const { handlers, wiredMethods } = composeHandlers<TestRegistry, TestCtx>([
      makeCacheSlice(),
      makePrefsSlice(),
    ]);

    expect(Object.keys(handlers).sort()).toEqual(['cache.get', 'cache.put', 'prefs.get']);
    expect(wiredMethods.has('cache.get')).toBe(true);
    expect(wiredMethods.has('cache.put')).toBe(true);
    expect(wiredMethods.has('prefs.get')).toBe(true);
    expect(wiredMethods.has('ping')).toBe(false);
  });

  it('drops undefined slices silently', () => {
    const { handlers, wiredMethods } = composeHandlers<TestRegistry, TestCtx>([
      makeCacheSlice(),
      undefined,
      makePrefsSlice(),
    ]);

    expect(wiredMethods.size).toBe(3);
    expect(Object.keys(handlers).sort()).toEqual(['cache.get', 'cache.put', 'prefs.get']);
  });

  it('returns empty registry + empty method set for an empty slice list', () => {
    const { handlers, wiredMethods } = composeHandlers<TestRegistry, TestCtx>([]);
    expect(Object.keys(handlers)).toEqual([]);
    expect(wiredMethods.size).toBe(0);
  });

  it('treats a slice list of only undefined the same as empty', () => {
    const { handlers, wiredMethods } = composeHandlers<TestRegistry, TestCtx>([
      undefined,
      undefined,
    ]);
    expect(Object.keys(handlers)).toEqual([]);
    expect(wiredMethods.size).toBe(0);
  });

  it('throws on duplicate method claims across slices', () => {
    const sliceA = handlerSlice<TestRegistry, 'cache.get', TestCtx>({
      methods: ['cache.get'],
      handlers: { 'cache.get': async () => ({ value: 'a' }) },
    });
    const sliceB = handlerSlice<TestRegistry, 'cache.get', TestCtx>({
      methods: ['cache.get'],
      handlers: { 'cache.get': async () => ({ value: 'b' }) },
    });

    expect(() => composeHandlers<TestRegistry, TestCtx>([sliceA, sliceB]))
      .toThrow(/duplicate handler claim for 'cache\.get'/);
  });

  it('preserves handler behaviour through composition', async () => {
    const { handlers } = composeHandlers<TestRegistry, TestCtx>([
      makeCacheSlice(),
      makePrefsSlice(),
    ]);

    const ctx: TestCtx = { instance_id: 'ext-1' };
    const hit = await handlers['cache.get']?.({ key: 'known' }, ctx);
    const miss = await handlers['cache.get']?.({ key: 'unknown' }, ctx);
    const put = await handlers['cache.put']?.({ key: 'k', value: 'v' }, ctx);
    const prefs = await handlers['prefs.get']?.(undefined as never, ctx);

    expect(hit).toEqual({ value: 'hit' });
    expect(miss).toEqual({ value: null });
    expect(put).toEqual({ ok: true });
    expect(prefs).toEqual({ prefs: {} });
  });

  it('coexists with a single-method slice', () => {
    const pingSlice = handlerSlice<TestRegistry, 'ping', TestCtx>({
      methods: ['ping'],
      handlers: { 'ping': async () => ({ pong: true }) },
    });
    const { wiredMethods } = composeHandlers<TestRegistry, TestCtx>([
      makeCacheSlice(),
      pingSlice,
    ]);
    expect(wiredMethods.has('ping')).toBe(true);
    expect(wiredMethods.size).toBe(3);
  });

  it('wiredMethods is a live ReadonlySet-compatible view', () => {
    const { wiredMethods } = composeHandlers<TestRegistry, TestCtx>([makeCacheSlice()]);
    // Duck-check the read-only surface we care about.
    expect(typeof wiredMethods.has).toBe('function');
    expect(typeof wiredMethods.size).toBe('number');
    // Iteration works.
    expect([...wiredMethods].sort()).toEqual(['cache.get', 'cache.put']);
  });
});

describe('handlerSlice', () => {
  it('is an identity for the slice object', () => {
    const slice: HandlerSlice<TestRegistry, 'cache.get', TestCtx> = {
      methods: ['cache.get'],
      handlers: { 'cache.get': async () => ({ value: null }) },
    };
    expect(handlerSlice<TestRegistry, 'cache.get', TestCtx>(slice)).toBe(slice);
  });
});
