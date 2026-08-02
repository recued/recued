/** D-130 Phase 1.2 — `collection.connection.completeVendorOAuth` rpc
 *  + `connection-vendor-oauth.ts` helper coverage for Salesforce.
 *
 *  Covers:
 *  - Sandbox flag selects the test.salesforce.com token endpoint.
 *  - Production flag (or omitted) selects the login.salesforce.com
 *    token endpoint.
 *  - Salesforce echoes `scope` per RFC 6749 § 3.3 — granted scopes
 *    parse from the token response, no introspection round-trip.
 *  - rpc validates client_secret presence (Salesforce's
 *    Connected App requires it).
 *  - rpc forwards the sandbox flag through to the helper.
 *
 *  Real network calls are fully faked via the injected `fetcher`
 *  shape — same pattern as D-129's HubSpot OAuth test. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import {
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
} from '@recued/contracts';

import { handleConnectionCompleteVendorOAuth } from '../connection-handler.js';
import {
  completeVendorOAuth,
  parseScopeString,
  type HttpFetcher,
} from '../connection-vendor-oauth.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { getVendorProvider } from '@recued/contracts';

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
  const dir = mkdtempSync(join(tmpdir(), 'salesforce-oauth-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const store = createConnectionStore(db);
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, cleanup };
};

describe('D-130 P1.2 — completeVendorOAuth helper for Salesforce', () => {
  it('production flag (or omitted) POSTs to login.salesforce.com + surfaces instance_url', async () => {
    const provider = getVendorProvider('salesforce')!;
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'ACCESS-1',
          refresh_token: 'REFRESH-1',
          expires_in: 7200,
          scope: 'api refresh_token',
          instance_url: 'https://mycompany.my.salesforce.com',
        },
      },
    ]);

    const result = await completeVendorOAuth({
      provider,
      code: 'CODE-PROD',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      fetcher,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
    expect(result.refresh_token).toBe('REFRESH-1');
    expect(result.granted_scopes).toEqual(['api', 'refresh_token']);
    // D-130 P5 — instance_url surfaces through the helper so the
    // enrollment dialog can persist it onto config.base_url. CometD
    // long-poll + REST + SOQL all hit this per-org host.
    expect(result.instance_url).toBe('https://mycompany.my.salesforce.com');
  });

  it('sandbox=true POSTs to test.salesforce.com + surfaces sandbox instance_url', async () => {
    const provider = getVendorProvider('salesforce')!;
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'ACCESS-S',
          refresh_token: 'REFRESH-S',
          expires_in: 7200,
          scope: 'api refresh_token offline_access',
          instance_url: 'https://mycompany--sandbox.sandbox.my.salesforce.com',
        },
      },
    ]);

    const result = await completeVendorOAuth({
      provider,
      code: 'CODE-SANDBOX',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      sandbox: true,
      fetcher,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
    expect(result.refresh_token).toBe('REFRESH-S');
    expect(result.granted_scopes).toEqual(['api', 'refresh_token', 'offline_access']);
    expect(result.instance_url).toBe('https://mycompany--sandbox.sandbox.my.salesforce.com');
  });

  it('rejects a Salesforce response that omits its required instance_url', async () => {
    const provider = getVendorProvider('salesforce')!;
    const { fetcher } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'A',
          refresh_token: 'R',
          scope: 'api',
          // no instance_url — accepting this used to leave the form's
          // login.salesforce.com placeholder as the bearer destination.
        },
      },
    ]);

    await expect(completeVendorOAuth({
      provider,
      code: 'C',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      fetcher,
    })).rejects.toMatchObject({
      code: 'token_response_invalid',
      message: expect.stringContaining('missing required instance_url'),
    });
  });

  it.each([
    ['http://acme.my.salesforce.com', 'must use HTTPS'],
    ['https://attacker.example', 'outside the provider allowlist'],
    ['https://salesforce.com.attacker.example', 'outside the provider allowlist'],
    ['https://owner:secret@acme.my.salesforce.com', 'must not contain credentials'],
    ['https://acme.my.salesforce.com/services/data', 'must be an origin'],
    [false, 'must be a non-empty string'],
  ])('rejects unsafe Salesforce instance_url %s', async (instance_url, reason) => {
    const provider = getVendorProvider('salesforce')!;
    const { fetcher } = makeFetcher([{ status: 200, body: {
      access_token: 'A',
      refresh_token: 'R',
      scope: 'api',
      instance_url,
    } }]);
    await expect(completeVendorOAuth({
      provider,
      code: 'C',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      fetcher,
    })).rejects.toMatchObject({
      code: 'token_response_invalid',
      message: expect.stringContaining(reason),
    });
  });

  it('sandbox=false explicitly picks production', async () => {
    const provider = getVendorProvider('salesforce')!;
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'A',
          refresh_token: 'R',
          scope: 'api',
          instance_url: 'https://acme.my.salesforce.com',
        },
      },
    ]);

    await completeVendorOAuth({
      provider,
      code: 'C',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      sandbox: false,
      fetcher,
    });

    expect(calls[0].url).toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
  });

  it('Salesforce echoes scope (no introspection round-trip)', async () => {
    const provider = getVendorProvider('salesforce')!;
    // One scripted response — the helper would error with "fetcher
    // exhausted" if it tried a second call (introspection), so this
    // also verifies the no-introspection invariant.
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'A',
          refresh_token: 'R',
          scope: 'api refresh_token offline_access',
          instance_url: 'https://acme.my.salesforce.com',
        },
      },
    ]);

    const result = await completeVendorOAuth({
      provider,
      code: 'C',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID',
      client_secret: 'SEC',
      fetcher,
    });

    expect(calls).toHaveLength(1);
    expect(result.granted_scopes).toEqual(['api', 'refresh_token', 'offline_access']);
  });

  it('parseScopeString handles space-delimited Salesforce scope echoes', () => {
    expect(parseScopeString('api refresh_token offline_access')).toEqual([
      'api',
      'refresh_token',
      'offline_access',
    ]);
  });

  it('form-encoded body carries client_secret + redirect_uri + grant_type', async () => {
    const provider = getVendorProvider('salesforce')!;
    const { fetcher, calls } = makeFetcher([
      {
        status: 200,
        body: {
          access_token: 'A',
          refresh_token: 'R',
          scope: 'api',
          instance_url: 'https://acme.my.salesforce.com',
        },
      },
    ]);

    await completeVendorOAuth({
      provider,
      code: 'CODE-X',
      redirect_uri: 'https://app.recued.com/cb',
      client_id: 'CID-Y',
      client_secret: 'SECRET-Z',
      fetcher,
    });

    const body = calls[0].init?.body ?? '';
    expect(body).toContain('code=CODE-X');
    expect(body).toContain('client_id=CID-Y');
    expect(body).toContain('client_secret=SECRET-Z');
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('redirect_uri=');
    // redirect_uri is form-encoded — slash + colon become escaped.
    expect(body).toContain('redirect_uri=https%3A%2F%2Fapp.recued.com%2Fcb');
  });
});

describe('D-130 P1.2 — handleConnectionCompleteVendorOAuth rpc forwards sandbox flag', () => {
  it('forwards sandbox=true to the Salesforce sandbox token endpoint', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher([
        {
          status: 200,
          body: {
            access_token: 'A',
            refresh_token: 'R-SANDBOX',
            scope: 'api refresh_token',
            instance_url: 'https://acme--sandbox.sandbox.my.salesforce.com',
          },
        },
      ]);

      const result = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'salesforce',
          code: 'CODE',
          redirect_uri: 'https://app.recued.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
          sandbox: true,
        },
      );

      expect(calls[0].url).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
      expect(result.refresh_token).toBe('R-SANDBOX');
      expect(result.granted_scopes).toEqual(['api', 'refresh_token']);
    } finally {
      cleanup();
    }
  });

  it('rpc surfaces instance_url from the token response when present (D-130 P5)', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher } = makeFetcher([
        {
          status: 200,
          body: {
            access_token: 'A',
            refresh_token: 'R',
            scope: 'api refresh_token',
            instance_url: 'https://acme.my.salesforce.com',
          },
        },
      ]);

      const result = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'salesforce',
          code: 'CODE',
          redirect_uri: 'https://app.recued.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
        },
      );

      expect(result.instance_url).toBe('https://acme.my.salesforce.com');
    } finally {
      cleanup();
    }
  });

  it('forwards sandbox=false / omitted to the production token endpoint', async () => {
    const { store, cleanup } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher([
        {
          status: 200,
          body: {
            access_token: 'A',
            refresh_token: 'R-PROD',
            scope: 'api refresh_token',
            instance_url: 'https://acme.my.salesforce.com',
          },
        },
      ]);

      const result = await handleConnectionCompleteVendorOAuth(
        { store, fetcher },
        {
          vendor: 'salesforce',
          code: 'CODE',
          redirect_uri: 'https://app.recued.com/cb',
          client_id: 'CID',
          client_secret: 'SEC',
          // sandbox omitted
        },
      );

      expect(calls[0].url).toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
      expect(result.refresh_token).toBe('R-PROD');
    } finally {
      cleanup();
    }
  });

  it('rejects Salesforce calls without client_secret (client_secret_required)', async () => {
    const { store, cleanup } = makeStore();
    try {
      await expect(
        handleConnectionCompleteVendorOAuth(
          { store },
          {
            vendor: 'salesforce',
            code: 'C',
            redirect_uri: 'https://app.recued.com/cb',
            client_id: 'CID',
          },
        ),
      ).rejects.toThrow(/requires client_secret/);
    } finally {
      cleanup();
    }
  });
});
