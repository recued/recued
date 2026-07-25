/** D-190 — CrmRecordMirrorStore unit tests.
 *
 *  The dedicated, non-optional mirror the reconciler writes + deal.search reads.
 *  Verifies: upsert + list round-trip; the canonical json_extract filters
 *  (name_contains / meta_equals / meta_ranges) apply IN SQL with limit post-filter;
 *  created_at preserved on conflict; deleteForSource. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnrichmentMeta, EnrichmentScope } from '@recued/contracts';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';

const SCOPE = 'connection.api.hubspot.deal' as EnrichmentScope;

let dir: string;
let db: Database.Database;
let store: CrmRecordMirrorStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd190-crm-mirror-'));
  db = new Database(join(dir, 'test.db'));
  ensureCrmRecordMirrorSchema(db);
  store = createCrmRecordMirrorStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const meta = (overrides: Partial<EnrichmentMeta>, ts = 1): EnrichmentMeta => ({
  snapshot_at: ts,
  snapshot_hash: `fnv1a:${ts}`,
  ...overrides,
});

const seedThree = (): void => {
  store.upsert({ scope: SCOPE, target_id: 'd_won', now: 1_000, meta: meta({ name: 'Acme won', close_state: 'won', key_dates: { close_date: 1_700_500_000_000 } }) });
  store.upsert({ scope: SCOPE, target_id: 'd_open_early', now: 2_000, meta: meta({ name: 'Beta open', close_state: 'open', key_dates: { close_date: 1_700_100_000_000 } }) });
  store.upsert({ scope: SCOPE, target_id: 'd_open_late', now: 3_000, meta: meta({ name: 'Gamma open', close_state: 'open', key_dates: { close_date: 1_700_900_000_000 } }) });
};

describe('CrmRecordMirrorStore', () => {
  it('upsert + list round-trips a record, newest-refreshed first', () => {
    seedThree();
    const rows = store.list(SCOPE);
    expect(rows.map((r) => r.target_id)).toEqual(['d_open_late', 'd_open_early', 'd_won']);
    expect(rows[0]!.meta.name).toBe('Gamma open');
    expect(rows[0]!.scope).toBe(SCOPE);
  });

  it('lists EVERY record regardless of any enrichment — the mirror is unconditional', () => {
    // No producer / enrichment row anywhere; the mirror alone makes every deal visible.
    seedThree();
    expect(store.list(SCOPE)).toHaveLength(3);
  });

  it('name_contains filters case-insensitively on meta.name', () => {
    seedThree();
    const rows = store.list(SCOPE, { name_contains: 'aCmE' });
    expect(rows.map((r) => r.target_id)).toEqual(['d_won']);
  });

  it('name_contains treats LIKE metacharacters (_ % \\) LITERALLY (codex MEDIUM fold)', () => {
    // Without escaping, the `_` in the query is a SQL LIKE single-char wildcard →
    // 'a_c' would match 'abc'. The escape makes it literal, so the JS `.includes()`
    // live re-filter and the mirror SQL agree.
    store.upsert({ scope: SCOPE, target_id: 'lit', now: 1, meta: meta({ name: 'a_c corp' }) });
    store.upsert({ scope: SCOPE, target_id: 'wild', now: 2, meta: meta({ name: 'abc corp' }) });
    store.upsert({ scope: SCOPE, target_id: 'pct', now: 3, meta: meta({ name: '50% off inc' }) });
    expect(store.list(SCOPE, { name_contains: 'a_c' }).map((r) => r.target_id)).toEqual(['lit']);
    // `%` is literal too — matches the row containing a real '%', not everything.
    expect(store.list(SCOPE, { name_contains: '50%' }).map((r) => r.target_id)).toEqual(['pct']);
  });

  it('domain_exact filters case-insensitively on meta.domain (account identifier)', () => {
    store.upsert({ scope: SCOPE, target_id: 'a1', now: 1, meta: meta({ name: 'Acme Inc', domain: 'Acme.COM' }) });
    store.upsert({ scope: SCOPE, target_id: 'a2', now: 2, meta: meta({ name: 'Other Co', domain: 'other.com' }) });
    expect(store.list(SCOPE, { domain_exact: 'acme.com' }).map((r) => r.target_id)).toEqual(['a1']);
  });

  it('meta_equals filters a canonical field (close_state) in SQL', () => {
    seedThree();
    const rows = store.list(SCOPE, { meta_equals: [{ path: '$.close_state', value: 'open' }] });
    expect(rows.map((r) => r.target_id).sort()).toEqual(['d_open_early', 'd_open_late']);
  });

  it('meta_ranges bounds a numeric field (close_date) inclusively', () => {
    seedThree();
    const rows = store.list(SCOPE, {
      meta_ranges: [{ path: '$.key_dates.close_date', min: 1_700_400_000_000, max: 1_700_600_000_000 }],
    });
    expect(rows.map((r) => r.target_id)).toEqual(['d_won']);
  });

  it('combines equals + range (AND) — only the late open deal clears both', () => {
    seedThree();
    const rows = store.list(SCOPE, {
      meta_equals: [{ path: '$.close_state', value: 'open' }],
      meta_ranges: [{ path: '$.key_dates.close_date', min: 1_700_500_000_000 }],
    });
    expect(rows.map((r) => r.target_id)).toEqual(['d_open_late']);
  });

  it('a row whose meta lacks the filtered key drops (json_extract NULL != value)', () => {
    store.upsert({ scope: SCOPE, target_id: 'd_nostate', now: 1_000, meta: meta({ name: 'No state' }) });
    store.upsert({ scope: SCOPE, target_id: 'd_won', now: 2_000, meta: meta({ name: 'Acme', close_state: 'won' }) });
    const rows = store.list(SCOPE, { meta_equals: [{ path: '$.close_state', value: 'won' }] });
    expect(rows.map((r) => r.target_id)).toEqual(['d_won']);
  });

  it('limit applies POST-filter and clamps to the per-call cap', () => {
    seedThree();
    expect(store.list(SCOPE, { meta_equals: [{ path: '$.close_state', value: 'open' }], limit: 1 })).toHaveLength(1);
  });

  it('upsert preserves created_at on conflict (only meta + updated_at change)', () => {
    store.upsert({ scope: SCOPE, target_id: 'd1', now: 1_000, meta: meta({ name: 'v1' }) });
    store.upsert({ scope: SCOPE, target_id: 'd1', now: 5_000, meta: meta({ name: 'v2' }) });
    const row = db
      .prepare('SELECT created_at, updated_at FROM crm_record_mirror WHERE scope = ? AND target_id = ?')
      .get(SCOPE, 'd1') as { created_at: number; updated_at: number };
    expect(row.created_at).toBe(1_000);
    expect(row.updated_at).toBe(5_000);
    expect(store.list(SCOPE)[0]!.meta.name).toBe('v2');
  });

  it('deleteForSource removes a record (delete-cascade) and reports it', () => {
    seedThree();
    expect(store.deleteForSource(SCOPE, 'd_won')).toBe(true);
    expect(store.deleteForSource(SCOPE, 'd_won')).toBe(false);
    expect(store.list(SCOPE).map((r) => r.target_id).sort()).toEqual(['d_open_early', 'd_open_late']);
  });

  it('isolates by scope', () => {
    seedThree();
    expect(store.list('connection.api.salesforce.opportunity' as EnrichmentScope)).toEqual([]);
  });
});

describe('deleteAllForScope + countForScope (D-192 source-data-removal)', () => {
  const OTHER = 'connection.api.salesforce.opportunity' as EnrichmentScope;

  it('countForScope reflects the rows held for a scope (0 when empty)', () => {
    expect(store.countForScope(SCOPE)).toBe(0);
    seedThree();
    expect(store.countForScope(SCOPE)).toBe(3);
  });

  it('deleteAllForScope removes every row for the scope, returns the count, leaves other Sources intact', () => {
    seedThree();
    store.upsert({ scope: OTHER, target_id: 'o1', now: 1, meta: meta({ name: 'sf deal' }) });
    expect(store.deleteAllForScope(SCOPE)).toBe(3);
    expect(store.countForScope(SCOPE)).toBe(0);
    expect(store.list(SCOPE)).toEqual([]);
    expect(store.countForScope(OTHER)).toBe(1); // a different vendor/entity Source untouched
  });

  it('deleteAllForScope is idempotent — an empty/re-run scope returns 0', () => {
    expect(store.deleteAllForScope(OTHER)).toBe(0);
    seedThree();
    expect(store.deleteAllForScope(SCOPE)).toBe(3);
    expect(store.deleteAllForScope(SCOPE)).toBe(0); // re-run safe
  });
});
