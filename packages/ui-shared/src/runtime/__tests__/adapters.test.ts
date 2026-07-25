/** D-121 Phase 3 — `RuntimeAdapters` contract tests.
 *
 *  Covers the four canonical adapter interfaces with mock
 *  implementations that exercise the spec'd behaviors. The point of
 *  the test is to pin down the contract: every concrete adapter
 *  (chrome.*, web.*, mock) must satisfy these shapes so consumers
 *  can swap one for another at the call site. */

import { describe, expect, it, vi } from 'vitest';
import type {
  IdentityAdapter,
  RpcAdapter,
  RuntimeAdapters,
  StorageAdapter,
  TabAdapter,
} from '../adapters.js';

const makeMockStorage = (): StorageAdapter => {
  const data: Record<string, unknown> = {};
  return {
    get: async <T>(key: string) => (data[key] as T | undefined) ?? null,
    set: async (key, value) => {
      data[key] = value;
    },
    remove: async (key) => {
      delete data[key];
    },
  };
};

const makeMockRpc = (): RpcAdapter & { listeners: ((m: unknown) => void)[] } => {
  const listeners: ((m: unknown) => void)[] = [];
  return {
    listeners,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    send: vi.fn(async (_m: unknown) => {}),
  };
};

const makeMockTab = (): TabAdapter => ({
  openOptionsPage: vi.fn(async () => {}),
  openUrl: vi.fn(async (_url: string) => {}),
});

const makeMockIdentity = (): IdentityAdapter => ({
  launchOAuth: async (_authUrl, redirect) =>
    `${redirect}?code=abc&state=xyz`,
  getRedirectUri: () => 'https://test.example/oauth/callback',
});

describe('StorageAdapter contract', () => {
  it('round-trips a value through get / set / remove', async () => {
    const s = makeMockStorage();
    expect(await s.get('k')).toBeNull();
    await s.set('k', { hello: 'world' });
    expect(await s.get<{ hello: string }>('k')).toEqual({ hello: 'world' });
    await s.remove('k');
    expect(await s.get('k')).toBeNull();
  });
});

describe('RpcAdapter contract', () => {
  it('subscribe returns an unsubscribe handle', () => {
    const rpc = makeMockRpc();
    const listener = vi.fn();
    const unsub = rpc.subscribe(listener);
    expect(rpc.listeners).toHaveLength(1);
    rpc.listeners[0]!({ kind: 'test' });
    expect(listener).toHaveBeenCalledWith({ kind: 'test' });
    unsub();
    expect(rpc.listeners).toHaveLength(0);
  });

  it('send resolves to undefined (advisory broadcast)', async () => {
    const rpc = makeMockRpc();
    await expect(rpc.send({ kind: 'noop' })).resolves.toBeUndefined();
    expect(rpc.send).toHaveBeenCalledWith({ kind: 'noop' });
  });
});

describe('TabAdapter contract', () => {
  it('exposes openOptionsPage + openUrl', async () => {
    const tab = makeMockTab();
    await tab.openOptionsPage?.();
    await tab.openUrl('https://example.test/');
    expect(tab.openOptionsPage).toHaveBeenCalled();
    expect(tab.openUrl).toHaveBeenCalledWith('https://example.test/');
  });

  it('allows surfaces without an Options page (openOptionsPage optional)', () => {
    const tab: TabAdapter = {
      openUrl: async () => {},
    };
    // Type-level check: no `openOptionsPage` is a valid TabAdapter.
    expect(tab.openOptionsPage).toBeUndefined();
    expect(typeof tab.openUrl).toBe('function');
  });
});

describe('IdentityAdapter contract', () => {
  it('launchOAuth resolves to a redirect URL with the auth code', async () => {
    const identity = makeMockIdentity();
    const result = await identity.launchOAuth(
      'https://provider.test/auth',
      identity.getRedirectUri(),
    );
    expect(result).toContain('code=');
  });
});

describe('RuntimeAdapters bundle', () => {
  it('composes the four adapters into one record', () => {
    const adapters: RuntimeAdapters = {
      storage: makeMockStorage(),
      rpc: makeMockRpc(),
      tab: makeMockTab(),
      identity: makeMockIdentity(),
    };
    expect(adapters.storage).toBeDefined();
    expect(adapters.rpc).toBeDefined();
    expect(adapters.tab).toBeDefined();
    expect(adapters.identity).toBeDefined();
  });
});
