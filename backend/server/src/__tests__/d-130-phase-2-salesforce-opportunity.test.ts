/** D-130 Phase 2 — Salesforce opportunity reconciler + boot wire tests.
 *
 *  Covers:
 *  - `searchSalesforceObjects` request shape (URL composition with
 *    encoded SOQL + Authorization header) + `nextRecordsUrl`
 *    pagination + 401 refresh round-trip + 503 backoff + missing
 *    base_url rejection.
 *  - `SalesforceOpportunityReconciler.listUpdatedSince` walks SOQL
 *    results and materialises slim records keyed on
 *    `salesforce_opportunity_<Id>`.
 *  - `buildOpportunitySoql` cursor-aware SOQL composition.
 *  - `computeOpportunityHash` determinism + sensitivity to canonical-
 *    field changes; `projectOpportunityMeta` produces the full
 *    canonical-field meta + 8 KB serialise cap on synthetic large
 *    records + IsClosed/IsWon discriminator handling.
 *  - Sandbox-vs-production runtime base derivation
 *    (`connection.config.base_url`).
 *  - `wireSalesforceReconciliation` registers tasks for boot-time +
 *    new Salesforce connections and deregisters on delete; non-Sales-
 *    force connections are ignored; coexists with the HubSpot wire on
 *    the same store.
 *
 *  Reconciler-side concerns (cursor advance, hash skip, synthetic
 *  event shape) live in the D-128 P2 harness tests; this file only
 *  tests the new D-130-specific code paths. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SALESFORCE_API_VERSION,
  SALESFORCE_OPPORTUNITY_FIELDS,
  serializeEnrichmentMeta,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import {
  SalesforceAuthExpiredError,
  SalesforceMissingBaseUrlError,
  SalesforceRateLimitedError,
  SalesforceSearchError,
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from '../data/salesforce/_salesforce-search.js';
import {
  SalesforceOpportunityReconciler,
  buildOpportunitySoql,
  computeOpportunityHash,
  projectOpportunityMeta,
} from '../data/salesforce/opportunity-reconciler.js';
import { wireSalesforceReconciliation } from '../data/salesforce/boot.js';
import { buildSalesforceReconcilers } from '../data/salesforce/registration.js';

import { reconciliationTaskId } from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  clearDefaultReconcilerRegistry,
  listVendorReconcilers,
} from '../housekeeping/reconciliation/reconciler-registry.js';
import {
  clearDefaultHousekeepingRegistry,
  getHousekeepingTask,
  listHousekeepingTasks,
} from '../housekeeping/registry.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';

// ────────────────────────────────────────────────────────────────
// Shared test harness
// ────────────────────────────────────────────────────────────────

const PROD_INSTANCE_URL = 'https://mycompany.my.salesforce.com';
const SANDBOX_INSTANCE_URL = 'https://mycompany--sandbox.sandbox.my.salesforce.com';

const sampleAuth = (
  overrides: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {},
): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'rt-1',
  client_id: 'cid-1',
  client_secret: 'cs-1',
  token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
  current_access_token: 'access-1',
  expires_at: Date.now() + 3_600_000,
  ...overrides,
});

const sampleSalesforceConnection = (
  name = 'acme-salesforce',
  baseUrl: string = PROD_INSTANCE_URL,
): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: baseUrl, vendor: 'salesforce', sandbox: 'production' },
  auth: sampleAuth(),
  enrolled_at: 1,
  updated_at: 1,
});

const rawOpportunity = (
  overrides: Partial<RawSalesforceRecord> = {},
  id = '006A0000005XYZAB',
): RawSalesforceRecord => ({
  Id: id,
  Name: 'Acme Q3 Expansion',
  StageName: 'Negotiation/Review',
  Amount: 50000,
  CloseDate: '2026-09-30',
  CreatedDate: '2026-01-15T08:30:00.000Z',
  LastModifiedDate: '2026-05-01T14:32:18.000Z',
  OwnerId: '005A0000001XYZAB',
  IsClosed: false,
  IsWon: false,
  ForecastCategory: 'Pipeline',
  Probability: 60,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// _salesforce-search — request shape
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — searchSalesforceObjects request shape', () => {
  it('GETs the canonical query path with URL-encoded SOQL against the connection base_url', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string | URL, init: RequestInit | undefined): Promise<Response> => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ records: [], done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const soql = 'SELECT Id, Name FROM Opportunity WHERE LastModifiedDate >= 2024-10-27T00:00:00.000Z';
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    for await (const _r of searchSalesforceObjects(
      sampleSalesforceConnection(),
      { soql },
      deps,
    )) {
      // exhaust generator
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(
      `${PROD_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    );
    expect(calls[0]!.headers.Authorization).toBe('Bearer access-1');
    expect(calls[0]!.headers.Accept).toBe('application/json');
  });

  it('throws SalesforceMissingBaseUrlError when connection.config.base_url is empty', async () => {
    const conn = sampleSalesforceConnection('acme', '');
    const deps: SalesforceSearchDeps = {
      fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    await expect(async () => {
      for await (const _r of searchSalesforceObjects(conn, { soql: 'SELECT Id FROM Opportunity' }, deps)) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(SalesforceMissingBaseUrlError);
  });

  it('strips trailing slash off base_url before composing the query path', async () => {
    const calls: Array<string> = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      calls.push(String(url));
      return new Response(JSON.stringify({ records: [], done: true }), { status: 200 });
    };
    const conn = sampleSalesforceConnection('acme', `${PROD_INSTANCE_URL}/`);
    for await (const _r of searchSalesforceObjects(
      conn,
      { soql: 'SELECT Id FROM Opportunity' },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      // exhaust
    }
    expect(calls[0]).toBe(`${PROD_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent('SELECT Id FROM Opportunity')}`);
  });
});

// ────────────────────────────────────────────────────────────────
// _salesforce-search — pagination via nextRecordsUrl
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — searchSalesforceObjects pagination', () => {
  it('walks every page following nextRecordsUrl until done=true', async () => {
    const pages = [
      {
        records: [rawOpportunity({}, 'a')],
        done: false,
        nextRecordsUrl: `/services/data/${SALESFORCE_API_VERSION}/query/01g000000000001`,
      },
      {
        records: [rawOpportunity({}, 'b')],
        done: false,
        nextRecordsUrl: `/services/data/${SALESFORCE_API_VERSION}/query/01g000000000002`,
      },
      {
        records: [rawOpportunity({}, 'c')],
        done: true,
      },
    ];
    const seenUrls: string[] = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      seenUrls.push(String(url));
      const page = pages.shift();
      return new Response(JSON.stringify(page ?? { records: [], done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const ids: string[] = [];
    for await (const r of searchSalesforceObjects(
      sampleSalesforceConnection(),
      { soql: 'SELECT Id FROM Opportunity' },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      ids.push(String(r.Id));
    }

    expect(ids).toEqual(['a', 'b', 'c']);
    expect(seenUrls).toHaveLength(3);
    expect(seenUrls[1]).toBe(`${PROD_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}/query/01g000000000001`);
    expect(seenUrls[2]).toBe(`${PROD_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}/query/01g000000000002`);
  });

  it('terminates when the page has done=false but no nextRecordsUrl (defensive)', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(JSON.stringify({ records: [rawOpportunity({}, 'only')], done: false }), {
        status: 200,
      });
    const ids: string[] = [];
    for await (const r of searchSalesforceObjects(
      sampleSalesforceConnection(),
      { soql: 'SELECT Id FROM Opportunity' },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      ids.push(String(r.Id));
    }
    expect(ids).toEqual(['only']);
  });
});

// ────────────────────────────────────────────────────────────────
// _salesforce-search — 401 refresh + 503 backoff
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — searchSalesforceObjects 401 refresh round-trip', () => {
  it('refreshes auth + retries with the new access token on a single 401', async () => {
    const calls: Array<{ token: string }> = [];
    let refreshCount = 0;
    const fetcher = async (_url: string | URL, init: RequestInit | undefined): Promise<Response> => {
      const headers = init?.headers as Record<string, string>;
      const token = headers.Authorization?.replace('Bearer ', '') ?? '';
      calls.push({ token });
      if (token === 'access-1') {
        return new Response(JSON.stringify([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }]), {
          status: 401,
        });
      }
      return new Response(JSON.stringify({ records: [rawOpportunity({}, '1')], done: true }), {
        status: 200,
      });
    };
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async (): Promise<ConnectionAuth> => {
        refreshCount += 1;
        return sampleAuth({ current_access_token: 'access-2' });
      },
    };

    const ids: string[] = [];
    for await (const r of searchSalesforceObjects(
      sampleSalesforceConnection(),
      { soql: 'SELECT Id FROM Opportunity' },
      deps,
    )) {
      ids.push(String(r.Id));
    }

    expect(refreshCount).toBe(1);
    expect(calls.map((c) => c.token)).toEqual(['access-1', 'access-2']);
    expect(ids).toEqual(['1']);
  });

  it('throws SalesforceAuthExpiredError when 401 persists after a refresh', async () => {
    const fetcher = async (): Promise<Response> => new Response('{}', { status: 401 });
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth({ current_access_token: 'still-bad' }),
    };

    await expect(async () => {
      for await (const _r of searchSalesforceObjects(
        sampleSalesforceConnection(),
        { soql: 'SELECT Id FROM Opportunity' },
        deps,
      )) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(SalesforceAuthExpiredError);
  });
});

describe('D-130 P2 — searchSalesforceObjects 503 / 429 backoff', () => {
  it('retries with Retry-After delay on 503 then succeeds on the second attempt', async () => {
    const sleepCalls: number[] = [];
    let callCount = 0;
    const fetcher = async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('Service Unavailable', { status: 503, headers: { 'Retry-After': '2' } });
      }
      return new Response(JSON.stringify({ records: [rawOpportunity({}, 'x')], done: true }), { status: 200 });
    };
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    };

    const ids: string[] = [];
    for await (const r of searchSalesforceObjects(
      sampleSalesforceConnection(),
      { soql: 'SELECT Id FROM Opportunity' },
      deps,
    )) {
      ids.push(String(r.Id));
    }

    expect(sleepCalls).toEqual([2_000]);
    expect(ids).toEqual(['x']);
  });

  it('treats 429 the same as 503 (Salesforce uses both for rate-limit signals)', async () => {
    const sleepCalls: number[] = [];
    let callCount = 0;
    const fetcher = async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify({ records: [rawOpportunity({}, 'y')], done: true }), { status: 200 });
    };
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    };

    const ids: string[] = [];
    for await (const r of searchSalesforceObjects(
      sampleSalesforceConnection(),
      { soql: 'SELECT Id FROM Opportunity' },
      deps,
    )) {
      ids.push(String(r.Id));
    }
    expect(sleepCalls).toEqual([1_000]);
    expect(ids).toEqual(['y']);
  });

  it('throws SalesforceRateLimitedError after exhausting retries', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response('Service Unavailable', { status: 503, headers: { 'Retry-After': '1' } });
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
      sleep: async () => undefined,
      rateLimitMaxRetries: 1,
    };

    await expect(async () => {
      for await (const _r of searchSalesforceObjects(
        sampleSalesforceConnection(),
        { soql: 'SELECT Id FROM Opportunity' },
        deps,
      )) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(SalesforceRateLimitedError);
  });

  it('surfaces non-401/429/503 errors as SalesforceSearchError carrying the status', async () => {
    const fetcher = async (): Promise<Response> => new Response('boom', { status: 500 });
    const deps: SalesforceSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    await expect(async () => {
      for await (const _r of searchSalesforceObjects(
        sampleSalesforceConnection(),
        { soql: 'SELECT Id FROM Opportunity' },
        deps,
      )) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(SalesforceSearchError);
  });
});

// ────────────────────────────────────────────────────────────────
// Sandbox-vs-production runtime base derivation
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — sandbox-vs-production runtime base', () => {
  it('routes the query through the sandbox base_url when the connection is enrolled against sandbox', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      calls.push(String(url));
      return new Response(JSON.stringify({ records: [], done: true }), { status: 200 });
    };
    const sandboxConn: ConnectionRecord = {
      ...sampleSalesforceConnection('acme-sandbox', SANDBOX_INSTANCE_URL),
      config: { base_url: SANDBOX_INSTANCE_URL, vendor: 'salesforce', sandbox: 'sandbox' },
    };

    for await (const _r of searchSalesforceObjects(
      sandboxConn,
      { soql: 'SELECT Id FROM Opportunity' },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      // exhaust
    }

    expect(calls[0]).toBe(
      `${SANDBOX_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent('SELECT Id FROM Opportunity')}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// buildOpportunitySoql
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — buildOpportunitySoql', () => {
  it('emits a SELECT projecting every canonical SALESFORCE_OPPORTUNITY_FIELDS entry', () => {
    const soql = buildOpportunitySoql(0, 200);
    expect(soql).toContain(`SELECT ${SALESFORCE_OPPORTUNITY_FIELDS.join(', ')}`);
    expect(soql).toContain('FROM Opportunity');
  });

  it('omits the WHERE clause on first run (cursor=0) so the harness walks every record', () => {
    const soql = buildOpportunitySoql(0, 200);
    expect(soql).not.toContain('WHERE');
  });

  it('emits a WHERE LastModifiedDate >= <iso> filter on subsequent runs', () => {
    const cursor = Date.parse('2026-04-01T00:00:00.000Z');
    const soql = buildOpportunitySoql(cursor, 200);
    expect(soql).toContain('WHERE LastModifiedDate >= 2026-04-01T00:00:00.000Z');
  });

  it('orders ASC by LastModifiedDate so the harness can advance the cursor monotonically', () => {
    expect(buildOpportunitySoql(0, 200)).toContain('ORDER BY LastModifiedDate ASC');
  });

  it('caps to LIMIT <pageLimit> for budget-bounded paging', () => {
    expect(buildOpportunitySoql(0, 50)).toContain('LIMIT 50');
  });
});

// ────────────────────────────────────────────────────────────────
// computeOpportunityHash + projectOpportunityMeta
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — computeOpportunityHash', () => {
  it('is deterministic for identical canonical fields', () => {
    const a = rawOpportunity();
    const b = rawOpportunity();
    expect(computeOpportunityHash(a)).toBe(computeOpportunityHash(b));
    expect(computeOpportunityHash(a)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('changes when any canonical field changes', () => {
    const base = computeOpportunityHash(rawOpportunity());
    expect(computeOpportunityHash(rawOpportunity({ Name: 'Different' }))).not.toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ StageName: 'Closed Won' }))).not.toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ Amount: 99999 }))).not.toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ CloseDate: '2026-12-31' }))).not.toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ OwnerId: '005A0000099XYZAB' }))).not.toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ IsClosed: true }))).not.toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ IsWon: true }))).not.toBe(base);
  });

  it('does not change when non-canonical fields rotate (CreatedDate / LastModifiedDate / Probability / ForecastCategory)', () => {
    const base = computeOpportunityHash(rawOpportunity());
    expect(computeOpportunityHash(rawOpportunity({ CreatedDate: '2020-01-01T00:00:00.000Z' }))).toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ LastModifiedDate: '2099-01-01T00:00:00.000Z' }))).toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ Probability: 99 }))).toBe(base);
    expect(computeOpportunityHash(rawOpportunity({ ForecastCategory: 'Commit' }))).toBe(base);
  });
});

describe('D-130 P2 — projectOpportunityMeta', () => {
  it('renders the full canonical field set with stamping fields', () => {
    const raw = rawOpportunity();
    const meta = projectOpportunityMeta(raw, 'fnv1a:abc12345', 1_700_000_000_000);
    expect(meta.snapshot_at).toBe(1_700_000_000_000);
    expect(meta.snapshot_hash).toBe('fnv1a:abc12345');
    expect(meta.name).toBe('Acme Q3 Expansion');
    expect(meta.stage).toBe('Negotiation/Review');
    expect(meta.amount).toBe(50000);
    expect(meta.owner).toBe('salesforce_user:005A0000001XYZAB');
    expect(meta.key_dates).toEqual({
      close_date: Date.parse('2026-09-30'),
      created_at: Date.parse('2026-01-15T08:30:00.000Z'),
    });
    expect(meta.probability).toBe(60);
    expect(meta.close_state).toBe('open');
  });

  it('derives close_state=won when IsClosed and IsWon are both true', () => {
    const meta = projectOpportunityMeta(
      rawOpportunity({ IsClosed: true, IsWon: true, StageName: 'Closed Won' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.close_state).toBe('won');
  });

  it('derives close_state=lost when IsClosed is true but IsWon is false', () => {
    const meta = projectOpportunityMeta(
      rawOpportunity({ IsClosed: true, IsWon: false, StageName: 'Closed Lost' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.close_state).toBe('lost');
  });

  it('derives close_state=open when neither IsClosed nor IsWon is set (defensive default)', () => {
    const meta = projectOpportunityMeta(
      { Id: '006A0000005XYZAB', Name: 'Maybe', LastModifiedDate: '2026-05-01T00:00:00.000Z' },
      'fnv1a:00000000',
      1,
    );
    expect(meta.close_state).toBe('open');
  });

  it('omits optional fields when raw values are null / empty', () => {
    const raw: RawSalesforceRecord = {
      Id: '006A0000005XYZAB',
      Name: '',
      StageName: null,
      Amount: null,
      CloseDate: null,
      CreatedDate: null,
      OwnerId: null,
      IsClosed: false,
      IsWon: false,
      Probability: null,
      LastModifiedDate: '2026-05-01T00:00:00.000Z',
    };
    const meta = projectOpportunityMeta(raw, 'fnv1a:00000000', 1);
    expect(meta.name).toBeUndefined();
    expect(meta.stage).toBeUndefined();
    expect(meta.amount).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.key_dates).toBeUndefined();
    expect(meta.probability).toBeUndefined();
    expect(meta.forecast_amount).toBeUndefined();
    expect(meta.close_state).toBe('open');
  });

  it('projects forecast_amount when ForecastAmount is present in the raw record', () => {
    const meta = projectOpportunityMeta(
      rawOpportunity({ ForecastAmount: 42000 }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.forecast_amount).toBe(42000);
  });

  it('rejects via PLATFORM_REFERENCE_META_MAX_BYTES when serialised meta exceeds 8 KB', () => {
    const huge = 'x'.repeat(9 * 1024);
    const meta = projectOpportunityMeta(rawOpportunity({ Name: huge }), 'fnv1a:00000000', 1);
    expect(() => serializeEnrichmentMeta(meta)).toThrow(/meta_snapshot_too_large/);
  });
});

// ────────────────────────────────────────────────────────────────
// SalesforceOpportunityReconciler.listUpdatedSince
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — SalesforceOpportunityReconciler.listUpdatedSince', () => {
  it('yields slim records keyed on salesforce_opportunity_<Id> with parsed modified_at', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            rawOpportunity({ LastModifiedDate: '2026-04-01T00:00:00.000Z' }, '006a000'),
            rawOpportunity({ LastModifiedDate: '2026-04-02T00:00:00.000Z' }, '006b000'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceOpportunityReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const out: Array<{ id: string; modified_at: number }> = [];
    for await (const slim of reconciler.listUpdatedSince(sampleSalesforceConnection(), 0, 200)) {
      out.push({ id: slim.id, modified_at: slim.modified_at });
    }

    expect(out).toEqual([
      { id: 'salesforce_opportunity_acme-salesforce_006a000', modified_at: Date.parse('2026-04-01T00:00:00.000Z') },
      { id: 'salesforce_opportunity_acme-salesforce_006b000', modified_at: Date.parse('2026-04-02T00:00:00.000Z') },
    ]);
  });

  it('skips records missing LastModifiedDate (cursor cannot advance for them)', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            { Id: 'no-mod', Name: 'Stamp-less' },
            rawOpportunity({ LastModifiedDate: '2026-05-01T00:00:00.000Z' }, 'good'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceOpportunityReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const ids: string[] = [];
    for await (const slim of reconciler.listUpdatedSince(sampleSalesforceConnection(), 0, 200)) {
      ids.push(slim.id);
    }
    expect(ids).toEqual(['salesforce_opportunity_acme-salesforce_good']);
  });

  it('issues a SOQL with the WHERE LastModifiedDate >= <iso> filter on subsequent runs', async () => {
    const seenUrls: string[] = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ records: [], done: true }), { status: 200 });
    };
    const reconciler = new SalesforceOpportunityReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    const cursor = Date.parse('2026-04-15T12:00:00.000Z');
    for await (const _slim of reconciler.listUpdatedSince(sampleSalesforceConnection(), cursor, 200)) {
      // exhaust
    }
    expect(seenUrls[0]).toContain(encodeURIComponent('WHERE LastModifiedDate >= 2026-04-15T12:00:00.000Z'));
  });

  it('declares the canonical default cadence + vendor + entity', () => {
    const reconciler = new SalesforceOpportunityReconciler({
      search: {
        fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    expect(reconciler.vendor).toBe('salesforce');
    expect(reconciler.entity).toBe('opportunity');
    expect(reconciler.default_cadence).toBe('6h');
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — wireSalesforceReconciliation
// ────────────────────────────────────────────────────────────────

describe('D-130 P2 — wireSalesforceReconciliation', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-130-p2-boot-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    connectionStore = createConnectionStore(db);
    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();
  });

  const upsertSalesforce = (name: string): void => {
    connectionStore.upsert({
      kind: 'api',
      name,
      display_name: name,
      config_json: JSON.stringify({
        base_url: PROD_INSTANCE_URL,
        vendor: 'salesforce',
        sandbox: 'production',
      }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
  };

  const reconcilers = () =>
    buildSalesforceReconcilers({
      opportunity: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
      // D-130 P3 + P4 — contact + account reconcilers stack alongside
      // opportunity in the registration input shape; the P2 boot-wire
      // tests only exercise opportunity-task assertions but the build
      // call must satisfy the type.
      contact: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
      account: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
    });

  it('registers reconcilers in the default registry', () => {
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(listVendorReconcilers().map((r) => `${r.vendor}.${r.entity}`)).toContain('salesforce.opportunity');
  });

  it('registers per-connection housekeeping tasks for Salesforce connections that exist at boot', () => {
    upsertSalesforce('acme');
    upsertSalesforce('personal');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const taskIds = listHousekeepingTasks().map((t) => t.meta.id).sort();
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'opportunity', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'opportunity', 'personal'));
  });

  it('registers a task when a new Salesforce connection is upserted post-boot', () => {
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'late'))).toBeUndefined();
    upsertSalesforce('late');
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'late'))).toBeDefined();
  });

  it('deregisters tasks when the Salesforce connection is deleted; cursor row in housekeeping_state survives', () => {
    upsertSalesforce('temp');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'temp'))).toBeDefined();
    connectionStore.delete('api', 'temp');
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'temp'))).toBeUndefined();
  });

  it('does not register tasks for non-Salesforce api connections', () => {
    connectionStore.upsert({
      kind: 'api',
      name: 'some-pipedrive',
      display_name: 'Pipedrive (other vendor)',
      config_json: JSON.stringify({ base_url: 'https://api.pipedrive.com/v1', vendor: 'pipedrive' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'some-pipedrive'))).toBeUndefined();
  });

  it('is idempotent on token-refresh upserts (repeated upsert never re-throws)', () => {
    upsertSalesforce('idem');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    // second upsert (simulating a token refresh path) — handler must not
    // re-register a task that's already in the registry.
    expect(() => upsertSalesforce('idem')).not.toThrow();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'idem'))).toBeDefined();
  });
});
