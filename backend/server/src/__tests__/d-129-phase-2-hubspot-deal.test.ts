/** D-129 Phase 2 — HubSpot deal reconciler + boot wire tests.
 *
 *  Covers:
 *  - `searchHubSpotObjects` request shape (filter + properties +
 *    pagination cursor) + 401 refresh round-trip + 429 retry backoff.
 *  - `HubSpotDealReconciler.listUpdatedSince` walks search results and
 *    materialises slim records.
 *  - `computeDealHash` determinism + sensitivity to canonical-field
 *    changes.
 *  - `projectDealMeta` produces the full canonical-field meta + 8 KB
 *    serialise cap on synthetic large records.
 *  - `wireHubSpotReconciliation` registers tasks for boot-time + new
 *    HubSpot connections and deregisters on delete; non-HubSpot
 *    connections are ignored.
 *
 *  Reconciler-side concerns (cursor advance, hash skip, synthetic
 *  event shape) live in the D-128 P2 harness tests; this file only
 *  tests the new D-129-specific code paths. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HUBSPOT_DEAL_PROPERTIES,
  serializeEnrichmentMeta,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import {
  HubSpotAuthExpiredError,
  HubSpotRateLimitedError,
  HubSpotSearchError,
  searchHubSpotObjects,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from '../data/hubspot/_hubspot-search.js';
import {
  HubSpotDealReconciler,
  computeDealHash,
  projectDealMeta,
} from '../data/hubspot/deal-reconciler.js';
import { wireHubSpotReconciliation } from '../data/hubspot/boot.js';
import { buildHubSpotReconcilers } from '../data/hubspot/registration.js';

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

const sampleAuth = (overrides: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {}): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'rt-1',
  client_id: 'cid-1',
  client_secret: 'cs-1',
  token_endpoint: 'https://api.hubapi.com/oauth/v1/token',
  current_access_token: 'access-1',
  expires_at: Date.now() + 3_600_000,
  ...overrides,
});

const sampleHubSpotConnection = (name = 'acme-hubspot'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://api.hubapi.com', vendor: 'hubspot' },
  auth: sampleAuth(),
  enrolled_at: 1,
  updated_at: 1,
});

const rawDeal = (overrides: Partial<RawHubSpotRecord['properties']> = {}, id = '1234'): RawHubSpotRecord => ({
  id,
  properties: {
    dealname: 'Acme Q3 Expansion',
    dealstage: 'negotiation',
    amount: '50000',
    closedate: '1730294400000',
    createdate: '1700000000000',
    hs_lastmodifieddate: '1730294400000',
    hubspot_owner_id: '777',
    pipeline: 'default',
    hs_forecast_amount: '40000',
    notes_next_activity_date: '1731000000000',
    notes_last_contacted: '1729000000000',
    description: 'Expansion into the EU region with a multi-year commit.',
    hs_next_step: 'Send the redlined MSA to legal.',
    hs_priority: 'high',
    hs_is_closed: 'false',
    hs_is_closed_won: 'false',
    hs_is_closed_lost: 'false',
    ...overrides,
  },
});

// ────────────────────────────────────────────────────────────────
// _hubspot-search — request shape
// ────────────────────────────────────────────────────────────────

describe('D-129 P2 — searchHubSpotObjects request shape', () => {
  it('POSTs the canonical properties + hs_lastmodifieddate filter against the search endpoint', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fetcher = async (url: string | URL, init: RequestInit | undefined): Promise<Response> => {
      calls.push({
        url: String(url),
        body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ results: [], paging: undefined }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    for await (const _r of searchHubSpotObjects(
      sampleHubSpotConnection(),
      {
        objectType: 'deals',
        properties: HUBSPOT_DEAL_PROPERTIES,
        modifiedSince: 1_700_000_000_000,
        limit: 100,
      },
      deps,
    )) {
      // exhaust generator
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.hubapi.com/crm/v3/objects/deals/search');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.properties).toEqual([...HUBSPOT_DEAL_PROPERTIES]);
    expect(body.limit).toBe(100);
    expect(body.sorts).toEqual([{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }]);
    expect(body.filterGroups).toEqual([
      {
        filters: [
          {
            propertyName: 'hs_lastmodifieddate',
            operator: 'GTE',
            value: '1700000000000',
          },
        ],
      },
    ]);
    expect(calls[0]!.headers.Authorization).toBe('Bearer access-1');
  });

  it('omits the filterGroups on first run (modifiedSince=0)', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetcher = async (_url: string | URL, init: RequestInit | undefined) => {
      calls.push({ body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    for await (const _r of searchHubSpotObjects(
      sampleHubSpotConnection(),
      { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 50 },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      // exhaust
    }

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.filterGroups).toBeUndefined();
  });

  it('caps page limit at 100 even when caller asks for more', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetcher = async (_url: string | URL, init: RequestInit | undefined) => {
      calls.push({ body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    for await (const _r of searchHubSpotObjects(
      sampleHubSpotConnection(),
      { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 500 },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      // exhaust
    }

    expect((calls[0]!.body as { limit: number }).limit).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────
// _hubspot-search — pagination + 401 + 429
// ────────────────────────────────────────────────────────────────

describe('D-129 P2 — searchHubSpotObjects pagination', () => {
  it('walks every page until paging.next.after is absent', async () => {
    const pages = [
      {
        results: [rawDeal({}, 'a')],
        paging: { next: { after: 'cursor-1' } },
      },
      {
        results: [rawDeal({}, 'b')],
        paging: { next: { after: 'cursor-2' } },
      },
      {
        results: [rawDeal({}, 'c')],
        // no paging → terminate
      },
    ];
    const seenCursors: Array<string | undefined> = [];
    const fetcher = async (_url: string | URL, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { after?: string };
      seenCursors.push(body.after);
      const page = pages.shift();
      return new Response(JSON.stringify(page ?? { results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const ids: string[] = [];
    for await (const r of searchHubSpotObjects(
      sampleHubSpotConnection(),
      { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 100 },
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    )) {
      ids.push(r.id);
    }

    expect(ids).toEqual(['a', 'b', 'c']);
    expect(seenCursors).toEqual([undefined, 'cursor-1', 'cursor-2']);
  });
});

describe('D-129 P2 — searchHubSpotObjects 401 refresh round-trip', () => {
  it('refreshes auth + retries with the new access token on a single 401', async () => {
    const calls: Array<{ token: string }> = [];
    let refreshCount = 0;
    const fetcher = async (_url: string | URL, init: RequestInit | undefined) => {
      const headers = init?.headers as Record<string, string>;
      const token = headers.Authorization?.replace('Bearer ', '') ?? '';
      calls.push({ token });
      if (token === 'access-1') {
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify({ results: [rawDeal({}, '1')] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async (): Promise<ConnectionAuth> => {
        refreshCount += 1;
        return sampleAuth({ current_access_token: 'access-2' });
      },
    };

    const ids: string[] = [];
    for await (const r of searchHubSpotObjects(
      sampleHubSpotConnection(),
      { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 100 },
      deps,
    )) {
      ids.push(r.id);
    }

    expect(refreshCount).toBe(1);
    expect(calls.map((c) => c.token)).toEqual(['access-1', 'access-2']);
    expect(ids).toEqual(['1']);
  });

  it('throws HubSpotAuthExpiredError when 401 persists after a refresh', async () => {
    const fetcher = async () => new Response('{}', { status: 401 });
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth({ current_access_token: 'still-bad' }),
    };

    await expect(async () => {
      for await (const _r of searchHubSpotObjects(
        sampleHubSpotConnection(),
        { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 100 },
        deps,
      )) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(HubSpotAuthExpiredError);
  });
});

describe('D-129 P2 — searchHubSpotObjects 429 backoff', () => {
  it('retries with Retry-After delay then succeeds on the second attempt', async () => {
    const sleepCalls: number[] = [];
    let callCount = 0;
    const fetcher = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
      }
      return new Response(JSON.stringify({ results: [rawDeal({}, 'x')] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    };

    const ids: string[] = [];
    for await (const r of searchHubSpotObjects(
      sampleHubSpotConnection(),
      { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 100 },
      deps,
    )) {
      ids.push(r.id);
    }

    expect(sleepCalls).toEqual([2_000]);
    expect(ids).toEqual(['x']);
  });

  it('throws HubSpotRateLimitedError after exhausting retries', async () => {
    const fetcher = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
      sleep: async () => undefined,
      rateLimitMaxRetries: 1,
    };

    await expect(async () => {
      for await (const _r of searchHubSpotObjects(
        sampleHubSpotConnection(),
        { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 100 },
        deps,
      )) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(HubSpotRateLimitedError);
  });

  it('surfaces non-401/429 errors as HubSpotSearchError carrying the status', async () => {
    const fetcher = async () => new Response('boom', { status: 500 });
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    await expect(async () => {
      for await (const _r of searchHubSpotObjects(
        sampleHubSpotConnection(),
        { objectType: 'deals', properties: ['dealname'], modifiedSince: 0, limit: 100 },
        deps,
      )) {
        // exhaust
      }
    }).rejects.toBeInstanceOf(HubSpotSearchError);
  });
});

// ────────────────────────────────────────────────────────────────
// computeDealHash + projectDealMeta
// ────────────────────────────────────────────────────────────────

describe('D-129 P2 — computeDealHash', () => {
  it('is deterministic for identical canonical fields', () => {
    const a = rawDeal();
    const b = rawDeal();
    expect(computeDealHash(a)).toBe(computeDealHash(b));
    expect(computeDealHash(a)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('changes when any canonical field changes', () => {
    const base = computeDealHash(rawDeal());
    expect(computeDealHash(rawDeal({ dealname: 'Different' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ dealstage: 'closed_won' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ amount: '99999' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ closedate: '1' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ hubspot_owner_id: '999' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ pipeline: 'enterprise' }))).not.toBe(base);
    // D5 deal-fold — rep-authored semantic fields participate in the hash.
    expect(computeDealHash(rawDeal({ description: 'Rewritten scope.' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ hs_next_step: 'Book the kickoff call.' }))).not.toBe(base);
    expect(computeDealHash(rawDeal({ hs_priority: 'low' }))).not.toBe(base);
  });

  it('does not change when non-canonical fields rotate (createdate / hs_lastmodifieddate / activity timestamps alone)', () => {
    const base = computeDealHash(rawDeal());
    expect(computeDealHash(rawDeal({ createdate: '1' }))).toBe(base);
    expect(computeDealHash(rawDeal({ hs_lastmodifieddate: '999999' }))).toBe(base);
    // D5 deal-fold — activity timestamps are projected but excluded from
    // the hash (a logged-touch bump must not force a cascade).
    expect(computeDealHash(rawDeal({ notes_next_activity_date: '1' }))).toBe(base);
    expect(computeDealHash(rawDeal({ notes_last_contacted: '1' }))).toBe(base);
  });
});

describe('D-129 P2 — projectDealMeta', () => {
  it('renders the full canonical field set with stamping fields', () => {
    const raw = rawDeal();
    const meta = projectDealMeta(raw, 'fnv1a:abc12345', 1_700_000_000_000);
    expect(meta.snapshot_at).toBe(1_700_000_000_000);
    expect(meta.snapshot_hash).toBe('fnv1a:abc12345');
    expect(meta.name).toBe('Acme Q3 Expansion');
    expect(meta.stage).toBe('negotiation');
    expect(meta.amount).toBe(50000);
    expect(meta.owner).toBe('hubspot_owner_id:777');
    expect(meta.pipeline).toBe('default');
    expect(meta.key_dates).toEqual({
      close_date: 1730294400000,
      created_at: 1700000000000,
      next_activity_at: 1731000000000,
      last_activity_at: 1729000000000,
    });
    expect(meta.forecast_amount).toBe(40000);
    // D5 deal-fold — rep-authored free-text fields project top-level.
    expect(meta.description).toBe('Expansion into the EU region with a multi-year commit.');
    expect(meta.next_step).toBe('Send the redlined MSA to legal.');
    expect(meta.priority).toBe('high');
    expect(meta.close_state).toBe('open');
  });

  it('derives close_state=won when hs_is_closed_won is truthy', () => {
    const meta = projectDealMeta(
      rawDeal({ hs_is_closed: 'true', hs_is_closed_won: 'true' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.close_state).toBe('won');
  });

  it('derives close_state=lost when hs_is_closed_lost is truthy', () => {
    const meta = projectDealMeta(
      rawDeal({ hs_is_closed: 'true', hs_is_closed_lost: 'true' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.close_state).toBe('lost');
  });

  it('omits optional fields when raw values are null / empty', () => {
    const raw = rawDeal({
      dealname: null,
      dealstage: null,
      amount: null,
      closedate: null,
      createdate: null,
      hubspot_owner_id: null,
      pipeline: null,
      hs_forecast_amount: null,
      notes_next_activity_date: null,
      notes_last_contacted: null,
      description: null,
      hs_next_step: null,
      hs_priority: null,
    });
    const meta = projectDealMeta(raw, 'fnv1a:00000000', 1);
    expect(meta.name).toBeUndefined();
    expect(meta.stage).toBeUndefined();
    expect(meta.amount).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.pipeline).toBeUndefined();
    expect(meta.key_dates).toBeUndefined();
    expect(meta.forecast_amount).toBeUndefined();
    // D5 deal-fold — the five new fields drop out too when raw is empty.
    expect(meta.description).toBeUndefined();
    expect(meta.next_step).toBeUndefined();
    expect(meta.priority).toBeUndefined();
    expect(meta.close_state).toBe('open');
  });

  it('rejects via PLATFORM_REFERENCE_META_MAX_BYTES when serialised meta exceeds 8 KB', () => {
    const huge = 'x'.repeat(9 * 1024);
    const meta = projectDealMeta(rawDeal({ dealname: huge }), 'fnv1a:00000000', 1);
    expect(() => serializeEnrichmentMeta(meta)).toThrow(/meta_snapshot_too_large/);
  });

  it('clamps a verbose description to 1024 chars (+ ellipsis) so the snapshot stays under the 8 KB cap', () => {
    // HubSpot deal `description` is an unbounded textarea; without the
    // clamp a single fat deal would throw at refreshMetaForTarget and
    // wedge the reconciliation cursor on it. The clamp keeps the meta
    // serialisable; the FULL value still drives the hash.
    const huge = 'd'.repeat(9 * 1024);
    const meta = projectDealMeta(rawDeal({ description: huge }), 'fnv1a:00000000', 1);
    expect(typeof meta.description).toBe('string');
    expect((meta.description as string).length).toBe(1025); // 1024 + ellipsis
    expect((meta.description as string).endsWith('…')).toBe(true);
    // The whole snapshot now serialises without tripping the 8 KB cap.
    expect(() => serializeEnrichmentMeta(meta)).not.toThrow();
    // The hash reflects the FULL (un-clamped) description, so an edit
    // past the cap still re-stamps.
    expect(computeDealHash(rawDeal({ description: huge }))).not.toBe(
      computeDealHash(rawDeal({ description: `${huge}-edited-past-the-cap` })),
    );
  });

  it('keeps a short description verbatim (no ellipsis under the cap)', () => {
    const meta = projectDealMeta(rawDeal({ description: 'Short and sweet.' }), 'fnv1a:0', 1);
    expect(meta.description).toBe('Short and sweet.');
  });

  it('drops the new free-text fields on empty-string (not just null) raw values', () => {
    const meta = projectDealMeta(
      rawDeal({ description: '', hs_next_step: '', hs_priority: '', notes_last_contacted: '', notes_next_activity_date: '' }),
      'fnv1a:0',
      1,
    );
    expect(meta.description).toBeUndefined();
    expect(meta.next_step).toBeUndefined();
    expect(meta.priority).toBeUndefined();
    // empty-string timestamps drop out of key_dates (only close/created remain).
    expect(meta.key_dates).toEqual({ close_date: 1730294400000, created_at: 1700000000000 });
  });
});

// ────────────────────────────────────────────────────────────────
// HubSpotDealReconciler.listUpdatedSince
// ────────────────────────────────────────────────────────────────

describe('D-129 P2 — HubSpotDealReconciler.listUpdatedSince', () => {
  it('yields slim records keyed on hubspot_deal_<id> with parsed modified_at', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          results: [rawDeal({ hs_lastmodifieddate: '1730000000000' }, 'a'), rawDeal({ hs_lastmodifieddate: '1730100000000' }, 'b')],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const reconciler = new HubSpotDealReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      now: () => 9_999,
    });

    const out: Array<{ id: string; modified_at: number }> = [];
    for await (const slim of reconciler.listUpdatedSince(sampleHubSpotConnection(), 0, 100)) {
      out.push({ id: slim.id, modified_at: slim.modified_at });
    }

    expect(out).toEqual([
      { id: 'hubspot_deal_acme-hubspot_a', modified_at: 1730000000000 },
      { id: 'hubspot_deal_acme-hubspot_b', modified_at: 1730100000000 },
    ]);
  });

  it('skips records missing hs_lastmodifieddate (cursor cannot advance for them)', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          results: [
            rawDeal({ hs_lastmodifieddate: null }, 'no-mod'),
            rawDeal({ hs_lastmodifieddate: '1730000000000' }, 'good'),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const reconciler = new HubSpotDealReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const ids: string[] = [];
    for await (const slim of reconciler.listUpdatedSince(sampleHubSpotConnection(), 0, 100)) {
      ids.push(slim.id);
    }
    expect(ids).toEqual(['hubspot_deal_acme-hubspot_good']);
  });

  it('declares the canonical default cadence', () => {
    const reconciler = new HubSpotDealReconciler({
      search: {
        fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    expect(reconciler.vendor).toBe('hubspot');
    expect(reconciler.entity).toBe('deal');
    expect(reconciler.default_cadence).toBe('6h');
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — wireHubSpotReconciliation
// ────────────────────────────────────────────────────────────────

describe('D-129 P2 — wireHubSpotReconciliation', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-129-p2-boot-'));
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

  const upsertHubSpot = (name: string): void => {
    connectionStore.upsert({
      kind: 'api',
      name,
      display_name: name,
      config_json: JSON.stringify({ base_url: 'https://api.hubapi.com', vendor: 'hubspot' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
  };

  const reconcilers = () =>
    buildHubSpotReconcilers({
      deal: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
      contact: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
      company: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
    });

  it('registers reconcilers in the default registry', () => {
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(listVendorReconcilers().map((r) => `${r.vendor}.${r.entity}`)).toContain('hubspot.deal');
  });

  it('registers per-connection housekeeping tasks for HubSpot connections that exist at boot', () => {
    upsertHubSpot('acme');
    upsertHubSpot('personal');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const taskIds = listHousekeepingTasks().map((t) => t.meta.id).sort();
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'deal', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'deal', 'personal'));
  });

  it('registers a task when a new HubSpot connection is upserted post-boot', () => {
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'late'))).toBeUndefined();
    upsertHubSpot('late');
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'late'))).toBeDefined();
  });

  it('deregisters tasks when the HubSpot connection is deleted; cursor row in housekeeping_state survives', () => {
    upsertHubSpot('temp');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'temp'))).toBeDefined();
    connectionStore.delete('api', 'temp');
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'temp'))).toBeUndefined();
  });

  it('does not register tasks for non-HubSpot api connections', () => {
    // D-130 P2 — `'salesforce'` is now a registered vendor, so use
    // `'pipedrive'` as the unregistered-vendor probe (matches the
    // D-130 P1 close pattern that swapped 8 D-129 + 1 D-125 tests).
    connectionStore.upsert({
      kind: 'api',
      name: 'some-other',
      display_name: 'Other',
      config_json: JSON.stringify({ base_url: 'https://example.com', vendor: 'pipedrive' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'some-other'))).toBeUndefined();
  });

  it('is idempotent on token-refresh upserts (repeated upsert never re-throws)', () => {
    upsertHubSpot('idem');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    // second upsert (simulating a token refresh path) — handler must not
    // re-register a task that's already in the registry.
    expect(() => upsertHubSpot('idem')).not.toThrow();
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'idem'))).toBeDefined();
  });
});
