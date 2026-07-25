/** D-130 Phase 4 — Salesforce account reconciler tests.
 *
 *  Covers:
 *  - `buildAccountSoql` cursor-aware SOQL composition.
 *  - `computeAccountHash` determinism + sensitivity to all 6 canonical
 *    fields (none excluded — every field flips identity per the
 *    HubSpot company precedent at D-129 P4).
 *  - `projectAccountMeta` produces the full canonical meta + omits
 *    optional fields when raw is null + 8 KB serialise cap on
 *    synthetic large records.
 *  - `SalesforceAccountReconciler.listUpdatedSince` walks SOQL results
 *    + materialises slim records keyed on `salesforce_account_<Id>` +
 *    issues the WHERE clause on subsequent runs + skips records missing
 *    LastModifiedDate.
 *  - Reconciler declares the canonical default cadence + vendor +
 *    entity for harness wiring.
 *  - Boot wire registers account tasks alongside opportunity + contact
 *    tasks (Sales Cloud trio); deregisters cleanly on delete.
 *
 *  Cross-cutting concerns (search helper request shape, 401 refresh
 *  round-trip, 503/429 backoff, sandbox-vs-production base) ride on
 *  the same `_salesforce-search.ts` already exercised by the P2 test
 *  file — not duplicated here. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SALESFORCE_ACCOUNT_FIELDS,
  serializeEnrichmentMeta,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import type {
  RawSalesforceRecord,
} from '../data/salesforce/_salesforce-search.js';
import {
  SalesforceAccountReconciler,
  buildAccountSoql,
  computeAccountHash,
  projectAccountMeta,
} from '../data/salesforce/account-reconciler.js';
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

const rawAccount = (
  overrides: Partial<RawSalesforceRecord> = {},
  id = '001A0000005ACMECO',
): RawSalesforceRecord => ({
  Id: id,
  Name: 'Acme Corporation',
  Website: 'https://acme.com',
  Industry: 'Technology',
  NumberOfEmployees: 250,
  OwnerId: '005A0000001XYZAB',
  AnnualRevenue: 50_000_000,
  LastModifiedDate: '2026-05-01T14:32:18.000Z',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// buildAccountSoql
// ────────────────────────────────────────────────────────────────

describe('D-130 P4 — buildAccountSoql', () => {
  it('emits a SELECT projecting every canonical SALESFORCE_ACCOUNT_FIELDS entry', () => {
    const soql = buildAccountSoql(0, 200);
    expect(soql).toContain(`SELECT ${SALESFORCE_ACCOUNT_FIELDS.join(', ')}`);
    expect(soql).toContain('FROM Account');
  });

  it('omits the WHERE clause on first run (cursor=0)', () => {
    expect(buildAccountSoql(0, 200)).not.toContain('WHERE');
  });

  it('emits a WHERE LastModifiedDate >= <iso> filter on subsequent runs', () => {
    const cursor = Date.parse('2026-04-01T00:00:00.000Z');
    expect(buildAccountSoql(cursor, 200)).toContain('WHERE LastModifiedDate >= 2026-04-01T00:00:00.000Z');
  });

  it('orders ASC by LastModifiedDate so the harness can advance the cursor monotonically', () => {
    expect(buildAccountSoql(0, 200)).toContain('ORDER BY LastModifiedDate ASC');
  });

  it('caps to LIMIT <pageLimit> for budget-bounded paging', () => {
    expect(buildAccountSoql(0, 50)).toContain('LIMIT 50');
  });
});

// ────────────────────────────────────────────────────────────────
// computeAccountHash
// ────────────────────────────────────────────────────────────────

describe('D-130 P4 — computeAccountHash', () => {
  it('is deterministic for identical canonical fields', () => {
    expect(computeAccountHash(rawAccount())).toBe(computeAccountHash(rawAccount()));
    expect(computeAccountHash(rawAccount())).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('changes when any of the 6 canonical fields changes (none excluded)', () => {
    const base = computeAccountHash(rawAccount());
    expect(computeAccountHash(rawAccount({ Name: 'Different Co' }))).not.toBe(base);
    expect(computeAccountHash(rawAccount({ Website: 'https://different.com' }))).not.toBe(base);
    expect(computeAccountHash(rawAccount({ Industry: 'Healthcare' }))).not.toBe(base);
    expect(computeAccountHash(rawAccount({ NumberOfEmployees: 500 }))).not.toBe(base);
    expect(computeAccountHash(rawAccount({ OwnerId: '005A0000099XYZAB' }))).not.toBe(base);
    expect(computeAccountHash(rawAccount({ AnnualRevenue: 999_999_999 }))).not.toBe(base);
  });

  it('does not change when LastModifiedDate rotates (cursor field is not canonical)', () => {
    const base = computeAccountHash(rawAccount());
    expect(computeAccountHash(rawAccount({ LastModifiedDate: '2099-12-31T23:59:59.000Z' }))).toBe(base);
  });
});

// ────────────────────────────────────────────────────────────────
// projectAccountMeta
// ────────────────────────────────────────────────────────────────

describe('D-130 P4 — projectAccountMeta', () => {
  it('renders the full canonical field set with stamping fields', () => {
    const meta = projectAccountMeta(rawAccount(), 'fnv1a:abc12345', 1_700_000_000_000);
    expect(meta.snapshot_at).toBe(1_700_000_000_000);
    expect(meta.snapshot_hash).toBe('fnv1a:abc12345');
    expect(meta.name).toBe('Acme Corporation');
    expect(meta.domain).toBe('https://acme.com');
    expect(meta.industry).toBe('Technology');
    expect(meta.num_employees).toBe(250);
    expect(meta.owner).toBe('salesforce_user:005A0000001XYZAB');
    expect(meta.annual_revenue).toBe(50_000_000);
  });

  it('preserves Website verbatim (no canonicalization at projection)', () => {
    const meta = projectAccountMeta(
      rawAccount({ Website: 'WWW.Example.COM/' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.domain).toBe('WWW.Example.COM/');
  });

  it('parses NumberOfEmployees from a numeric string (defensive)', () => {
    const meta = projectAccountMeta(
      rawAccount({ NumberOfEmployees: '750' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.num_employees).toBe(750);
  });

  it('parses AnnualRevenue from a numeric string (defensive)', () => {
    const meta = projectAccountMeta(
      rawAccount({ AnnualRevenue: '125000000' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.annual_revenue).toBe(125_000_000);
  });

  it('omits optional fields when raw values are null / empty', () => {
    const raw: RawSalesforceRecord = {
      Id: '001A0000005ACMECO',
      Name: '',
      Website: null,
      Industry: null,
      NumberOfEmployees: null,
      OwnerId: null,
      AnnualRevenue: null,
      LastModifiedDate: '2026-05-01T00:00:00.000Z',
    };
    const meta = projectAccountMeta(raw, 'fnv1a:00000000', 1);
    expect(meta.name).toBeUndefined();
    expect(meta.domain).toBeUndefined();
    expect(meta.industry).toBeUndefined();
    expect(meta.num_employees).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.annual_revenue).toBeUndefined();
  });

  it('rejects via PLATFORM_REFERENCE_META_MAX_BYTES when serialised meta exceeds 8 KB', () => {
    const huge = 'x'.repeat(9 * 1024);
    const meta = projectAccountMeta(rawAccount({ Name: huge }), 'fnv1a:00000000', 1);
    expect(() => serializeEnrichmentMeta(meta)).toThrow(/meta_snapshot_too_large/);
  });
});

// ────────────────────────────────────────────────────────────────
// SalesforceAccountReconciler.listUpdatedSince
// ────────────────────────────────────────────────────────────────

describe('D-130 P4 — SalesforceAccountReconciler.listUpdatedSince', () => {
  it('yields slim records keyed on salesforce_account_<Id> with parsed modified_at', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            rawAccount({ LastModifiedDate: '2026-04-01T00:00:00.000Z' }, '001a000'),
            rawAccount({ LastModifiedDate: '2026-04-02T00:00:00.000Z' }, '001b000'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceAccountReconciler({
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
      { id: 'salesforce_account_acme-salesforce_001a000', modified_at: Date.parse('2026-04-01T00:00:00.000Z') },
      { id: 'salesforce_account_acme-salesforce_001b000', modified_at: Date.parse('2026-04-02T00:00:00.000Z') },
    ]);
  });

  it('skips records missing LastModifiedDate (cursor cannot advance for them)', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            { Id: 'no-mod', Name: 'Stamp-less Co' },
            rawAccount({ LastModifiedDate: '2026-05-01T00:00:00.000Z' }, 'good'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceAccountReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const ids: string[] = [];
    for await (const slim of reconciler.listUpdatedSince(sampleSalesforceConnection(), 0, 200)) {
      ids.push(slim.id);
    }
    expect(ids).toEqual(['salesforce_account_acme-salesforce_good']);
  });

  it('issues a SOQL with the WHERE LastModifiedDate >= <iso> filter on subsequent runs against FROM Account', async () => {
    const seenUrls: string[] = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ records: [], done: true }), { status: 200 });
    };
    const reconciler = new SalesforceAccountReconciler({
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
    expect(seenUrls[0]).toContain(encodeURIComponent('FROM Account'));
  });

  it('declares the canonical default cadence + vendor + entity', () => {
    const reconciler = new SalesforceAccountReconciler({
      search: {
        fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    expect(reconciler.vendor).toBe('salesforce');
    expect(reconciler.entity).toBe('account');
    expect(reconciler.default_cadence).toBe('6h');
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — Sales Cloud trio (opportunity + contact + account)
// ────────────────────────────────────────────────────────────────

describe('D-130 P4 — wireSalesforceReconciliation registers account tasks alongside opportunity + contact', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-130-p4-boot-'));
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

  it('registers all three Sales Cloud reconcilers in the default registry', () => {
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const labels = listVendorReconcilers().map((r) => `${r.vendor}.${r.entity}`);
    expect(labels).toContain('salesforce.opportunity');
    expect(labels).toContain('salesforce.contact');
    expect(labels).toContain('salesforce.account');
  });

  it('registers account tasks per-connection at boot alongside opportunity + contact tasks', () => {
    upsertSalesforce('acme');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const taskIds = listHousekeepingTasks().map((t) => t.meta.id).sort();
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'opportunity', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'contact', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'account', 'acme'));
  });

  it('registers account task when a new Salesforce connection upserts post-boot', () => {
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'account', 'late'))).toBeUndefined();
    upsertSalesforce('late');
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'account', 'late'))).toBeDefined();
  });

  it('deregisters the entire Sales Cloud trio when the connection is deleted', () => {
    upsertSalesforce('temp');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'temp'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'contact', 'temp'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'account', 'temp'))).toBeDefined();
    connectionStore.delete('api', 'temp');
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'temp'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'contact', 'temp'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'account', 'temp'))).toBeUndefined();
  });
});
