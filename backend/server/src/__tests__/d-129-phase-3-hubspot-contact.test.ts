/** D-129 Phase 3 — HubSpot contact reconciler + boot wire tests.
 *
 *  Covers:
 *  - `HubSpotContactReconciler.listUpdatedSince` walks search results +
 *    materialises slim records keyed on `hubspot_contact_<id>`.
 *  - `searchHubSpotObjects` request shape for `objectType: 'contacts'`
 *    with `HUBSPOT_CONTACT_PROPERTIES` projection.
 *  - `canonicalizeEmail` lowercases + trims; rejects null / empty /
 *    whitespace-only.
 *  - `computeContactHash` is determinism + sensitivity to canonical
 *    fields (email / lifecycle_stage / owner / account_id) but
 *    insensitive to `recent_activity_at` (notes_last_contacted) and
 *    name fields (firstname / lastname).
 *  - `projectContactMeta` produces the full canonical-field meta with
 *    canonicalized email, name reconstitution + email-local-part
 *    fallback, and 8 KB serialise cap on synthetic large records.
 *  - `wireHubSpotReconciliation` registers per-(reconciler, connection)
 *    tasks for both deal AND contact alongside; deletion deregisters
 *    both.
 *
 *  Reconciler-side concerns shared with deal (cursor advance, hash
 *  skip, search pagination, 401 / 429 paths) are covered in the P2
 *  test file; this file only exercises contact-specific behaviour. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HUBSPOT_CONTACT_PROPERTIES,
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
  HubSpotContactReconciler,
  canonicalizeEmail,
  computeContactHash,
  projectContactMeta,
} from '../data/hubspot/contact-reconciler.js';
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

const rawContact = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '5678',
): RawHubSpotRecord => ({
  id,
  properties: {
    email: 'bob@example.com',
    firstname: 'Bob',
    lastname: 'Smith',
    lifecyclestage: 'customer',
    hubspot_owner_id: '777',
    associatedcompanyid: 'co-42',
    notes_last_contacted: '1730000000000',
    hs_lastmodifieddate: '1730294400000',
    ...overrides,
  },
});

// ────────────────────────────────────────────────────────────────
// canonicalizeEmail
// ────────────────────────────────────────────────────────────────

describe('D-129 P3 — canonicalizeEmail', () => {
  it('lowercases mixed-case email + trims whitespace', () => {
    expect(canonicalizeEmail('  Bob@Example.COM  ')).toBe('bob@example.com');
  });

  it('returns null for null / undefined', () => {
    expect(canonicalizeEmail(null)).toBeNull();
    expect(canonicalizeEmail(undefined)).toBeNull();
  });

  it('returns null for empty / whitespace-only', () => {
    expect(canonicalizeEmail('')).toBeNull();
    expect(canonicalizeEmail('   ')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// _hubspot-search request shape (contacts)
// ────────────────────────────────────────────────────────────────

describe('D-129 P3 — searchHubSpotObjects request shape (contacts)', () => {
  it('POSTs the canonical contact properties against /crm/v3/objects/contacts/search', async () => {
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
        objectType: 'contacts',
        properties: HUBSPOT_CONTACT_PROPERTIES,
        modifiedSince: 1_700_000_000_000,
        limit: 100,
      },
      deps,
    )) {
      // exhaust generator
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.properties).toEqual([...HUBSPOT_CONTACT_PROPERTIES]);
    expect(body.sorts).toEqual([{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }]);
  });
});

// ────────────────────────────────────────────────────────────────
// computeContactHash
// ────────────────────────────────────────────────────────────────

describe('D-129 P3 — computeContactHash', () => {
  it('is deterministic for identical canonical fields', () => {
    const a = rawContact();
    const b = rawContact();
    expect(computeContactHash(a)).toBe(computeContactHash(b));
    expect(computeContactHash(a)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('changes when each canonical field changes', () => {
    const base = computeContactHash(rawContact());
    expect(computeContactHash(rawContact({ email: 'alice@example.com' }))).not.toBe(base);
    expect(computeContactHash(rawContact({ lifecyclestage: 'lead' }))).not.toBe(base);
    expect(computeContactHash(rawContact({ hubspot_owner_id: '888' }))).not.toBe(base);
    expect(computeContactHash(rawContact({ associatedcompanyid: 'co-99' }))).not.toBe(base);
  });

  it('is case-insensitive on email (canonicalization participates in the hash)', () => {
    const lower = computeContactHash(rawContact({ email: 'bob@example.com' }));
    const mixed = computeContactHash(rawContact({ email: 'Bob@Example.COM' }));
    const padded = computeContactHash(rawContact({ email: '  bob@example.com  ' }));
    expect(mixed).toBe(lower);
    expect(padded).toBe(lower);
  });

  it('does not change when recent_activity_at rotates (notes_last_contacted)', () => {
    const base = computeContactHash(rawContact());
    expect(computeContactHash(rawContact({ notes_last_contacted: '1' }))).toBe(base);
    expect(computeContactHash(rawContact({ notes_last_contacted: null }))).toBe(base);
  });

  it('does not change when name fields rotate (firstname / lastname)', () => {
    const base = computeContactHash(rawContact());
    expect(computeContactHash(rawContact({ firstname: 'Robert' }))).toBe(base);
    expect(computeContactHash(rawContact({ lastname: 'Jones' }))).toBe(base);
  });
});

// ────────────────────────────────────────────────────────────────
// projectContactMeta
// ────────────────────────────────────────────────────────────────

describe('D-129 P3 — projectContactMeta', () => {
  it('renders the full canonical field set with stamping fields', () => {
    const meta = projectContactMeta(rawContact(), 'fnv1a:abc12345', 1_700_000_000_000);
    expect(meta.snapshot_at).toBe(1_700_000_000_000);
    expect(meta.snapshot_hash).toBe('fnv1a:abc12345');
    expect(meta.email).toBe('bob@example.com');
    expect(meta.name).toBe('Bob Smith');
    expect(meta.lifecycle_stage).toBe('customer');
    expect(meta.owner).toBe('hubspot_owner_id:777');
    expect(meta.account_id).toBe('co-42');
    expect(meta.recent_activity_at).toBe(1730000000000);
  });

  it('canonicalizes email at projection time', () => {
    const meta = projectContactMeta(
      rawContact({ email: '  Bob@EXAMPLE.com  ' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.email).toBe('bob@example.com');
  });

  it('reconstitutes meta.name from firstname + lastname when both present', () => {
    const meta = projectContactMeta(
      rawContact({ firstname: 'Alice', lastname: 'Wonder' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('Alice Wonder');
  });

  it('falls back to firstname-only when lastname is null', () => {
    const meta = projectContactMeta(
      rawContact({ firstname: 'Alice', lastname: null }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('Alice');
  });

  it('falls back to lastname-only when firstname is null', () => {
    const meta = projectContactMeta(
      rawContact({ firstname: null, lastname: 'Wonder' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('Wonder');
  });

  it('falls back to email local-part when both names are absent', () => {
    const meta = projectContactMeta(
      rawContact({ firstname: null, lastname: null, email: 'carol@example.com' }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBe('carol');
  });

  it('omits meta.name when firstname / lastname / email are all absent', () => {
    const meta = projectContactMeta(
      rawContact({ firstname: null, lastname: null, email: null }),
      'fnv1a:00000000',
      1,
    );
    expect(meta.name).toBeUndefined();
    expect(meta.email).toBeUndefined();
  });

  it('omits optional fields when raw values are null / empty', () => {
    const raw = rawContact({
      email: null,
      firstname: null,
      lastname: null,
      lifecyclestage: null,
      hubspot_owner_id: null,
      associatedcompanyid: null,
      notes_last_contacted: null,
    });
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
    const meta = projectContactMeta(rawContact({ firstname: huge }), 'fnv1a:00000000', 1);
    expect(() => serializeEnrichmentMeta(meta)).toThrow(/meta_snapshot_too_large/);
  });
});

// ────────────────────────────────────────────────────────────────
// HubSpotContactReconciler.listUpdatedSince
// ────────────────────────────────────────────────────────────────

describe('D-129 P3 — HubSpotContactReconciler.listUpdatedSince', () => {
  it('yields slim records keyed on hubspot_contact_<id> with parsed modified_at', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          results: [
            rawContact({ hs_lastmodifieddate: '1730000000000' }, 'a'),
            rawContact({ hs_lastmodifieddate: '1730100000000' }, 'b'),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const reconciler = new HubSpotContactReconciler({
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
      { id: 'hubspot_contact_acme-hubspot_a', modified_at: 1730000000000 },
      { id: 'hubspot_contact_acme-hubspot_b', modified_at: 1730100000000 },
    ]);
  });

  it('skips records missing hs_lastmodifieddate (cursor cannot advance for them)', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          results: [
            rawContact({ hs_lastmodifieddate: null }, 'no-mod'),
            rawContact({ hs_lastmodifieddate: '1730000000000' }, 'good'),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const reconciler = new HubSpotContactReconciler({
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });

    const ids: string[] = [];
    for await (const slim of reconciler.listUpdatedSince(sampleHubSpotConnection(), 0, 100)) {
      ids.push(slim.id);
    }
    expect(ids).toEqual(['hubspot_contact_acme-hubspot_good']);
  });

  it('declares the canonical default cadence + (vendor, entity) shape', () => {
    const reconciler = new HubSpotContactReconciler({
      search: {
        fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
    });
    expect(reconciler.vendor).toBe('hubspot');
    expect(reconciler.entity).toBe('contact');
    expect(reconciler.default_cadence).toBe('6h');
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — wireHubSpotReconciliation registers contact alongside deal
// ────────────────────────────────────────────────────────────────

describe('D-129 P3 — wireHubSpotReconciliation contact integration', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-129-p3-boot-'));
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

  it('registers both deal AND contact reconcilers in the default registry', () => {
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const ids = listVendorReconcilers().map((r) => `${r.vendor}.${r.entity}`);
    expect(ids).toContain('hubspot.deal');
    expect(ids).toContain('hubspot.contact');
  });

  it('registers per-(reconciler, connection) tasks for both entities at boot', () => {
    upsertHubSpot('acme');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    const taskIds = listHousekeepingTasks().map((t) => t.meta.id);
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'deal', 'acme'));
    expect(taskIds).toContain(reconciliationTaskId('hubspot', 'contact', 'acme'));
  });

  it('deregisters both deal AND contact tasks when the HubSpot connection is deleted', () => {
    upsertHubSpot('temp');
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: reconcilers(),
      lookupConnection: () => null,
    });
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'temp'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'contact', 'temp'))).toBeDefined();
    connectionStore.delete('api', 'temp');
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'temp'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'contact', 'temp'))).toBeUndefined();
  });
});
