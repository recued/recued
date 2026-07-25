/** D-136 P6 — Codex review fixes regression tests.
 *
 *  Four findings from Codex review of `cb716ca`:
 *    [P1] Tombstone clears `meta` (CRM producers' `meta IS NOT NULL`
 *         filter excludes tombstoned vendor rows; otherwise the next
 *         producer cycle resurrects deleted-connection enrichments).
 *    [P2] Vendor lookup reads `config_json.vendor` (not `subtype`),
 *         since HubSpot/Salesforce enroll with `subtype` undefined.
 *    [P2] `listStaleRowsForReDerive` filters retry-armed-future +
 *         permanently_failed + tombstoned + pinned + superseded rows
 *         at SQL level so the stale-sweep batch isn't starved by
 *         ineligible rows ahead of older eligible work.
 *    [P2] `trimMember` filters `value IS NOT NULL` so tombstoned rows
 *         (NULL value after P6) don't trip JSON.parse(null).field.
 *
 *  Spec: docs/d-136-spec.md §A.5 + §A.6 + audit §10.2. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleConnectionDelete } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import {
  composeRetryAtToken,
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p6-codex-fixes-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DEAL = (
  override: Record<string, unknown> = {},
): { score: number; signals: string[]; reasoning: string } => ({
  score: 72,
  signals: ['email engagement'],
  reasoning: 'Steady touch + meeting next week',
  ...override,
});

// ────────────────────────────────────────────────────────────────
// Fix #1 — Tombstone clears `meta` so CRM producers don't resurrect
// ────────────────────────────────────────────────────────────────

describe('[P1] tombstoneRowIds clears meta column', () => {
  it('NULLs meta alongside value on tombstone', () => {
    const written = store.upsert({
      topic: 'deal_health_score',
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_1',
      authored_by: 'system.housekeeping.deal_health_score',
      value: DEAL(),
      meta: {
        snapshot_at: NOW - 60_000,
        snapshot_hash: 'h1',
        name: 'Acme Q3',
        amount: 50_000,
        stage: 'open',
      },
    } as never);
    expect(written.meta).not.toBeNull();

    store.tombstoneRowIds([written._id], 'cascade_delete');
    const after = store
      .list({ topic: 'deal_health_score', fresh_only: false })
      .find((r) => r._id === written._id)!;
    expect(after.value).toBeNull();
    expect(after.meta).toBeNull();
    expect(after.tombstoned_at).toBe(NOW);
    expect(after._id).toBe(written._id);             // _id preserved
  });

  it('cascade vendor cleanup tombstones meta — producers querying meta IS NOT NULL no longer see the row', () => {
    const written = store.upsert({
      topic: 'deal_health_score',
      scope: 'connection.api.hubspot.deal',
      // D-192 slice 3b — the cascade now tombstones by the connection-qualified
      // `target_id` prefix (`<vendor>_<entity>_<connection>_`), matching how
      // every D-190 reconciler/webhook composes ids. `my_hubspot` is the
      // connection the delete below targets.
      target_id: 'hubspot_deal_my_hubspot_1',
      authored_by: 'system.housekeeping.deal_health_score',
      value: DEAL(),
      meta: {
        snapshot_at: NOW - 60_000,
        snapshot_hash: 'h1',
        name: 'Acme Q3',
      },
    } as never);

    const cascade = createEnrichmentCascade(store);
    cascade.cascadeForConnectionDelete('api', 'my_hubspot', 'hubspot');

    // Producers (attribution-signal etc.) read `WHERE meta IS NOT NULL`;
    // after the substrate fix the tombstoned row has meta = NULL so it
    // doesn't surface to the next producer cycle.
    const visible = db
      .prepare(
        `SELECT _id FROM data_enrichment
           WHERE scope = 'connection.api.hubspot.deal'
             AND target_id IS NOT NULL
             AND meta IS NOT NULL`,
      )
      .all() as Array<{ _id: string }>;
    expect(visible.find((r) => r._id === written._id)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Fix #2 — Vendor lookup from config_json.vendor
// ────────────────────────────────────────────────────────────────

describe('[P2] handleConnectionDelete reads vendor from config.vendor', () => {
  it('passes vendor=hubspot when subtype is undefined and config.vendor=hubspot', async () => {
    const connDir = mkdtempSync(join(tmpdir(), 'd-136-p6-conn-vendor-'));
    const connDb = new Database(join(connDir, 'conn.db'));
    const connStore = createConnectionStore(connDb);
    connStore.upsert({
      kind: 'api',
      name: 'my_hubspot',
      // no subtype — real HubSpot enrollment shape
      display_name: 'HubSpot',
      config_json: JSON.stringify({ vendor: 'hubspot', base_url: 'https://api.hubapi.com' }),
      auth_ciphertext: 'placeholder',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const cascadeFn = vi.fn();
    await handleConnectionDelete(
      { store: connStore, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'my_hubspot' },
    );
    expect(cascadeFn).toHaveBeenCalledWith('api', 'my_hubspot', 'hubspot');
    connDb.close();
    rmSync(connDir, { recursive: true, force: true });
  });

  it('falls back to subtype when config.vendor is missing', async () => {
    const connDir = mkdtempSync(join(tmpdir(), 'd-136-p6-conn-fallback-'));
    const connDb = new Database(join(connDir, 'conn.db'));
    const connStore = createConnectionStore(connDb);
    connStore.upsert({
      kind: 'api',
      name: 'rest_api',
      subtype: 'rest',
      display_name: 'Generic REST',
      config_json: JSON.stringify({ base_url: 'https://example.com' }),
      auth_ciphertext: 'placeholder',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const cascadeFn = vi.fn();
    await handleConnectionDelete(
      { store: connStore, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'rest_api' },
    );
    expect(cascadeFn).toHaveBeenCalledWith('api', 'rest_api', 'rest');
    connDb.close();
    rmSync(connDir, { recursive: true, force: true });
  });

  it('passes undefined when neither config.vendor nor subtype set', async () => {
    const connDir = mkdtempSync(join(tmpdir(), 'd-136-p6-conn-none-'));
    const connDb = new Database(join(connDir, 'conn.db'));
    const connStore = createConnectionStore(connDb);
    connStore.upsert({
      kind: 'api',
      name: 'unmarked',
      display_name: 'unmarked',
      config_json: '{}',
      auth_ciphertext: 'placeholder',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const cascadeFn = vi.fn();
    await handleConnectionDelete(
      { store: connStore, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'unmarked' },
    );
    expect(cascadeFn).toHaveBeenCalledWith('api', 'unmarked', undefined);
    connDb.close();
    rmSync(connDir, { recursive: true, force: true });
  });

  it('handles malformed config_json without throwing', async () => {
    const connDir = mkdtempSync(join(tmpdir(), 'd-136-p6-conn-bad-'));
    const connDb = new Database(join(connDir, 'conn.db'));
    const connStore = createConnectionStore(connDb);
    connStore.upsert({
      kind: 'api',
      name: 'broken',
      subtype: 'rest',
      display_name: 'broken',
      config_json: 'not-json',
      auth_ciphertext: 'placeholder',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const cascadeFn = vi.fn();
    const out = await handleConnectionDelete(
      { store: connStore, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'broken' },
    );
    expect(out.deleted).toBe(true);
    // Falls back to subtype when config_json doesn't parse.
    expect(cascadeFn).toHaveBeenCalledWith('api', 'broken', 'rest');
    connDb.close();
    rmSync(connDir, { recursive: true, force: true });
  });
});

// ────────────────────────────────────────────────────────────────
// Fix #3 — Stale-sweep eligibility filter at SQL level
// ────────────────────────────────────────────────────────────────

describe('[P2] listStaleRowsForReDerive — eligibility filter', () => {
  const seedStale = (target_id: string, lap: string | null = null): string => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id,
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    // Force into the relevant ineligible/eligible state.
    db.prepare(
      `UPDATE data_enrichment SET staleness_class = 'stale', lifecycle_action_pending = ? WHERE _id = ?`,
    ).run(lap, r._id);
    return r._id;
  };

  it('returns NULL-LAP stale rows', () => {
    seedStale('mail_1', null);
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.target_id).toBe('mail_1');
  });

  it('returns recompute-LAP stale rows', () => {
    seedStale('mail_1', 'recompute');
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(1);
  });

  it('skips permanently_failed rows', () => {
    seedStale('mail_1', 'permanently_failed');
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(0);
  });

  it('skips discard-LAP rows (drain tombstones them)', () => {
    seedStale('mail_1', 'discard');
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(0);
  });

  it('skips retry-armed rows whose backoff window has not opened', () => {
    seedStale('mail_1', composeRetryAtToken(NOW + 60_000));
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(0);
  });

  it('returns retry-armed rows whose backoff window has passed', () => {
    seedStale('mail_1', composeRetryAtToken(NOW - 60_000));
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(1);
  });

  it('does not starve eligible rows behind a batch of ineligible ones', () => {
    // Seed 50 retry-armed-future rows + 1 eligible row.
    for (let i = 0; i < 50; i += 1) {
      seedStale(`armed_${String(i).padStart(2, '0')}`, composeRetryAtToken(NOW + 60_000));
    }
    seedStale('eligible', null);

    // Without the SQL filter, the batch of 50 ineligible rows would
    // consume the entire LIMIT; the eligible row would never surface.
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    const targets = out.map((r) => r.target_id);
    expect(targets).toContain('eligible');
  });

  it('skips tombstoned rows', () => {
    const id = seedStale('mail_1', null);
    store.tombstoneRowIds([id], 'cascade_delete');
    const out = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(out).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Fix #4 — trimMember NULL-safe
// ────────────────────────────────────────────────────────────────

const TOPIC_CLUSTER_VALUE = (
  override: Record<string, unknown> = {},
): Record<string, unknown> => ({
  topic_name: 'cluster_alpha',
  summary: 'cluster summary',
  thread_ids: ['t1'],
  theme_tokens: ['alpha', 'beta'],
  thread_count: 1,
  ai_invoked: false,
  computed_at: NOW,
  window_ms: 30 * 24 * 60 * 60 * 1000,
  members: ['mail_1', 'mail_2'],
  ...override,
});

describe('[P2] trimMember filters NULL-value rows', () => {
  it('does not throw when a tombstoned members_list row exists', () => {
    const r = store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'tc_alpha',
      authored_by: 'system.housekeeping.topic_cluster',
      value: TOPIC_CLUSTER_VALUE(),
    } as never);
    store.tombstoneRowIds([r._id], 'cascade_delete');

    // Without the value-NULL filter in trimMember, the next call would
    // throw TypeError on `JSON.parse(null).members`.
    expect(() => store.trimMember('topic_cluster', 'mail_1')).not.toThrow();
    const result = store.trimMember('topic_cluster', 'mail_1');
    // Tombstoned row contributes nothing to the trim — neither
    // trimmed nor deleted.
    expect(result.trimmed).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('still trims members from non-tombstoned rows', () => {
    const r = store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'tc_alpha',
      authored_by: 'system.housekeeping.topic_cluster',
      value: TOPIC_CLUSTER_VALUE(),
    } as never);
    const result = store.trimMember('topic_cluster', 'mail_1');
    expect(result.trimmed).toBe(1);
    expect(result.deleted).toBe(0);
    const after = store.list({ topic: 'topic_cluster', fresh_only: false })[0]!;
    expect((after.value as { members: string[] }).members).toEqual(['mail_2']);
    expect(after._id).toBe(r._id);
  });

  it('deletes members_list rows whose final member is removed', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'tc_solo',
      authored_by: 'system.housekeeping.topic_cluster',
      value: TOPIC_CLUSTER_VALUE({ members: ['mail_1'] }),
    } as never);
    const result = store.trimMember('topic_cluster', 'mail_1');
    expect(result.trimmed).toBe(0);
    expect(result.deleted).toBe(1);
  });
});
