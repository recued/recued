/** D-138 Phase 5 — vendor merge client wire-shape tests.
 *
 *  Locks the wire shape sent to HubSpot / Salesforce so future
 *  refactors can't silently change endpoints / headers / SOAP body. */

import { describe, expect, it, vi } from 'vitest';

import type { ConnectionRecord } from '@recued/contracts';

import { createHubSpotContactMergeClient } from '../data/hubspot/contact-merge-client.js';
import { createSalesforceMergeClient } from '../data/salesforce/merge-client.js';

const fakeConnection = (
  vendor: 'hubspot' | 'salesforce',
  base_url?: string,
): ConnectionRecord => ({
  kind: 'api',
  subtype: vendor,
  name: 'main',
  display_name: 'main',
  publisher_id: 'recued-core',
  config: { base_url: base_url ?? (vendor === 'salesforce' ? 'https://test.my.salesforce.com' : 'https://api.hubapi.com') },
  auth: {
    type: 'oauth2_refresh',
    refresh_token: 'ref_xyz',
    client_id: 'cid',
    token_endpoint: 'https://example.com/token',
    current_access_token: 'tok_xyz',
    expires_at: Date.now() + 3_600_000,
  },
  enrolled_at: Date.now(),
  updated_at: Date.now(),
  health: { status: 'ok', last_probed_at: Date.now() },
});

describe('D-138 P5 — HubSpot contact merge client', () => {
  it('POSTs to /crm/v3/objects/contacts/merge with primaryObjectId + Idempotency-Key header', async () => {
    let calledUrl = '';
    let calledHeaders: Headers | undefined;
    let calledBody = '';
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledHeaders = new Headers(init.headers as HeadersInit);
      calledBody = String(init.body);
      return new Response(JSON.stringify({ id: 'master_x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = createHubSpotContactMergeClient({
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const result = await client.merge(
      fakeConnection('hubspot'),
      { survivor_platform_id: 'master_id', loser_platform_id: 'victim_id' },
      'idem_key_123',
    );
    expect(result.ok).toBe(true);
    expect(calledUrl).toBe('https://api.hubapi.com/crm/v3/objects/contacts/merge');
    expect(calledHeaders?.get('Idempotency-Key')).toBe('idem_key_123');
    expect(calledHeaders?.get('Authorization')).toBe('Bearer tok_xyz');
    const parsed = JSON.parse(calledBody) as { primaryObjectId: string; objectIdToMerge: string };
    expect(parsed.primaryObjectId).toBe('master_id');
    expect(parsed.objectIdToMerge).toBe('victim_id');
  });

  it('authenticates a static `bearer` connection (a HubSpot Service Key) — no oauth needed', async () => {
    // The reconciler is auth-agnostic (`resolveBearerAccessToken`): a Service
    // Key enrolls as `{ type: 'bearer', token }` and rides the SAME
    // `Authorization: Bearer` path as an oauth2 access token — no
    // current_access_token / refresh machinery.
    let calledHeaders: Headers | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calledHeaders = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ id: 'master_x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const bearerConnection: ConnectionRecord = {
      ...fakeConnection('hubspot'),
      auth: { type: 'bearer', token: 'pat-na1-service-key-xyz' },
    };
    const client = createHubSpotContactMergeClient({
      fetcher,
      // A static key never refreshes — the seam returns the auth unchanged.
      refreshAuth: async (c) => c.auth,
    });
    const result = await client.merge(
      bearerConnection,
      { survivor_platform_id: 'm', loser_platform_id: 'v' },
      'k',
    );
    expect(result.ok).toBe(true);
    expect(calledHeaders?.get('Authorization')).toBe('Bearer pat-na1-service-key-xyz');
  });

  it('treats 5xx as retryable, 4xx (non-401/404/429) as terminal', async () => {
    const fetcher5xx = vi.fn(async () =>
      new Response('boom', { status: 503 }),
    ) as unknown as typeof fetch;
    const client5xx = createHubSpotContactMergeClient({
      fetcher: fetcher5xx,
      refreshAuth: async (c) => c.auth,
    });
    const r5 = await client5xx.merge(fakeConnection('hubspot'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(r5.ok).toBe(false);
    expect(r5.ok === false && r5.retryable).toBe(true);

    const fetcher400 = vi.fn(async () =>
      new Response('{}', { status: 400 }),
    ) as unknown as typeof fetch;
    const client400 = createHubSpotContactMergeClient({
      fetcher: fetcher400,
      refreshAuth: async (c) => c.auth,
    });
    const r4 = await client400.merge(fakeConnection('hubspot'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(r4.ok).toBe(false);
    expect(r4.ok === false && r4.retryable).toBe(false);
  });

  it('retries once on 401 via refreshAuth', async () => {
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt++;
      return attempt === 1
        ? new Response('', { status: 401 })
        : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const refreshAuth = vi.fn(async (c: ConnectionRecord) => ({
      ...c.auth,
      current_access_token: 'fresh_tok',
    }));
    const client = createHubSpotContactMergeClient({
      fetcher,
      refreshAuth: refreshAuth as unknown as (c: ConnectionRecord) => Promise<ConnectionRecord['auth']>,
    });
    const r = await client.merge(fakeConnection('hubspot'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(r.ok).toBe(true);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(attempt).toBe(2);
  });
});

describe('D-138 P5 — Salesforce merge client (Lead + Account)', () => {
  it('POSTs SOAP envelope to /services/Soap/c/v60.0 with merge() body for Lead', async () => {
    let calledUrl = '';
    let calledBody = '';
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledBody = String(init.body);
      return new Response(
        '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><mergeResponse><result><success>true</success><id>master_id</id></result></mergeResponse></soapenv:Body></soapenv:Envelope>',
        { status: 200, headers: { 'Content-Type': 'text/xml' } },
      );
    }) as unknown as typeof fetch;
    const client = createSalesforceMergeClient('salesforce:lead', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const r = await client.merge(
      fakeConnection('salesforce'),
      { survivor_platform_id: 'master_id', loser_platform_id: 'victim_id' },
      'idem_xyz',
    );
    expect(r.ok).toBe(true);
    expect(calledUrl).toBe('https://test.my.salesforce.com/services/Soap/c/v60.0');
    expect(calledBody).toContain('<urn:merge>');
    expect(calledBody).toContain('xsi:type="urn1:Lead"');
    expect(calledBody).toContain('master_id');
    expect(calledBody).toContain('<urn:recordToMergeIds>victim_id</urn:recordToMergeIds>');
    expect(calledBody).toContain('recued:idem_xyz');
  });

  it('authenticates a static `bearer` connection (session token in the SOAP header)', async () => {
    // Auth-agnostic (`resolveBearerAccessToken`): a static bearer session token
    // (+ config.base_url) drives the SOAP merge the same as an oauth2 access
    // token — no oauth2_refresh machinery.
    let calledBody = '';
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calledBody = String(init.body);
      return new Response(
        '<mergeResponse><result><success>true</success><id>m</id></result></mergeResponse>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const bearerConnection: ConnectionRecord = {
      ...fakeConnection('salesforce'),
      auth: { type: 'bearer', token: 'sf-bearer-session-key' },
    };
    const client = createSalesforceMergeClient('salesforce:lead', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const r = await client.merge(
      bearerConnection,
      { survivor_platform_id: 'm', loser_platform_id: 'v' },
      'k',
    );
    expect(r.ok).toBe(true);
    expect(calledBody).toContain('<urn:sessionId>sf-bearer-session-key</urn:sessionId>');
  });

  it('Account variant uses xsi:type="urn1:Account"', async () => {
    let calledBody = '';
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calledBody = String(init.body);
      return new Response(
        '<mergeResponse><result><success>true</success><id>m</id></result></mergeResponse>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = createSalesforceMergeClient('salesforce:account', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    await client.merge(fakeConnection('salesforce'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(calledBody).toContain('xsi:type="urn1:Account"');
  });

  it('SOAP success:false with terminal status code surfaces as terminal failure', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        '<mergeResponse><result><success>false</success><errors><statusCode>MALFORMED_ID</statusCode><message>bad</message></errors></result></mergeResponse>',
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = createSalesforceMergeClient('salesforce:lead', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const r = await client.merge(fakeConnection('salesforce'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.retryable).toBe(false);
    expect(r.ok === false && r.error.code).toBe('salesforce_merge_malformed_id');
  });

  it('SOAP non-terminal status code (e.g. UNABLE_TO_LOCK_ROW) is retryable', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        '<mergeResponse><result><success>false</success><errors><statusCode>UNABLE_TO_LOCK_ROW</statusCode><message>locked</message></errors></result></mergeResponse>',
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = createSalesforceMergeClient('salesforce:lead', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const r = await client.merge(fakeConnection('salesforce'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.retryable).toBe(true);
  });

  it('500 + Fault envelope is retryable', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>Session expired</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>',
        { status: 500 },
      ),
    ) as unknown as typeof fetch;
    const client = createSalesforceMergeClient('salesforce:account', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const r = await client.merge(fakeConnection('salesforce'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    }, 'k');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.retryable).toBe(true);
  });

  it('describe surfaces the vendor semantics summary even with empty field outcomes', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = createSalesforceMergeClient('salesforce:lead', {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });
    const preview = await client.describe(fakeConnection('salesforce'), {
      survivor_platform_id: 'm', loser_platform_id: 'v',
    });
    expect(preview.dispatchable).toBe(true);
    expect(preview.field_outcomes).toEqual([]);
    expect(preview.vendor_semantics_summary).toContain('Salesforce');
  });
});
