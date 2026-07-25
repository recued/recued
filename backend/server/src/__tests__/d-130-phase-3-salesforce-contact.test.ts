/** D-130 Phase 3 — Salesforce contact reconciler tests.
 *
 *  Covers:
 *  - `buildContactSoql` cursor-aware SOQL composition (canonical field
 *    projection + first-run no-WHERE + subsequent-run cursor filter +
 *    monotonic ASC ordering + LIMIT cap).
 *  - `computeContactHash` determinism + sensitivity to canonical fields
 *    (email/lifecycle_stage/owner/account_id) + insensitivity to
 *    LastActivityDate (intentionally excluded — bumps shouldn't trigger
 *    refresh) + email-casing equivalence.
 *  - `projectContactMeta` produces the full canonical meta + email
 *    canonicalization (`Bob@Example.COM` → `bob@example.com`) + name
 *    construction with FirstName + LastName + email-local-part fallback
 *    + lifecycle_stage from LeadSource + 8 KB serialise cap on
 *    synthetic large records.
 *  - `SalesforceContactReconciler.listUpdatedSince` walks SOQL results
 *    + materialises slim records keyed on `salesforce_contact_<Id>` +
 *    issues the WHERE clause on subsequent runs + skips records missing
 *    LastModifiedDate.
 *  - Reconciler declares the canonical default cadence + vendor +
 *    entity for harness wiring.
 *  - Boot wire registers contact tasks alongside opportunity tasks for
 *    boot-time + new connections; deregisters cleanly on delete.
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
  SALESFORCE_CONTACT_FIELDS,
  serializeEnrichmentMeta,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import type {
  RawSalesforceRecord,
} from '../data/salesforce/_salesforce-search.js';
import {
  SalesforceContactReconciler,
  buildContactSoql,
  canonicalizeContactEmail,
  computeContactHash,
  projectContactMeta,
  type SalesforceContactSlimRecord,
} from '../data/salesforce/contact-reconciler.js';
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

const rawContact = (
  overrides: Partial<RawSalesforceRecord> = {},
  id = '003A0000005XYZAB',
): RawSalesforceRecord => ({
  Id: id,
  Email: 'bob@example.com',
  FirstName: 'Bob',
  LastName: 'Smith',
  LeadSource: 'Web',
  OwnerId: '005A0000001XYZAB',
  AccountId: '001A0000005ACMECO',
  LastActivityDate: '2026-04-15T10:00:00.000Z',
  LastModifiedDate: '2026-05-01T14:32:18.000Z',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// canonicalizeContactEmail
// ────────────────────────────────────────────────────────────────

describe('D-130 P3 — canonicalizeContactEmail', () => {
  it('lowercases + trims to canonical form', () => {
    expect(canonicalizeContactEmail('Bob@Example.COM')).toBe('bob@example.com');
    expect(canonicalizeContactEmail('  alice@CORP.IO ')).toBe('alice@corp.io');
  });

  it('returns null for null / undefined / empty / whitespace-only inputs', () => {
    expect(canonicalizeContactEmail(null)).toBeNull();
    expect(canonicalizeContactEmail(undefined)).toBeNull();
    expect(canonicalizeContactEmail('')).toBeNull();
    expect(canonicalizeContactEmail('   ')).toBeNull();
  });

  it('returns null for non-string inputs (defensive)', () => {
    expect(canonicalizeContactEmail(42)).toBeNull();
    expect(canonicalizeContactEmail({})).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// buildContactSoql
// ────────────────────────────────────────────────────────────────

describe('D-130 P3 — buildContactSoql', () => {
  it('emits a SELECT projecting every canonical SALESFORCE_CONTACT_FIELDS entry', () => {
    const soql = buildContactSoql(0, 200);
    expect(soql).toContain(`SELECT ${SALESFORCE_CONTACT_FIELDS.join(', ')}`);
    expect(soql).toContain('FROM Contact');
  });

  it('omits the WHERE clause on first run (cursor=0)', () => {
    expect(buildContactSoql(0, 200)).not.toContain('WHERE');
  });

  it('emits a WHERE LastModifiedDate >= <iso> filter on subsequent runs', () => {
    const cursor = Date.parse('2026-04-01T00:00:00.000Z');
    expect(buildContactSoql(cursor, 200)).toContain('WHERE LastModifiedDate >= 2026-04-01T00:00:00.000Z');
  });

  it('orders ASC by LastModifiedDate so the harness can advance the cursor monotonically', () => {
    expect(buildContactSoql(0, 200)).toContain('ORDER BY LastModifiedDate ASC');
  });

  it('caps to LIMIT <pageLimit> for budget-bounded paging', () => {
    expect(buildContactSoql(0, 50)).toContain('LIMIT 50');
  });
});

// ────────────────────────────────────────────────────────────────
// computeContactHash
// ────────────────────────────────────────────────────────────────

describe('D-130 P3 — computeContactHash', () => {
  it('is deterministic for identical canonical fields', () => {
    expect(computeContactHash(rawContact())).toBe(computeContactHash(rawContact()));
    expect(computeContactHash(rawContact())).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('changes when any canonical field changes', () => {
    const base = computeContactHash(rawContact());
    expect(computeContactHash(rawContact({ Email: 'eve@example.com' }))).not.toBe(base);
    expect(computeContactHash(rawContact({ LeadSource: 'Phone Inquiry' }))).not.toBe(base);
    expect(computeContactHash(rawContact({ OwnerId: '005A0000099XYZAB' }))).not.toBe(base);
    expect(computeContactHash(rawContact({ AccountId: '001A9999999ACMECO' }))).not.toBe(base);
  });

  it('does not change when LastActivityDate rotates (touch bumps must not trigger refresh)', () => {
    const base = computeContactHash(rawContact());
    expect(computeContactHash(rawContact({ LastActivityDate: '2099-12-31T23:59:59.000Z' }))).toBe(base);
    expect(computeContactHash(rawContact({ LastActivityDate: null }))).toBe(base);
  });

  it('does not change when LastModifiedDate rotates (cursor field is not canonical)', () => {
    const base = computeContactHash(rawContact());
    expect(computeContactHash(rawContact({ LastModifiedDate: '2099-12-31T23:59:59.000Z' }))).toBe(base);
  });

  it('treats email-casing variants as equivalent (canonicalization happens before hashing)', () => {
    const lower = computeContactHash(rawContact({ Email: 'bob@example.com' }));
    const upper = computeContactHash(rawContact({ Email: 'BOB@EXAMPLE.COM' }));
    const mixed = computeContactHash(rawContact({ Email: 'Bob@Example.COM' }));
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });
});

// ────────────────────────────────────────────────────────────────
// projectContactMeta
// ────────────────────────────────────────────────────────────────

describe('D-130 P3 — projectContactMeta', () => {
  it('renders the full canonical field set with stamping fields', () => {
    const meta = projectContactMeta(rawContact(), 'fnv1a:abc12345', 1_700_000_000_000);
    expect(meta.snapshot_at).toBe(1_700_000_000_000);
    expect(meta.snapshot_hash).toBe('fnv1a:abc12345');
    expect(meta.email).toBe('bob@example.com');
    expect(meta.name).toBe('Bob Smith');
    expect(meta.lifecycle_stage).toBe('Web');
    expect(meta.owner).toBe('salesforce_user:005A0000001XYZAB');
    expect(meta.account_id).toBe('001A0000005ACMECO');
    expect(meta.recent_activity_at).toBe(Date.parse('2026-04-15T10:00:00.000Z'));
  });

  it('canonicalizes email to lowercase + trimmed at projection time (pinned: Bob@Example.COM → bob@example.com)', () => {
    const meta = projectContactMeta(
      rawContact({ Email: 'Bob@Example.COM' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.email).toBe('bob@example.com');
  });

  it('falls back to email local-part when both FirstName and LastName are absent', () => {
    const meta = projectContactMeta(
      rawContact({ FirstName: null, LastName: null, Email: 'alice@corp.io' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('alice');
  });

  it('falls back to FirstName alone when LastName is absent', () => {
    const meta = projectContactMeta(
      rawContact({ FirstName: 'Charlie', LastName: null }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('Charlie');
  });

  it('falls back to LastName alone when FirstName is absent', () => {
    const meta = projectContactMeta(
      rawContact({ FirstName: null, LastName: 'Delta' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('Delta');
  });

  it('omits name entirely when first/last/email are all absent', () => {
    const meta = projectContactMeta(
      {
        Id: '003A0000005XYZAB',
        FirstName: null,
        LastName: null,
        Email: null,
        LastModifiedDate: '2026-05-01T00:00:00.000Z',
      },
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBeUndefined();
    expect(meta.email).toBeUndefined();
  });

  it('omits optional fields when raw values are null / empty', () => {
    const raw: RawSalesforceRecord = {
      Id: '003A0000005XYZAB',
      Email: null,
      FirstName: null,
      LastName: null,
      LeadSource: null,
      OwnerId: null,
      AccountId: null,
      LastActivityDate: null,
      LastModifiedDate: '2026-05-01T00:00:00.000Z',
    };
    const meta = projectContactMeta(raw, 'fnv1a:00000000', 1);
    expect(meta.email).toBeUndefined();
    expect(meta.name).toBeUndefined();
    expect(meta.lifecycle_stage).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.account_id).toBeUndefined();
    expect(meta.recent_activity_at).toBeUndefined();
  });

  it('rejects via PLATFORM_REFERENCE_META_MAX_BYTES when serialised meta exceeds 8 KB', () => {
    const huge = 'x'.repeat(9 * 1024);
    const meta = projectContactMeta(
      rawContact({ FirstName: huge, LastName: huge }),
      'fnv1a:00000000',
      1,
    );
    expect(() => serializeEnrichmentMeta(meta)).toThrow(/meta_snapshot_too_large/);
  });
});

// ────────────────────────────────────────────────────────────────
// SalesforceContactReconciler.listUpdatedSince
// ────────────────────────────────────────────────────────────────

describe('D-130 P3 — SalesforceContactReconciler.listUpdatedSince', () => {
  it('yields slim records keyed on salesforce_contact_<Id> with parsed modified_at', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            rawContact({ LastModifiedDate: '2026-04-01T00:00:00.000Z' }, '003a000'),
            rawContact({ LastModifiedDate: '2026-04-02T00:00:00.000Z' }, '003b000'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceContactReconciler({
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
      { id: 'salesforce_contact_acme-salesforce_003a000', modified_at: Date.parse('2026-04-01T00:00:00.000Z') },
      { id: 'salesforce_contact_acme-salesforce_003b000', modified_at: Date.parse('2026-04-02T00:00:00.000Z') },
    ]);
  });

  it('skips records missing LastModifiedDate (cursor cannot advance for them)', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            { Id: 'no-mod', Email: 'unstamped@example.com' },
            rawContact({ LastModifiedDate: '2026-05-01T00:00:00.000Z' }, 'good'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceContactReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const ids: string[] = [];
    for await (const slim of reconciler.listUpdatedSince(sampleSalesforceConnection(), 0, 200)) {
      ids.push(slim.id);
    }
    expect(ids).toEqual(['salesforce_contact_acme-salesforce_good']);
  });

  it('issues a SOQL with the WHERE LastModifiedDate >= <iso> filter on subsequent runs', async () => {
    const seenUrls: string[] = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ records: [], done: true }), { status: 200 });
    };
    const reconciler = new SalesforceContactReconciler({
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
    expect(seenUrls[0]).toContain(encodeURIComponent('FROM Contact'));
  });

  it('declares the canonical default cadence + vendor + entity', () => {
    const reconciler = new SalesforceContactReconciler({
      search: {
        fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    expect(reconciler.vendor).toBe('salesforce');
    expect(reconciler.entity).toBe('contact');
    expect(reconciler.default_cadence).toBe('6h');
  });

  it('toMeta canonicalizes email when iterating yielded slim records', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          records: [
            rawContact({ Email: 'Bob@Example.COM', LastModifiedDate: '2026-05-01T00:00:00.000Z' }, 'casing'),
          ],
          done: true,
        }),
        { status: 200 },
      );
    const reconciler = new SalesforceContactReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      now: () => 42,
    });

    const conn = sampleSalesforceConnection();
    let firstSlim: SalesforceContactSlimRecord | undefined;
    for await (const slim of reconciler.listUpdatedSince(conn, 0, 10)) {
      firstSlim = slim;
      break;
    }
    expect(firstSlim).toBeDefined();
    const meta = reconciler.toMeta(firstSlim!);
    expect(meta.email).toBe('bob@example.com');
    expect(meta.snapshot_at).toBe(42);
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — wireSalesforceReconciliation w/ contact alongside opp
// ────────────────────────────────────────────────────────────────

describe('D-130 P3 — wireSalesforceReconciliation registers contact tasks alongside opportunity', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-130-p3-boot-'));
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
      // D-130 P4 — account reconciler stacks alongside opportunity +
      // contact in the registration input shape; P3 boot-wire tests
      // assert contact-task registration but the build call must
      // satisfy the full Sales Cloud trio type.
      account: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => sampleAuth(),
        },
      },
    });

  it('registers both opportunity and contact reconcilers in the default registry', () => {
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const labels = listVendorReconcilers().map((r) => `${r.vendor}.${r.entity}`);
    expect(labels).toContain('salesforce.opportunity');
    expect(labels).toContain('salesforce.contact');
  });

  it('registers contact tasks per-connection at boot alongside opportunity tasks', () => {
    upsertSalesforce('acme');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const taskIds = listHousekeepingTasks().map((t) => t.meta.id).sort();
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'opportunity', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('salesforce', 'contact', 'acme'));
  });

  it('registers contact task when a new Salesforce connection upserts post-boot', () => {
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'contact', 'late'))).toBeUndefined();
    upsertSalesforce('late');
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'contact', 'late'))).toBeDefined();
  });

  it('deregisters contact + opportunity tasks together when the connection is deleted', () => {
    upsertSalesforce('temp');
    wireSalesforceReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'contact', 'temp'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'temp'))).toBeDefined();
    connectionStore.delete('api', 'temp');
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'contact', 'temp'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('salesforce', 'opportunity', 'temp'))).toBeUndefined();
  });
});
