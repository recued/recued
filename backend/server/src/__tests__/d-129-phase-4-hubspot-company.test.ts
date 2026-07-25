/** D-129 Phase 4 — HubSpot company reconciler + boot wire tests.
 *
 *  Covers:
 *  - `HubSpotCompanyReconciler.listUpdatedSince` walks search results
 *    + materialises slim records keyed on `hubspot_company_<id>`.
 *  - `searchHubSpotObjects` request shape for `objectType: 'companies'`
 *    with `HUBSPOT_COMPANY_PROPERTIES` projection.
 *  - `computeCompanyHash` is determinism + sensitivity to every
 *    canonical field (name / domain / industry / owner / annual_revenue
 *    / num_employees) and insensitivity to `hs_lastmodifieddate` alone.
 *  - `projectCompanyMeta` produces the full canonical-field meta with
 *    snake_case projection (`numberofemployees` → `num_employees`,
 *    `annualrevenue` → `annual_revenue`), and 8 KB serialise cap on
 *    synthetic large records.
 *  - `wireHubSpotReconciliation` registers all three reconcilers + the
 *    full per-(reconciler, connection) task set; deletion deregisters
 *    every entity's task.
 *
 *  Reconciler-side concerns shared with deal + contact (cursor advance,
 *  hash skip, search pagination, 401 / 429 paths) are covered in the
 *  P2 + P3 test files; this file only exercises company-specific
 *  behaviour. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HUBSPOT_COMPANY_PROPERTIES,
  serializeEnrichmentMeta,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import {
  searchHubSpotObjects,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from '../data/hubspot/_hubspot-search.js';
import {
  HubSpotCompanyReconciler,
  computeCompanyHash,
  projectCompanyMeta,
} from '../data/hubspot/company-reconciler.js';
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

const rawCompany = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '9001',
): RawHubSpotRecord => ({
  id,
  properties: {
    name: 'Acme Corp',
    domain: 'acme.com',
    industry: 'COMPUTER_SOFTWARE',
    numberofemployees: '250',
    hubspot_owner_id: '777',
    annualrevenue: '12500000',
    hs_lastmodifieddate: '1730294400000',
    ...overrides,
  },
});

// ────────────────────────────────────────────────────────────────
// _hubspot-search request shape (companies)
// ────────────────────────────────────────────────────────────────

describe('D-129 P4 — searchHubSpotObjects request shape (companies)', () => {
  it('POSTs the canonical company properties against /crm/v3/objects/companies/search', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetcher = async (url: string | URL, init: RequestInit | undefined) => {
      calls.push({
        url: String(url),
        body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
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
        objectType: 'companies',
        properties: HUBSPOT_COMPANY_PROPERTIES,
        modifiedSince: 1_700_000_000_000,
        limit: 100,
      },
      deps,
    )) {
      // exhaust generator
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.hubapi.com/crm/v3/objects/companies/search');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.properties).toEqual([...HUBSPOT_COMPANY_PROPERTIES]);
    expect(body.sorts).toEqual([{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }]);
  });
});

// ────────────────────────────────────────────────────────────────
// computeCompanyHash
// ────────────────────────────────────────────────────────────────

describe('D-129 P4 — computeCompanyHash', () => {
  it('is deterministic for identical canonical fields', () => {
    const a = rawCompany();
    const b = rawCompany();
    expect(computeCompanyHash(a)).toBe(computeCompanyHash(b));
    expect(computeCompanyHash(a)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('changes when each canonical field changes', () => {
    const base = computeCompanyHash(rawCompany());
    expect(computeCompanyHash(rawCompany({ name: 'Other Corp' }))).not.toBe(base);
    expect(computeCompanyHash(rawCompany({ domain: 'other.com' }))).not.toBe(base);
    expect(computeCompanyHash(rawCompany({ industry: 'CONSULTING' }))).not.toBe(base);
    expect(computeCompanyHash(rawCompany({ hubspot_owner_id: '888' }))).not.toBe(base);
    expect(computeCompanyHash(rawCompany({ annualrevenue: '20000000' }))).not.toBe(base);
    expect(computeCompanyHash(rawCompany({ numberofemployees: '500' }))).not.toBe(base);
  });

  it('does not change when hs_lastmodifieddate alone rotates', () => {
    const base = computeCompanyHash(rawCompany());
    expect(computeCompanyHash(rawCompany({ hs_lastmodifieddate: '999999' }))).toBe(base);
  });
});

// ────────────────────────────────────────────────────────────────
// projectCompanyMeta
// ────────────────────────────────────────────────────────────────

describe('D-129 P4 — projectCompanyMeta', () => {
  it('renders the full canonical field set with stamping fields', () => {
    const meta = projectCompanyMeta(rawCompany(), 'fnv1a:abc12345', 1_700_000_000_000);
    expect(meta.snapshot_at).toBe(1_700_000_000_000);
    expect(meta.snapshot_hash).toBe('fnv1a:abc12345');
    expect(meta.name).toBe('Acme Corp');
    expect(meta.domain).toBe('acme.com');
    expect(meta.industry).toBe('COMPUTER_SOFTWARE');
    expect(meta.num_employees).toBe(250);
    expect(meta.owner).toBe('hubspot_owner_id:777');
    expect(meta.annual_revenue).toBe(12500000);
  });

  it('projects HubSpot one-word properties to snake_case (numberofemployees → num_employees, annualrevenue → annual_revenue)', () => {
    const meta = projectCompanyMeta(
      rawCompany({ numberofemployees: '42', annualrevenue: '1000000' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.num_employees).toBe(42);
    expect(meta.annual_revenue).toBe(1000000);
    // Raw HubSpot field names should NOT appear under their original
    // casing — the snake_case projection is the canonical surface.
    expect(meta.numberofemployees).toBeUndefined();
    expect(meta.annualrevenue).toBeUndefined();
  });

  it('omits optional fields when raw values are null / empty', () => {
    const raw = rawCompany({
      name: null,
      domain: null,
      industry: null,
      numberofemployees: null,
      hubspot_owner_id: null,
      annualrevenue: null,
    });
    const meta = projectCompanyMeta(raw, 'fnv1a:00000000', 1);
    expect(meta.name).toBeUndefined();
    expect(meta.domain).toBeUndefined();
    expect(meta.industry).toBeUndefined();
    expect(meta.num_employees).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.annual_revenue).toBeUndefined();
  });

  it('omits numeric fields when raw values are non-numeric strings', () => {
    const meta = projectCompanyMeta(
      rawCompany({ numberofemployees: 'not-a-number', annualrevenue: '' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.num_employees).toBeUndefined();
    expect(meta.annual_revenue).toBeUndefined();
  });

  it('rejects via PLATFORM_REFERENCE_META_MAX_BYTES when serialised meta exceeds 8 KB', () => {
    const huge = 'x'.repeat(9 * 1024);
    const meta = projectCompanyMeta(rawCompany({ name: huge }), 'fnv1a:00000000', 1);
    expect(() => serializeEnrichmentMeta(meta)).toThrow(/meta_snapshot_too_large/);
  });
});

// ────────────────────────────────────────────────────────────────
// HubSpotCompanyReconciler.listUpdatedSince
// ────────────────────────────────────────────────────────────────

describe('D-129 P4 — HubSpotCompanyReconciler.listUpdatedSince', () => {
  it('yields slim records keyed on hubspot_company_<id> with parsed modified_at', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          results: [
            rawCompany({ hs_lastmodifieddate: '1730000000000' }, 'a'),
            rawCompany({ hs_lastmodifieddate: '1730100000000' }, 'b'),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const reconciler = new HubSpotCompanyReconciler({
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
      { id: 'hubspot_company_acme-hubspot_a', modified_at: 1730000000000 },
      { id: 'hubspot_company_acme-hubspot_b', modified_at: 1730100000000 },
    ]);
  });

  it('skips records missing hs_lastmodifieddate (cursor cannot advance for them)', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          results: [
            rawCompany({ hs_lastmodifieddate: null }, 'no-mod'),
            rawCompany({ hs_lastmodifieddate: '1730000000000' }, 'good'),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const reconciler = new HubSpotCompanyReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const ids: string[] = [];
    for await (const slim of reconciler.listUpdatedSince(sampleHubSpotConnection(), 0, 100)) {
      ids.push(slim.id);
    }
    expect(ids).toEqual(['hubspot_company_acme-hubspot_good']);
  });

  it('declares the canonical default cadence + (vendor, entity) shape', () => {
    const reconciler = new HubSpotCompanyReconciler({
      search: {
        fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    expect(reconciler.vendor).toBe('hubspot');
    expect(reconciler.entity).toBe('company');
    expect(reconciler.default_cadence).toBe('6h');
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — wireHubSpotReconciliation registers all three reconcilers
// ────────────────────────────────────────────────────────────────

describe('D-129 P4 — wireHubSpotReconciliation full Sales Hub trio', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-129-p4-boot-'));
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

  it('registers all three reconcilers (deal + contact + company) in the default registry', () => {
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const ids = listVendorReconcilers().map((r) => `${r.vendor}.${r.entity}`);
    expect(ids).toContain('hubspot.deal');
    expect(ids).toContain('hubspot.contact');
    expect(ids).toContain('hubspot.company');
  });

  it('registers per-(reconciler, connection) tasks for all three entities at boot', () => {
    upsertHubSpot('acme');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const taskIds = listHousekeepingTasks().map((t) => t.meta.id);
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'deal', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'contact', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'company', 'acme'));
  });

  it('deregisters every entity task when the HubSpot connection is deleted', () => {
    upsertHubSpot('temp');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'company', 'temp'))).toBeDefined();
    connectionStore.delete('api', 'temp');
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'temp'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'contact', 'temp'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'company', 'temp'))).toBeUndefined();
  });
});
