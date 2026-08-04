/** D-129 Phase 1.2 — `collection.connection.completeVendorOAuth` rpc
 *  + `connection-vendor-oauth.ts` helper coverage.
 *
 *  Two layers:
 *    - rpc validation + error mapping (handler in connection-handler.ts).
 *    - helper round-trips (token exchange + introspection in
 *      connection-vendor-oauth.ts).
 *
 *  Real network calls are fully faked through the injected `fetcher`
 *  shape — same pattern `collections/mail/oauth.ts` tests use. The
 *  fake captures the URL + init so each test can assert the wire shape
 *  the rpc constructs (form-encoded body, redirect-uri pass-through,
 *  encoded access token in introspect URL). */

import { describe, expect, it, vi } from 'vitest';
import { GENERIC_OAUTH_VENDOR } from '@recued/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import {
  RpcError,
  HUBSPOT_OAUTH_TOKEN_URL,
  HUBSPOT_OAUTH_INTROSPECT_URL,
  PIPEDRIVE_OAUTH_TOKEN_URL,
  CONNECTION_API_TIMEOUT_MS,
  getVendorProvider,
  type ConnectionVendorProvider,
} from '@recued/contracts';

import {
  CrossOriginRedirectError,
  ResponseBodyTooLargeError,
} from '@recued/ingredients';

import { handleConnectionCompleteVendorOAuth } from '../connection-handler.js';
import {
  completeVendorOAuth,
  makeOriginPinnedFetcher,
  parseScopeString,
  VendorOAuthError,
  type HttpFetcher,
} from '../connection-vendor-oauth.js';
import { createConnectionStore } from '../storage/connection-store.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

interface FakeResponse {
  status: number;
  ok?: boolean;
  body: unknown;
}

const makeFetcher = (
  scripted: ReadonlyArray<FakeResponse | ((call: FetchCall) => FakeResponse)>,
): { fetcher: HttpFetcher; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetcher: HttpFetcher = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    if (i >= scripted.length) {
      throw new Error(`fake fetcher exhausted (call #${i + 1}, url=${url})`);
    }
    const next = scripted[i++];
    const r = typeof next === 'function' ? next(call) : next;
    const ok = r.ok ?? (r.status >= 200 && r.status < 300);
    return {
      status: r.status,
      ok,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { fetcher, calls };
};

const makeStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-oauth-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const store = createConnectionStore(db);
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, cleanup };
};

// ────────────────────────────────────────────────────────────────
// rpc: handleConnectionCompleteVendorOAuth
// ────────────────────────────────────────────────────────────────

describe('handleConnectionCompleteVendorOAuth — input validation', () => {
  it('rejects non-object rpc args instead of throwing a raw TypeError', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          null as unknown as Parameters<typeof handleConnectionCompleteVendorOAuth>[1],
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      cleanup();
    }
  });

  it('rejects missing vendor', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: '',
            code: 'C',
            redirect_uri: 'https://app.example.com/cb',
            client_id: 'CID',
            client_secret: 'SEC',
          },
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      cleanup();
    }
  });

  it('rejects missing code', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'hubspot',
            code: '',
            redirect_uri: 'https://app.example.com/cb',
            client_id: 'CID',
            client_secret: 'SEC',
          },
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      cleanup();
    }
  });

  it('rejects missing redirect_uri', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'hubspot',
            code: 'C',
            redirect_uri: '   ',
            client_id: 'CID',
            client_secret: 'SEC',
          },
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      cleanup();
    }
  });

  it('rejects missing client_id', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'hubspot',
            code: 'C',
            redirect_uri: 'https://app.example.com/cb',
            client_id: '',
            client_secret: 'SEC',
          },
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      cleanup();
    }
  });

  it('rejects malformed optional client_secret and sandbox fields', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'hubspot',
            code: 'C',
            redirect_uri: 'https://app.example.com/cb',
            client_id: 'CID',
            client_secret: 123 as unknown as string,
          },
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });

      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'hubspot',
            code: 'C',
            redirect_uri: 'https://app.example.com/cb',
            client_id: 'CID',
            client_secret: 'SEC',
            sandbox: 'false' as unknown as boolean,
          },
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      cleanup();
    }
  });

  it('rejects unknown vendors with the vendor name in the message', async () => {
    const { store, cleanup } = makeStore();
    try {
      // D-130 added 'salesforce' and later Pipedrive to the registry; pick a name that
      // remains unregistered to keep this assertion meaningful.
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'unknownvendor',
            code: 'C',
            redirect_uri: 'https://app.example.com/cb',
            client_id: 'CID',
            client_secret: 'SEC',
          },
        ),
      ).rejects.toThrow(/'unknownvendor'/);
    } finally {
      cleanup();
    }
  });

  describe('R26.2-for-vendors — the generic exchange a loopback flow needs', () => {
    it('accepts an unregistered vendor when it supplies valid HTTPS endpoints', async () => {
      const { store, cleanup } = makeStore();
      try {
        const fetcher = vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ refresh_token: 'RT', access_token: 'AT', scope: 'Contacts.Read' }),
          text: async () => '',
        }));
        const out = await handleConnectionCompleteVendorOAuth(
          { store, fetcher: fetcher as never },
          {
            vendor: GENERIC_OAUTH_VENDOR,
            code: 'C',
            // The loopback self-serve callback — the whole point: no public
            // server URL exists, so `startVendorOAuth` is unreachable.
            redirect_uri: 'http://127.0.0.1:7841/webclient/oauth-callback.html',
            client_id: 'CID',
            authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
            token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          } as never,
        );
        expect(out.refresh_token).toBe('RT');
        // Exchanged against the SUPPLIED endpoint, not a registry one.
        const firstCall = fetcher.mock.calls[0] as unknown as readonly unknown[];
        expect(String(firstCall[0]))
          .toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
      } finally {
        cleanup();
      }
    });

    it('⛔ refuses an unsafe supplied token endpoint', async () => {
      const { store, cleanup } = makeStore();
      try {
        for (const bad of [
          'http://login.example/token',
          'https://user:pw@login.example/token',
          'https://login.example/token#frag',
        ]) {
          await expect(
            handleConnectionCompleteVendorOAuth(
              { store },
              {
                vendor: GENERIC_OAUTH_VENDOR,
                code: 'C',
                redirect_uri: 'http://127.0.0.1:7841/webclient/oauth-callback.html',
                client_id: 'CID',
                authorize_url: 'https://login.example/authorize',
                token_endpoint: bad,
              } as never,
            ),
          ).rejects.toThrow(/complete HTTPS URL/);
        }
      } finally {
        cleanup();
      }
    });

    it('⛔ a REGISTERED vendor ignores supplied endpoints — they cannot bypass its controls', async () => {
      const { store, cleanup } = makeStore();
      try {
        // HubSpot requires a client secret. If the supplied endpoints were
        // honoured they would build a generic provider with no secret gate,
        // and this call would proceed instead of being refused.
        await expect(
          handleConnectionCompleteVendorOAuth(
            { store },
            {
              vendor: 'hubspot',
              code: 'C',
              redirect_uri: 'http://127.0.0.1:7841/webclient/oauth-callback.html',
              client_id: 'CID',
              authorize_url: 'https://evil.example/authorize',
              token_endpoint: 'https://evil.example/token',
            } as never,
          ),
        ).rejects.toThrow(/requires client_secret/);
      } finally {
        cleanup();
      }
    });

    it('still rejects an unregistered vendor with NO endpoints', async () => {
      const { store, cleanup } = makeStore();
      try {
        await expect(
          handleConnectionCompleteVendorOAuth(
            { store },
            {
              vendor: 'unknownvendor',
              code: 'C',
              redirect_uri: 'https://app.example.com/cb',
              client_id: 'CID',
            },
          ),
        ).rejects.toThrow(/'unknownvendor'/);
      } finally {
        cleanup();
      }
    });
  });

  it('rejects HubSpot calls without client_secret (client_secret_required)', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'hubspot',
            code: 'C',
            redirect_uri: 'https://app.example.com/cb',
            client_id: 'CID',
          },
        ),
      ).rejects.toThrow(/requires client_secret/);
    } finally {
      cleanup();
    }
  });
});

describe('handleConnectionCompleteVendorOAuth — happy path', () => {
  it('exchanges HubSpot code, introspects access token, returns refresh_token + granted_scopes', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher([
        // Token exchange — HubSpot intentionally omits `scope`.
        { status: 200, body: { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', expires_in: 1800 } },
        // Introspection — granted set surfaces here.
        {
          status: 200,
          body: {
            scopes: [
              'crm.objects.deals.read',
              'crm.objects.contacts.read',
              'crm.objects.companies.read',
              'oauth',
            ],
            user: 'user@example.com',
            hub_id: 1234,
          },
        },
      ]);
      const result = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'hubspot',
          code: 'AUTH-CODE-XYZ',
          redirect_uri: 'https://app.recued.com/connections/hubspot/oauth-callback',
          client_id: 'BYO-CLIENT-ID',
          client_secret: 'BYO-CLIENT-SECRET',
        },
      );
      expect(result).toEqual({
        refresh_token: 'REFRESH-1',
        granted_scopes: [
          'crm.objects.deals.read',
          'crm.objects.contacts.read',
          'crm.objects.companies.read',
          'oauth',
        ],
      });

      // Wire shape — token exchange POST.
      expect(calls[0].url).toBe(HUBSPOT_OAUTH_TOKEN_URL);
      expect(calls[0].init?.method).toBe('POST');
      expect(calls[0].init?.headers?.['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      const body = new URLSearchParams(calls[0].init?.body ?? '');
      expect(body.get('code')).toBe('AUTH-CODE-XYZ');
      expect(body.get('client_id')).toBe('BYO-CLIENT-ID');
      expect(body.get('client_secret')).toBe('BYO-CLIENT-SECRET');
      expect(body.get('redirect_uri')).toBe(
        'https://app.recued.com/connections/hubspot/oauth-callback',
      );
      expect(body.get('grant_type')).toBe('authorization_code');

      // Wire shape — introspect GET.
      expect(calls[1].url).toBe(`${HUBSPOT_OAUTH_INTROSPECT_URL}/ACCESS-1`);
      expect(calls[1].init?.method).toBe('GET');

      // No connection record was created — the dialog calls
      // `collection.connection.enroll` after Save.
      expect(store.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('exchanges Pipedrive code with HTTP Basic client auth and surfaces api_domain as instance_url', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher([
        {
          status: 200,
          body: {
            access_token: 'ACCESS-1',
            refresh_token: 'REFRESH-1',
            expires_in: 1800,
            scope: 'base deals:read deals:full contacts:read',
            api_domain: 'https://user-company.pipedrive.com',
          },
        },
      ]);
      const result = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'pipedrive',
          code: 'AUTH-CODE-XYZ',
          redirect_uri: 'https://app.recued.com/connections/pipedrive/oauth-callback',
          client_id: 'PIPEDRIVE-CLIENT-ID',
          client_secret: 'PIPEDRIVE-CLIENT-SECRET',
        },
      );

      expect(result).toEqual({
        refresh_token: 'REFRESH-1',
        granted_scopes: ['base', 'deals:read', 'deals:full', 'contacts:read'],
        instance_url: 'https://user-company.pipedrive.com',
      });
      expect(calls[0].url).toBe(PIPEDRIVE_OAUTH_TOKEN_URL);
      expect(calls[0].init?.headers?.Authorization).toBe(
        `Basic ${Buffer.from('PIPEDRIVE-CLIENT-ID:PIPEDRIVE-CLIENT-SECRET', 'utf8').toString('base64')}`,
      );
      const body = new URLSearchParams(calls[0].init?.body ?? '');
      expect(body.get('code')).toBe('AUTH-CODE-XYZ');
      expect(body.has('client_id')).toBe(false);
      expect(body.has('client_secret')).toBe(false);
      expect(body.get('redirect_uri')).toBe(
        'https://app.recued.com/connections/pipedrive/oauth-callback',
      );
    } finally {
      cleanup();
    }
  });

  it('refuses an off-provider Pipedrive api_domain before it can become base_url', async () => {
    const { fetcher } = makeFetcher([{ status: 200, body: {
      access_token: 'ACCESS-1',
      refresh_token: 'REFRESH-1',
      scope: 'base',
      api_domain: 'https://attacker.example',
    } }]);
    await expect(completeVendorOAuth({
      provider: getVendorProvider('pipedrive')!,
      code: 'C',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      fetcher,
    })).rejects.toMatchObject({
      code: 'token_response_invalid',
      message: expect.stringContaining('outside the provider allowlist'),
    });
  });

  it('does not grant undeclared instance_url authority to another provider', async () => {
    const { fetcher } = makeFetcher([{ status: 200, body: {
      access_token: 'ACCESS-1',
      refresh_token: 'REFRESH-1',
      scope: 'oauth',
      instance_url: 'https://attacker.example',
      api_domain: 'https://attacker.example',
    } }]);
    await expect(completeVendorOAuth({
      provider: getVendorProvider('hubspot')!,
      code: 'C',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      fetcher,
    })).resolves.toEqual({
      refresh_token: 'REFRESH-1',
      granted_scopes: ['oauth'],
    });
  });
});

describe('handleConnectionCompleteVendorOAuth — error mapping', () => {
  it('maps token-exchange HTTP failure to bad_request with status', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher } = makeFetcher([
        { status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } },
      ]);
      const err = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'hubspot',
          code: 'BAD',
          redirect_uri: 'https://app.example.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
        },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe('bad_request');
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/token exchange failed/);
    } finally {
      cleanup();
    }
  });

  it('maps missing refresh_token in token response to bad_request', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher } = makeFetcher([
        // Provider re-issues a previously-consented account; no refresh_token returned.
        { status: 200, body: { access_token: 'A', expires_in: 1800 } },
      ]);
      const err = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'hubspot',
          code: 'C',
          redirect_uri: 'https://app.example.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
        },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err.message).toMatch(/refresh_token/);
    } finally {
      cleanup();
    }
  });

  it('maps malformed token-response body to bad_request', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher } = makeFetcher([
        { status: 200, body: { wrong_key: 'oops' } },
      ]);
      const err = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'hubspot',
          code: 'C',
          redirect_uri: 'https://app.example.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
        },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe('bad_request');
    } finally {
      cleanup();
    }
  });

  it('soft-fails introspection — refresh_token still surfaces, granted_scopes empty', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher } = makeFetcher([
        // Token exchange succeeds.
        { status: 200, body: { access_token: 'A', refresh_token: 'R', expires_in: 1800 } },
        // Introspection returns 401 (token already revoked, race condition).
        { status: 401, body: { error: 'unauthorized' } },
      ]);
      const result = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'hubspot',
          code: 'C',
          redirect_uri: 'https://app.example.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
        },
      );
      expect(result).toEqual({ refresh_token: 'R', granted_scopes: [] });
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// helper: completeVendorOAuth (unit-level, vendor-agnostic)
// ────────────────────────────────────────────────────────────────

const syntheticProvider = (overrides: Partial<ConnectionVendorProvider['oauth']> = {}): ConnectionVendorProvider => ({
  vendor: 'synthetic',
  display_name: 'Synthetic',
  description: 'Test provider.',
  default_base_url: 'https://api.synthetic.example/',
  oauth: {
    authorize_url: 'https://auth.synthetic.example/authorize',
    token_endpoint: 'https://auth.synthetic.example/token',
    scopes: ['scope.a', 'scope.b'],
    client_secret_required: false,
    ...overrides,
  },
  webhook_signature_header: 'X-Synthetic-Signature',
  default_cadence: '6h',
});

describe('completeVendorOAuth helper', () => {
  it('refuses an unsafe provider token endpoint before sending the code or client secret', async () => {
    const { fetcher, calls } = makeFetcher([]);
    let rejected: unknown;
    try {
      await completeVendorOAuth({
        provider: syntheticProvider({
          token_endpoint:
            'https://owner:PROVIDER-ENDPOINT-PASSWORD@auth.synthetic.example/token',
        }),
        code: 'AUTHORIZATION-CODE',
        redirect_uri: 'https://example.com/cb',
        client_id: 'CID',
        client_secret: 'CLIENT-SECRET',
        fetcher,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'token_exchange_failed',
      status: 400,
    });
    expect(`${String(rejected)} ${JSON.stringify(rejected)}`)
      .not.toContain('PROVIDER-ENDPOINT-PASSWORD');
    expect(calls).toHaveLength(0);
  });

  it('uses scope from token response when vendor declares no introspect URL (RFC-compliant path)', async () => {
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'A',
          refresh_token: 'R',
          expires_in: 3600,
          // RFC 6749 § 3.3 — space-separated scope list echoed back.
          scope: 'scope.a scope.b',
        },
      },
    ]);
    const result = await completeVendorOAuth({
      provider: syntheticProvider(),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher,
    });
    expect(result).toEqual({
      refresh_token: 'R',
      granted_scopes: ['scope.a', 'scope.b'],
    });
    // Only the token exchange call — introspect is skipped when scope echoes.
    expect(calls).toHaveLength(1);
  });

  it('omits client_secret from the token-exchange body when caller does not pass one', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 200, body: { access_token: 'A', refresh_token: 'R', expires_in: 60, scope: 'oauth' } },
    ]);
    await completeVendorOAuth({
      provider: syntheticProvider(),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher,
    });
    const body = new URLSearchParams(calls[0].init?.body ?? '');
    expect(body.has('client_secret')).toBe(false);
  });

  it('sends code_verifier in the token-exchange body when supplied (PKCE)', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 200, body: { access_token: 'A', refresh_token: 'R', expires_in: 60, scope: 'oauth' } },
    ]);
    await completeVendorOAuth({
      provider: syntheticProvider(),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      code_verifier: 'pkce-verifier-xyz',
      fetcher,
    });
    const body = new URLSearchParams(calls[0].init?.body ?? '');
    expect(body.get('code_verifier')).toBe('pkce-verifier-xyz');
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('omits code_verifier from the body when not supplied (non-PKCE vendor)', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 200, body: { access_token: 'A', refresh_token: 'R', expires_in: 60, scope: 'oauth' } },
    ]);
    await completeVendorOAuth({
      provider: syntheticProvider(),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher,
    });
    const body = new URLSearchParams(calls[0].init?.body ?? '');
    expect(body.has('code_verifier')).toBe(false);
  });

  it('throws VendorOAuthError(token_exchange_failed) on non-2xx token endpoint response', async () => {
    const { fetcher } = makeFetcher([
      { status: 500, body: 'upstream exploded' },
    ]);
    await expect(
      completeVendorOAuth({
        provider: syntheticProvider(),
        code: 'C',
        redirect_uri: 'https://example.com/cb',
        client_id: 'CID',
        fetcher,
      }),
    ).rejects.toMatchObject({
      name: 'VendorOAuthError',
      code: 'token_exchange_failed',
      status: 500,
    });
  });

  it('handles introspection-network throw without leaking — granted_scopes empty', async () => {
    const fetcher: HttpFetcher = vi.fn(async (url) => {
      if (url.includes('/token')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ access_token: 'A', refresh_token: 'R', expires_in: 60 }),
          text: async () => '',
        };
      }
      throw new Error('DNS failure on introspect');
    });
    const result = await completeVendorOAuth({
      provider: syntheticProvider({
        access_token_introspect_url: 'https://introspect.synthetic.example/at',
      }),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher,
    });
    expect(result.refresh_token).toBe('R');
    expect(result.granted_scopes).toEqual([]);
  });

  it('soft-fails an unsafe introspection endpoint without sending the access token', async () => {
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: { access_token: 'ACCESS-TOKEN', refresh_token: 'R', expires_in: 60 },
      },
    ]);
    const result = await completeVendorOAuth({
      provider: syntheticProvider({
        access_token_introspect_url:
          'https://owner:password@introspect.synthetic.example/at',
      }),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher,
    });

    expect(result).toEqual({ refresh_token: 'R', granted_scopes: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://auth.synthetic.example/token');
  });

  it('encodes the access token in the introspect URL path', async () => {
    const { fetcher, calls } = makeFetcher([
      // Token-exchange — access token contains characters that must be URL-encoded.
      { status: 200, body: { access_token: 'ACCESS+TOKEN/WITH=SPECIAL', refresh_token: 'R', expires_in: 60 } },
      { status: 200, body: { scopes: ['oauth'] } },
    ]);
    await completeVendorOAuth({
      provider: syntheticProvider({
        access_token_introspect_url: 'https://introspect.synthetic.example/at',
      }),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher,
    });
    expect(calls[1].url).toBe(
      `https://introspect.synthetic.example/at/${encodeURIComponent('ACCESS+TOKEN/WITH=SPECIAL')}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// SSRF redirect pin — makeOriginPinnedFetcher + completeVendorOAuth
// integration (the vendor token + introspection endpoints).
// ────────────────────────────────────────────────────────────────

/** Build a native-`fetch` fake returning real `Response` objects. The
 *  origin-pinned fetcher follows redirects MANUALLY (`redirect: 'manual'`),
 *  so the fake just returns the scripted 3xx / 2xx per call. */
const makeNativeFetch = (
  responses: ReadonlyArray<Response>,
): { fetchImpl: typeof fetch; urls: string[] } => {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL) => {
    urls.push(String(input));
    if (i >= responses.length) {
      throw new Error(`native fetch fake exhausted (call #${i + 1})`);
    }
    return responses[i++];
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

describe('makeOriginPinnedFetcher — SSRF redirect pin', () => {
  it('keeps its deadline active while a provider response body stalls', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = makeOriginPinnedFetcher((async (_input, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = (): void => {
              const error = new Error('body aborted');
              error.name = 'AbortError';
              controller.error(error);
            };
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch);
      const pending = fetcher('https://auth.synthetic.example/token');
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(CONNECTION_API_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token response over the one-MiB ceiling before buffering it', async () => {
    const fetcher = makeOriginPinnedFetcher((async () =>
      new Response('{}', {
        headers: { 'content-length': String(1024 * 1024 + 1) },
      })) as typeof fetch);

    await expect(fetcher('https://auth.synthetic.example/token'))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it('refuses the first cross-origin redirect before contacting the target', async () => {
    const { fetchImpl, urls } = makeNativeFetch([
      new Response(null, {
        status: 302,
        // Cloud metadata host — the classic SSRF-via-redirect target.
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    ]);
    const fetcher = makeOriginPinnedFetcher(fetchImpl);
    await expect(
      fetcher('https://auth.synthetic.example/token', { method: 'POST', body: 'code=C' }),
    ).rejects.toBeInstanceOf(CrossOriginRedirectError);
    // Only the enrolled origin was contacted — the redirect target never was.
    expect(urls).toEqual(['https://auth.synthetic.example/token']);
  });

  it('follows same-origin redirects (vendor canonicalization)', async () => {
    const { fetchImpl, urls } = makeNativeFetch([
      new Response(null, {
        status: 302,
        headers: { location: 'https://auth.synthetic.example/token/v2' },
      }),
      new Response(JSON.stringify({ access_token: 'A' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const fetcher = makeOriginPinnedFetcher(fetchImpl);
    const res = await fetcher('https://auth.synthetic.example/token', { method: 'POST', body: 'x' });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ access_token: 'A' });
    expect(urls).toEqual([
      'https://auth.synthetic.example/token',
      'https://auth.synthetic.example/token/v2',
    ]);
  });

  it('passes a non-redirecting response straight through', async () => {
    const { fetchImpl } = makeNativeFetch([
      new Response(JSON.stringify({ scopes: ['oauth'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const res = await makeOriginPinnedFetcher(fetchImpl)(
      'https://introspect.synthetic.example/at/TOKEN',
      { method: 'GET' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scopes: ['oauth'] });
  });
});

describe('completeVendorOAuth — origin-pinned redirect refusal', () => {
  it('surfaces a token-exchange cross-origin redirect as VendorOAuthError(token_exchange_failed)', async () => {
    const { fetchImpl } = makeNativeFetch([
      new Response(null, {
        status: 307,
        headers: { location: 'http://169.254.169.254/latest/' },
      }),
    ]);
    await expect(
      completeVendorOAuth({
        provider: syntheticProvider(),
        code: 'C',
        redirect_uri: 'https://example.com/cb',
        client_id: 'CID',
        fetcher: makeOriginPinnedFetcher(fetchImpl),
      }),
    ).rejects.toMatchObject({
      name: 'VendorOAuthError',
      code: 'token_exchange_failed',
      status: 502,
    });
  });

  it('pins the PRODUCTION default path (no injected fetcher) — stubbed global fetch redirect refused', async () => {
    // No `fetcher` option → completeVendorOAuth falls back to the internal
    // `defaultFetcher = makeOriginPinnedFetcher()`. Stub global fetch to
    // return a cross-origin redirect off the token endpoint; the default
    // path must refuse it (proving the fallback is pinned, not just the
    // explicitly-injected fetcher).
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/' },
        }),
      );
    try {
      await expect(
        completeVendorOAuth({
          provider: syntheticProvider(),
          code: 'C',
          redirect_uri: 'https://example.com/cb',
          client_id: 'CID',
          // no fetcher → defaultFetcher
        }),
      ).rejects.toMatchObject({
        name: 'VendorOAuthError',
        code: 'token_exchange_failed',
        status: 502,
      });
      // The token endpoint was contacted once; the metadata host never was.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe(
        'https://auth.synthetic.example/token',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('soft-fails introspection on a cross-origin redirect — refresh_token surfaces, granted_scopes empty', async () => {
    const { fetchImpl } = makeNativeFetch([
      // Token exchange succeeds (HubSpot-style: no `scope` echoed).
      new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      // Introspection endpoint redirects off-origin → refused → soft-fail [].
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/at' },
      }),
    ]);
    const result = await completeVendorOAuth({
      provider: syntheticProvider({
        access_token_introspect_url: 'https://introspect.synthetic.example/at',
      }),
      code: 'C',
      redirect_uri: 'https://example.com/cb',
      client_id: 'CID',
      fetcher: makeOriginPinnedFetcher(fetchImpl),
    });
    expect(result).toEqual({ refresh_token: 'R', granted_scopes: [] });
  });
});

// ────────────────────────────────────────────────────────────────
// helper: parseScopeString edge cases
// ────────────────────────────────────────────────────────────────

describe('parseScopeString', () => {
  it('returns empty for undefined / blank', () => {
    expect(parseScopeString(undefined)).toEqual([]);
    expect(parseScopeString('')).toEqual([]);
    expect(parseScopeString('   ')).toEqual([]);
  });

  it('splits on whitespace and dedupes', () => {
    expect(parseScopeString('a b a c  b')).toEqual(['a', 'b', 'c']);
  });

  it('accepts comma-separated lists (some providers slip in commas)', () => {
    expect(parseScopeString('a, b, c')).toEqual(['a', 'b', 'c']);
  });
});

describe('VendorOAuthError', () => {
  it('carries code + status + message', () => {
    const e = new VendorOAuthError('introspect_failed', 401, 'introspect 401');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('VendorOAuthError');
    expect(e.code).toBe('introspect_failed');
    expect(e.status).toBe(401);
    expect(e.message).toBe('introspect 401');
  });
});
