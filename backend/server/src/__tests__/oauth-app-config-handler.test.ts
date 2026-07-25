/** server.{get,set,clear}OAuthAppConfig handlers. */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import type { OAuthAppIssuer } from '@recued/contracts';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';
import { createOAuthAppConfigStore, type OAuthAppConfigStore } from '../oauth-app-config-store.js';

const KEY = new Uint8Array(32).fill(9);
type EnvStatus = { client_id: string | null; has_secret: boolean };
const NO_ENV: Record<OAuthAppIssuer, EnvStatus> = {
  google: { client_id: null, has_secret: false },
  microsoft: { client_id: null, has_secret: false },
};

const setup = (
  env: Record<OAuthAppIssuer, EnvStatus> = NO_ENV,
  store?: OAuthAppConfigStore,
) => {
  const s = store ?? createOAuthAppConfigStore(new Database(':memory:'), { getEncryptionKey: () => KEY });
  const slice = makeOAuthAppConfigHandlers({ store: s, envConfigFor: (issuer) => env[issuer] })!;
  const get = () => slice.handlers['server.getOAuthAppConfig'](undefined as never, {} as never);
  const set = (args: unknown) => slice.handlers['server.setOAuthAppConfig'](args as never, {} as never);
  const clear = (args: unknown) => slice.handlers['server.clearOAuthAppConfig'](args as never, {} as never);
  return { store: s, get, set, clear };
};

describe('OAuth app config handlers', () => {
  it('getOAuthAppConfig: unconfigured → source null, no client_id, no secret', async () => {
    const snap = await setup().get();
    expect(snap.google).toEqual({ client_id: null, has_secret: false, source: null });
    expect(snap.microsoft).toEqual({ client_id: null, has_secret: false, source: null });
  });

  it('set then get: source "stored", client_id shown, has_secret true — secret never returned', async () => {
    const { get, set } = setup();
    await set({ issuer: 'google', client_id: 'gid', client_secret: 'gsecret' });
    const snap = await get();
    expect(snap.google).toEqual({ client_id: 'gid', has_secret: true, source: 'stored' });
    // No client_secret anywhere in the response shape.
    expect(JSON.stringify(snap)).not.toContain('gsecret');
    expect(JSON.stringify(snap)).not.toContain('client_secret');
  });

  it('env fallback (nothing stored) → source "env"', async () => {
    const env = {
      google: { client_id: 'env-gid', has_secret: true },
      microsoft: NO_ENV.microsoft,
    };
    const snap = await setup(env).get();
    expect(snap.google).toEqual({ client_id: 'env-gid', has_secret: true, source: 'env' });
    expect(snap.microsoft.source).toBeNull();
  });

  it('stored overrides env in the status', async () => {
    const env = { google: { client_id: 'env-gid', has_secret: true }, microsoft: NO_ENV.microsoft };
    const { get, set } = setup(env);
    await set({ issuer: 'google', client_id: 'ui-gid', client_secret: 's' });
    const snap = await get();
    expect(snap.google).toEqual({ client_id: 'ui-gid', has_secret: true, source: 'stored' });
  });

  it('clear reverts to env (or null)', async () => {
    const env = { google: { client_id: 'env-gid', has_secret: true }, microsoft: NO_ENV.microsoft };
    const { get, set, clear } = setup(env);
    await set({ issuer: 'google', client_id: 'ui-gid', client_secret: 's' });
    await clear({ issuer: 'google' });
    expect((await get()).google).toEqual({ client_id: 'env-gid', has_secret: true, source: 'env' });
  });

  it('set rejects an unknown issuer + empty fields with bad_request', async () => {
    const { set } = setup();
    await expect(set({ issuer: 'apple', client_id: 'x', client_secret: 'y' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(set({ issuer: 'google', client_id: '  ', client_secret: 'y' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(set({ issuer: 'google', client_id: 'x', client_secret: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('set on a locked store surfaces RpcError locked', async () => {
    const locked = createOAuthAppConfigStore(new Database(':memory:'), { getEncryptionKey: () => null });
    const { set } = setup(NO_ENV, locked);
    await expect(set({ issuer: 'google', client_id: 'gid', client_secret: 'gsecret' })).rejects.toMatchObject({
      code: 'locked',
    });
  });
});
