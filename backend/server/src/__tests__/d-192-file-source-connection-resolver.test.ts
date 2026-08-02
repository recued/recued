/** D-192 file SOURCE family — `createFileSourceConnectionResolver`.
 *
 *  The fix for the codex HIGH: a purpose-enrolled Dropbox `oauth2_refresh`
 *  connection has a `refresh_token` but no `current_access_token`, and the
 *  file-source path bypasses the `connection` adapter's refresh — so the mirror
 *  never synced. This resolver runs the decrypted auth through the shared
 *  `createEnsureFreshAuth` gate.
 *
 *  Coverage: an `oauth2_refresh` auth missing `current_access_token` is
 *  refreshed (token endpoint hit) + persisted (re-encoded upsert) + returned
 *  with the fresh token; S3's `basic` auth passes through UNTOUCHED (no fetch,
 *  no upsert); an already-fresh `oauth2_refresh` token is not re-refreshed;
 *  an unknown connection resolves to null; config is parsed alongside. */

import { describe, expect, it, vi } from 'vitest';

import type { ConnectionAuth, ConnectionKind, ConnectionRow } from '@recued/contracts';

import { createFileSourceConnectionResolver } from '../file-source-connection-resolver.js';
import type { ConnectionUpsert } from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;

/** A minimal connection store fake — a Map keyed by `(kind, name)`, with `get`
 *  + `upsert` (upsert restamps the row so a follow-up get sees the persisted
 *  auth). `auth_ciphertext` carries the auth as JSON so the fake decode/encode
 *  round-trip is a plain JSON stringify/parse (no crypto in the unit test). */
const makeStore = (seed: ConnectionRow[]) => {
  const rows = new Map<string, ConnectionRow>();
  for (const r of seed) rows.set(`${r.kind}:${r.name}`, r);
  const upserts: ConnectionUpsert[] = [];
  return {
    upserts,
    get: (kind: ConnectionKind, name: string): ConnectionRow | null =>
      rows.get(`${kind}:${name}`) ?? null,
    upsert: (input: ConnectionUpsert): ConnectionRow => {
      upserts.push(input);
      const row = { pk: `${input.kind}:${input.name}`, ...input } as ConnectionRow;
      rows.set(`${input.kind}:${input.name}`, row);
      return row;
    },
  };
};

const makeRow = (name: string, auth: ConnectionAuth, config: Record<string, unknown>): ConnectionRow =>
  ({
    pk: `api:${name}`,
    kind: 'api',
    name,
    display_name: name,
    config_json: JSON.stringify(config),
    auth_ciphertext: JSON.stringify(auth), // fake decode = JSON.parse
    enrolled_at: NOW,
    updated_at: NOW,
  }) as ConnectionRow;

/** Fake AEAD primitives — round-trip the auth as JSON (no real crypto). */
const decodeAuthFromStorage = (async (ciphertext: string) =>
  JSON.parse(ciphertext) as ConnectionAuth) as unknown as (typeof import(
  '../connection-handler.js'
))['decodeAuthFromStorage'];
const encodeAuthForStorage = (async (auth: ConnectionAuth) =>
  JSON.stringify(auth)) as unknown as (typeof import('../connection-handler.js'))['encodeAuthForStorage'];

/** A token-endpoint fetch that mints a fresh access token. */
const tokenFetch = (accessToken: string): typeof fetch =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (): string | null => null },
    json: async () => ({ access_token: accessToken, expires_in: 14_400 }),
  })) as unknown as typeof fetch;

const dropboxOAuth = (currentAccessToken?: string, expiresAt?: number): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'refresh-abc',
  client_id: 'app-key',
  client_secret: 'app-secret',
  token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
  ...(currentAccessToken !== undefined ? { current_access_token: currentAccessToken } : {}),
  ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
});

describe('createFileSourceConnectionResolver — Dropbox oauth2_refresh', () => {
  it('refreshes + persists + returns a fresh access token when current_access_token is absent', async () => {
    const store = makeStore([
      makeRow('dropbox', dropboxOAuth(/* no current_access_token */), { vendor: 'dropbox' }),
    ]);
    const fetchImpl = tokenFetch('fresh-access');
    const resolve = createFileSourceConnectionResolver({
      connectionStore: store,
      decodeAuthFromStorage,
      encodeAuthForStorage,
      keyProvider: undefined,
      fetchImpl,
      now: () => NOW,
    });

    const out = await resolve('dropbox');
    expect(out).not.toBeNull();
    // The gate refreshed and stamped the fresh token.
    expect(out!.auth.type).toBe('oauth2_refresh');
    expect((out!.auth as { current_access_token?: string }).current_access_token).toBe('fresh-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Persisted best-effort — one upsert carrying the re-encoded fresh auth.
    expect(store.upserts).toHaveLength(1);
    const persisted = JSON.parse(store.upserts[0]!.auth_ciphertext) as { current_access_token?: string };
    expect(persisted.current_access_token).toBe('fresh-access');
    expect(out!.config).toEqual({ vendor: 'dropbox' });
  });

  it('keeps the fresh token usable and reports a non-fatal persistence failure', async () => {
    const row = makeRow(
      'dropbox',
      dropboxOAuth(/* no current_access_token */),
      { vendor: 'dropbox' },
    );
    const store = makeStore([row]);
    const persistError = new Error('connection store is read-only');
    const onPersistFailure = vi.fn();
    const failingEncode = (async () => {
      throw persistError;
    }) as unknown as (typeof import('../connection-handler.js'))['encodeAuthForStorage'];
    const resolve = createFileSourceConnectionResolver({
      connectionStore: store,
      decodeAuthFromStorage,
      encodeAuthForStorage: failingEncode,
      keyProvider: undefined,
      fetchImpl: tokenFetch('fresh-for-this-cycle'),
      now: () => NOW,
      onPersistFailure,
    });

    const out = await resolve('dropbox');

    expect(out?.auth).toMatchObject({
      type: 'oauth2_refresh',
      current_access_token: 'fresh-for-this-cycle',
    });
    expect(store.upserts).toHaveLength(0);
    expect(onPersistFailure).toHaveBeenCalledOnce();
    expect(onPersistFailure).toHaveBeenCalledWith(row, persistError);
  });

  it('does NOT re-refresh an already-fresh token', async () => {
    const store = makeStore([
      makeRow('dropbox', dropboxOAuth('still-good', NOW + 24 * 3_600_000), { vendor: 'dropbox' }),
    ]);
    const fetchImpl = tokenFetch('should-not-be-used');
    const resolve = createFileSourceConnectionResolver({
      connectionStore: store,
      decodeAuthFromStorage,
      encodeAuthForStorage,
      keyProvider: undefined,
      fetchImpl,
      now: () => NOW,
    });

    const out = await resolve('dropbox');
    expect((out!.auth as { current_access_token?: string }).current_access_token).toBe('still-good');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
  });
});

describe('createFileSourceConnectionResolver — S3 basic auth passthrough', () => {
  it('returns basic auth UNTOUCHED — no refresh, no upsert', async () => {
    const basic: ConnectionAuth = { type: 'basic', username: 'AKIA', password: 'secret' };
    const store = makeStore([
      makeRow('s3', basic, { vendor: 's3', region: 'us-east-1', bucket: 'b' }),
    ]);
    const fetchImpl = tokenFetch('unused');
    const resolve = createFileSourceConnectionResolver({
      connectionStore: store,
      decodeAuthFromStorage,
      encodeAuthForStorage,
      keyProvider: undefined,
      fetchImpl,
      now: () => NOW,
    });

    const out = await resolve('s3');
    expect(out!.auth).toEqual(basic);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.upserts).toHaveLength(0);
    expect(out!.config).toEqual({ vendor: 's3', region: 'us-east-1', bucket: 'b' });
  });
});

describe('createFileSourceConnectionResolver — misc', () => {
  it('resolves null for an unknown connection', async () => {
    const store = makeStore([]);
    const resolve = createFileSourceConnectionResolver({
      connectionStore: store,
      decodeAuthFromStorage,
      encodeAuthForStorage,
      keyProvider: undefined,
      now: () => NOW,
    });
    expect(await resolve('nope')).toBeNull();
  });

  it('parses malformed config_json to an empty object', async () => {
    const store = makeStore([]);
    // Seed a row with malformed config via a direct upsert-then-get.
    store.upsert({
      kind: 'api',
      name: 's3',
      display_name: 's3',
      config_json: '{not json}',
      auth_ciphertext: JSON.stringify({ type: 'basic', username: 'a', password: 'b' }),
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const resolve = createFileSourceConnectionResolver({
      connectionStore: store,
      decodeAuthFromStorage,
      encodeAuthForStorage,
      keyProvider: undefined,
      now: () => NOW,
    });
    const out = await resolve('s3');
    expect(out!.config).toEqual({});
  });
});
