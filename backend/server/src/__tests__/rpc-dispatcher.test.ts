import { describe, it, expect, vi } from 'vitest';
import { RpcError, type HandlerRegistry, type ServerRpcRegistry } from '@recued/contracts';
import { createRpcDispatcher } from '../rpc-dispatcher.js';

type Ctx = { now: () => number };

describe('createRpcDispatcher — happy path', () => {
  it('looks up method and wraps response in HandlerResult', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'cache.get': async ({ key }: { key: string }) => ({
        entry: {
          key,
          value: 42,
          expires_at: 0,
          recipe_id: 'r',
          ingredient_slug: 's',
          size_bytes: 4,
          created_at: 0,
          last_accessed_at: 0,
        },
      }),
    };
    const dispatch = createRpcDispatcher(registry);
    const res = await dispatch('cache.get', { key: 'abc' }, { now: () => 0 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entry = (res.body as { entry: { key: string; value: number } | null }).entry;
      expect(entry?.key).toBe('abc');
      expect(entry?.value).toBe(42);
    }
  });

  it('passes context through to handler', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'auth.state': async (_: void, ctx: Ctx) => ({
        state: ctx.now() === 42 ? 'unlocked' as const : 'locked' as const,
      }),
    };
    const dispatch = createRpcDispatcher(registry);
    const res = await dispatch('auth.state', undefined as never, { now: () => 42 });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.body as { state: string }).state).toBe('unlocked');
  });
});

describe('createRpcDispatcher — missing method', () => {
  it('returns 501 not_configured when key is absent and no allowlist given', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {};
    const dispatch = createRpcDispatcher(registry);
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(501);
    if (!res.ok) expect(res.error.code).toBe('not_configured');
  });

  it('returns 404 unknown_method when knownMethods set excludes the method', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {};
    const dispatch = createRpcDispatcher(registry, {
      knownMethods: new Set(['cache.get']),
    });
    const res = await dispatch('totally.bogus', {} as never, { now: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    if (!res.ok) expect(res.error.code).toBe('unknown_method');
  });
});

describe('createRpcDispatcher — gates', () => {
  it('returns 503 migration_in_progress when migration is active and method not allowlisted', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'cache.get': async () => ({ entry: null }),
    };
    const dispatch = createRpcDispatcher(registry, { migrationActive: () => true });
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    if (!res.ok) expect(res.error.code).toBe('migration_in_progress');
  });

  it('allows auth.state even during migration', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'auth.state': async () => ({ state: 'locked' }),
    };
    const dispatch = createRpcDispatcher(registry, { migrationActive: () => true });
    const res = await dispatch('auth.state', {}, { now: () => 0 });
    expect(res).toEqual({ ok: true, status: 200, body: { state: 'locked' } });
  });

  it('resets idle timer for non-exempt methods', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'cache.get': async () => ({ entry: null }),
      'auth.state': async () => ({ state: 'unlocked' }),
    };
    const touch = vi.fn();
    const dispatch = createRpcDispatcher(registry, { touchActivity: touch });
    await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(touch).toHaveBeenCalledTimes(1);
    await dispatch('auth.state', {}, { now: () => 0 });
    expect(touch).toHaveBeenCalledTimes(1); // state polling is exempt
  });
});

describe('createRpcDispatcher — error normalisation', () => {
  it('converts RpcError to HandlerResult error with code + status', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'auth.unlock': async () => {
        throw new RpcError('unauthorized', 'bad password', 401);
      },
    };
    const dispatch = createRpcDispatcher(registry);
    const res = await dispatch('auth.unlock', { password: 'x' }, { now: () => 0 });
    expect(res).toEqual({
      ok: false,
      status: 401,
      error: { code: 'unauthorized', message: 'bad password' },
    });
  });

  it('converts plain Error to 500 internal', async () => {
    const registry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'cache.get': async () => {
        throw new Error('boom');
      },
    };
    const dispatch = createRpcDispatcher(registry);
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    if (!res.ok) {
      expect(res.error.code).toBe('internal');
      expect(res.error.message).toContain('boom');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle gate (Phase C)
// ────────────────────────────────────────────────────────────────

describe('createRpcDispatcher — lifecycle gate', () => {
  const echoHandler: HandlerRegistry<ServerRpcRegistry, Ctx> = {
    'cache.get': async ({ key }: { key: string }) => ({
      entry: {
        key, value: null, expires_at: 0, recipe_id: 'r', ingredient_slug: 's',
        size_bytes: 0, created_at: 0, last_accessed_at: 0,
      },
    }),
  };

  it('returns 503 not_ready while booting for non-exempt methods', async () => {
    const dispatch = createRpcDispatcher(echoHandler, {
      lifecycleState: () => 'booting',
    });
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    if (!res.ok) expect(res.error.code).toBe('not_ready');
  });

  it('returns 503 draining while draining for non-exempt methods', async () => {
    const dispatch = createRpcDispatcher(echoHandler, {
      lifecycleState: () => 'draining',
    });
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    if (!res.ok) expect(res.error.code).toBe('draining');
  });

  it('allows every state for exempt methods', async () => {
    const lifecycleRegistry: HandlerRegistry<ServerRpcRegistry, Ctx> = {
      'server.getStatus': async () => ({
        version: 'test',
        storage_state: 'running',
        crash_halt_active: false,
        paused: false,
        pressure_details: { worst_state: 'running', per_surface: [] },
      }),
    };
    for (const state of ['booting', 'draining', 'restarting', 'shutting_down', 'crashed'] as const) {
      const dispatch = createRpcDispatcher(lifecycleRegistry, {
        lifecycleState: () => state,
      });
      const res = await dispatch('server.getStatus', {}, { now: () => 0 });
      expect(res.ok).toBe(true);
    }
  });

  it('allows all methods when state is running', async () => {
    const dispatch = createRpcDispatcher(echoHandler, {
      lifecycleState: () => 'running',
    });
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(true);
  });

  it('no-ops when lifecycleState is not wired (Phase A/B compat)', async () => {
    const dispatch = createRpcDispatcher(echoHandler);
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(true);
  });

  it('lifecycle gate fires before migration gate (both can reject the same method)', async () => {
    // Precedence: if both would reject, lifecycle wins (more constrained).
    const dispatch = createRpcDispatcher(echoHandler, {
      lifecycleState: () => 'draining',
      migrationActive: () => true,
    });
    const res = await dispatch('cache.get', { key: 'x' }, { now: () => 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('draining');
  });
});
