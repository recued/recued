/** server.{get,set,clear}OAuthAppConfig handlers. */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';
import { createOAuthAppConfigStore, type OAuthAppConfigStore } from '../oauth-app-config-store.js';

const KEY = new Uint8Array(32).fill(9);

const setup = (store?: OAuthAppConfigStore) => {
  const s = store ?? createOAuthAppConfigStore(new Database(':memory:'), { getEncryptionKey: () => KEY });
  const slice = makeOAuthAppConfigHandlers({ store: s })!;
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

  // The store is the ONLY credential source since the six `RECUED_*` OAuth env
  // vars were deleted (2026-07-28). Three tests died with that fallback: "env
  // fallback (nothing stored) → source 'env'", "stored overrides env in the
  // status", and the old "clear reverts to env (or null)". The first two have
  // no surviving claim — the fallback tier they described is gone, and their
  // store-side kernel is already covered above. The third survives with an
  // INVERTED expectation and is kept below, because what happens after a clear
  // is still a real behaviour with a real answer — it is just a different one.

  it('clear leaves the issuer unconfigured — nothing sits behind the store', async () => {
    const { get, set, clear } = setup();
    await set({ issuer: 'google', client_id: 'ui-gid', client_secret: 's' });
    expect((await get()).google).toEqual({ client_id: 'ui-gid', has_secret: true, source: 'stored' });
    await clear({ issuer: 'google' });
    expect((await get()).google).toEqual({ client_id: null, has_secret: false, source: null });
  });

  it('a client_id is only ever reported with source "stored"', async () => {
    // The narrowed union's runtime counterpart: no code path can surface a
    // client_id attributed to anything but the encrypted store. Re-adding a
    // fallback tier that reports through this handler fails here.
    const { get, set } = setup();
    await set({ issuer: 'microsoft', client_id: 'mid', client_secret: 'ms' });
    const snap = await get();
    for (const status of Object.values(snap)) {
      expect(status.source).toBe(status.client_id === null ? null : 'stored');
    }
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
    const { set } = setup(locked);
    await expect(set({ issuer: 'google', client_id: 'gid', client_secret: 'gsecret' })).rejects.toMatchObject({
      code: 'locked',
    });
  });
});
