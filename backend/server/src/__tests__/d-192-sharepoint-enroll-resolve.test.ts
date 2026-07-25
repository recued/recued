/** D-192 CORE #5e — SharePoint site→drive auto-resolution at enrollment.
 *
 *  Drives the FULL wiring through `handleConnectionEnroll`: a `sharepoint`
 *  connection enrolled with a `config.site_url` (and no `config.drive_id`) is
 *  refreshed once for a Graph access token, the site's default library drive id
 *  is resolved, and the drive id is persisted into the stored config while the
 *  ROTATED refresh token (Microsoft rotates on refresh) is persisted into the
 *  stored auth. The injected `resolveFetch` returns real `Response` objects so the
 *  origin-pinned `refreshOAuth2` is satisfied end-to-end — no network. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MICROSOFT_GRAPH_API_BASE,
  MICROSOFT_TOKEN_URL,
  type ConnectionAuth,
} from '@recued/contracts';

import {
  decodeAuthFromStorage,
  handleConnectionEnroll,
  type ConnectionRpcDeps,
} from '../connection-handler.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;
const key = new Uint8Array(32).fill(9);
const getEncryptionKey = (): Uint8Array => key;

let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
});
afterEach(() => {
  db.close();
});

const oauthAuth = (): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'REFRESH_ORIGINAL',
  client_id: 'CLIENT_ID',
  client_secret: 'CLIENT_SECRET',
  token_endpoint: MICROSOFT_TOKEN_URL,
});

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** A `typeof fetch` stub returning real `Response`s. Routes the token-refresh
 *  POST (→ rotated refresh token + a fresh access token) and the Graph `/drive`
 *  GET (→ a scripted status/body), recording every call for assertions. */
const makeResolveFetch = (graph: { status: number; body?: unknown }): {
  resolveFetch: typeof fetch;
  calls: Call[];
} => {
  const calls: Call[] = [];
  const resolveFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, method: init?.method ?? 'GET', authorization });
    if (url === MICROSOFT_TOKEN_URL) {
      return new Response(
        JSON.stringify({ access_token: 'ACCESS_1', refresh_token: 'REFRESH_ROTATED', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/drive')) {
      return new Response(JSON.stringify(graph.body ?? {}), {
        status: graph.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { resolveFetch, calls };
};

const enrollSharePoint = async (
  deps: Partial<ConnectionRpcDeps>,
  config: Record<string, unknown>,
  auth: ConnectionAuth = oauthAuth(),
  name = 'sharepoint',
): Promise<void> => {
  await handleConnectionEnroll(
    { store, now: () => NOW, getEncryptionKey, ...deps },
    { name, kind: 'api', display_name: 'SharePoint', config, auth },
  );
};

const storedConfig = (name: string): Record<string, unknown> =>
  JSON.parse(store.get('api', name)!.config_json) as Record<string, unknown>;
const storedAuth = async (name: string): Promise<ConnectionAuth> =>
  decodeAuthFromStorage(store.get('api', name)!.auth_ciphertext, { kind: 'api', name }, getEncryptionKey);

describe('handleConnectionEnroll — SharePoint site→drive resolution (D-192 CORE #5e)', () => {
  it('resolves drive_id from site_url, persists it + the ROTATED refresh token + the access token', async () => {
    const { resolveFetch, calls } = makeResolveFetch({ status: 200, body: { id: 'b!RESOLVED' } });
    await enrollSharePoint(
      { resolveFetch },
      {
        vendor: 'sharepoint',
        base_url: MICROSOFT_GRAPH_API_BASE,
        site_url: 'https://contoso.sharepoint.com/sites/TeamDocs',
      },
    );

    // drive_id landed in the stored config.
    expect(storedConfig('sharepoint').drive_id).toBe('b!RESOLVED');

    // The rotated refresh token + the fresh access token were persisted (NOT the
    // pre-refresh token — Microsoft may have invalidated it).
    const auth = await storedAuth('sharepoint');
    expect(auth.type).toBe('oauth2_refresh');
    if (auth.type === 'oauth2_refresh') {
      expect(auth.refresh_token).toBe('REFRESH_ROTATED');
      expect(auth.current_access_token).toBe('ACCESS_1');
    }

    // The dance: refresh POST to the token endpoint, then a Graph GET carrying the
    // fresh access token as the bearer.
    expect(calls[0]).toMatchObject({ url: MICROSOFT_TOKEN_URL, method: 'POST' });
    expect(calls[1]).toMatchObject({
      url: 'https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/TeamDocs:/drive',
      method: 'GET',
      authorization: 'Bearer ACCESS_1',
    });
  });

  it('an explicit drive_id (advanced override) is preserved WITHOUT any network call or token refresh', async () => {
    const { resolveFetch, calls } = makeResolveFetch({ status: 200, body: { id: 'b!SHOULD_NOT_BE_USED' } });
    await enrollSharePoint(
      { resolveFetch },
      {
        vendor: 'sharepoint',
        base_url: MICROSOFT_GRAPH_API_BASE,
        drive_id: 'b!HAND_COPIED',
        site_url: 'https://contoso.sharepoint.com/sites/TeamDocs', // ignored — drive_id wins
      },
    );
    expect(storedConfig('sharepoint').drive_id).toBe('b!HAND_COPIED');
    expect(calls).toEqual([]); // no refresh, no Graph call
    // The original auth is stored untouched (no refresh happened).
    const auth = await storedAuth('sharepoint');
    if (auth.type === 'oauth2_refresh') {
      expect(auth.refresh_token).toBe('REFRESH_ORIGINAL');
      expect(auth.current_access_token).toBeUndefined();
    }
  });

  it('neither site_url nor drive_id → a bad_request (nothing to target)', async () => {
    const { resolveFetch, calls } = makeResolveFetch({ status: 200, body: { id: 'b!X' } });
    await expect(
      enrollSharePoint({ resolveFetch }, { vendor: 'sharepoint', base_url: MICROSOFT_GRAPH_API_BASE }),
    ).rejects.toThrow(/either a site URL .* or a document library drive ID/);
    expect(calls).toEqual([]);
    expect(store.get('api', 'sharepoint')).toBeNull(); // nothing persisted
  });

  it('a Graph 403 (missing Sites.Read.All) → a bad_request, nothing persisted', async () => {
    const { resolveFetch } = makeResolveFetch({ status: 403 });
    await expect(
      enrollSharePoint(
        { resolveFetch },
        { vendor: 'sharepoint', base_url: MICROSOFT_GRAPH_API_BASE, site_url: 'https://contoso.sharepoint.com/sites/X' },
      ),
    ).rejects.toThrow(/Sites\.Read\.All/);
    expect(store.get('api', 'sharepoint')).toBeNull();
  });

  it('a token-refresh failure → a bad_request pointing at reconnect', async () => {
    // A resolveFetch whose token endpoint 400s (expired refresh token).
    const resolveFetch = (async (input: string | URL) => {
      if (String(input) === MICROSOFT_TOKEN_URL) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await expect(
      enrollSharePoint(
        { resolveFetch },
        { vendor: 'sharepoint', base_url: MICROSOFT_GRAPH_API_BASE, site_url: 'https://contoso.sharepoint.com/sites/X' },
      ),
    ).rejects.toThrow(/couldn't authenticate to Microsoft Graph/);
    expect(store.get('api', 'sharepoint')).toBeNull();
  });

  it('a NON-sharepoint enroll never resolves + never touches the network', async () => {
    const { resolveFetch, calls } = makeResolveFetch({ status: 200, body: { id: 'b!X' } });
    await enrollSharePoint(
      { resolveFetch },
      { vendor: 'onedrive', base_url: MICROSOFT_GRAPH_API_BASE },
      oauthAuth(),
      'onedrive',
    );
    expect(calls).toEqual([]);
    expect(storedConfig('onedrive').drive_id).toBeUndefined();
  });
});
