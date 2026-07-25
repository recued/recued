/** D-192 source-data-removal slice 3b — the connection/vendor-keyed CRM
 *  footprint (D-190 platform-reference mirror + enrichments).
 *
 *  The mirror scope `connection.api.<vendor>.<entity>` is SHARED across a
 *  vendor's connections; the per-connection discriminator lives in the
 *  `target_id` (`<vendor>_<entity>_<connection>_<native>`, D-190). So both the
 *  opt-in purge AND the always-on connection-delete tombstone must cut by the
 *  connection's target_id PREFIX — never the whole scope, which would wipe a
 *  SIBLING same-vendor connection. The load-bearing assertion throughout:
 *  connection `acme` must NOT match connection `acme2`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeConnectionTargetIdPrefix,
  composePlatformRecordTargetId,
  type EnrichmentMeta,
} from '@recued/contracts';

import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import { purgeConnectionData } from '../source-mirror/connection-purge.js';

const DEAL_SCOPE = 'connection.api.hubspot.deal' as const;
const now = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-crm-purge-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── the prefix helper ───────────────────────────────────────────

describe('composeConnectionTargetIdPrefix', () => {
  it('is composePlatformRecordTargetId with the native id stripped, trailing _ intact', () => {
    expect(composeConnectionTargetIdPrefix('hubspot', 'deal', 'acme')).toBe('hubspot_deal_acme_');
    // the prefix is a true prefix of every one of that connection's target_ids
    const tid = composePlatformRecordTargetId('hubspot', 'deal', 'acme', '47291');
    expect(tid.startsWith(composeConnectionTargetIdPrefix('hubspot', 'deal', 'acme'))).toBe(true);
    // and NOT of a sibling connection's
    const tid2 = composePlatformRecordTargetId('hubspot', 'deal', 'acme2', '47291');
    expect(tid2.startsWith(composeConnectionTargetIdPrefix('hubspot', 'deal', 'acme'))).toBe(false);
  });
});

// ── CRM mirror per-connection delete/count ──────────────────────

describe('crm-record-mirror deleteForConnection / countForConnection', () => {
  let mirror: CrmRecordMirrorStore;
  const meta = (name: string): EnrichmentMeta => ({ snapshot_at: now, snapshot_hash: `h:${name}`, name });
  const seed = (conn: string, native: string): void => {
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'deal', conn, native),
      meta: meta(`${conn}-${native}`),
      now,
    });
  };

  beforeEach(() => {
    ensureCrmRecordMirrorSchema(db);
    mirror = createCrmRecordMirrorStore(db);
    seed('acme', '1');
    seed('acme', '2');
    seed('acme2', '9'); // sibling same-vendor connection — must survive
  });

  it('deletes ONLY the named connection (acme != acme2), count matches', () => {
    const prefix = composeConnectionTargetIdPrefix('hubspot', 'deal', 'acme');
    expect(mirror.countForConnection(DEAL_SCOPE, prefix)).toBe(2);
    expect(mirror.deleteForConnection(DEAL_SCOPE, prefix)).toBe(2);
    expect(mirror.countForConnection(DEAL_SCOPE, prefix)).toBe(0);
    // the sibling connection's row survives (the whole-scope delete would kill it)
    expect(mirror.list(DEAL_SCOPE)).toHaveLength(1);
    expect(mirror.countForConnection(DEAL_SCOPE, composeConnectionTargetIdPrefix('hubspot', 'deal', 'acme2'))).toBe(1);
  });
});

// ── enrichment per-connection hard-delete ───────────────────────

describe('enrichment deleteForScopeAndTargetPrefix', () => {
  let store: EnrichmentStore;
  const seedDeal = (conn: string, native: string): void => {
    store.upsert({
      topic: 'deal_health_score',
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'deal', conn, native),
      value: { score: 50, confidence: 0.5, reasoning: 'seed', signals: [] },
      authored_by: 'system.housekeeping.deal_health_score',
      meta: { snapshot_at: now, snapshot_hash: `h:${conn}${native}` },
    });
  };

  beforeEach(() => {
    store = createEnrichmentStore(db);
    seedDeal('acme', '1');
    seedDeal('acme2', '9');
  });

  it('hard-deletes ONLY the named connection (acme != acme2)', () => {
    const removed = store.deleteForScopeAndTargetPrefix(
      DEAL_SCOPE,
      composeConnectionTargetIdPrefix('hubspot', 'deal', 'acme'),
    );
    expect(removed).toBe(1);
    // acme gone, acme2 survives
    expect(store.listByTarget(DEAL_SCOPE, composePlatformRecordTargetId('hubspot', 'deal', 'acme', '1'))).toHaveLength(0);
    expect(store.listByTarget(DEAL_SCOPE, composePlatformRecordTargetId('hubspot', 'deal', 'acme2', '9'))).toHaveLength(1);
  });
});

// ── the tombstone over-reach fix (the headline regression) ──────

describe('cascadeForConnectionDelete — per-connection tombstone (over-reach fix)', () => {
  let store: EnrichmentStore;
  const seedDeal = (conn: string, native: string): void => {
    store.upsert({
      topic: 'deal_health_score',
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'deal', conn, native),
      value: { score: 50, confidence: 0.5, reasoning: 'seed', signals: [] },
      authored_by: 'system.housekeeping.deal_health_score',
      meta: { snapshot_at: now, snapshot_hash: `h:${conn}${native}` },
    });
  };
  const tombstonedAt = (conn: string, native: string): number | null =>
    (
      db
        .prepare(`SELECT tombstoned_at FROM data_enrichment WHERE scope = ? AND target_id = ?`)
        .get(DEAL_SCOPE, composePlatformRecordTargetId('hubspot', 'deal', conn, native)) as {
        tombstoned_at: number | null;
      }
    ).tombstoned_at;

  beforeEach(() => {
    store = createEnrichmentStore(db);
    seedDeal('acme', '1');
    seedDeal('acme2', '9'); // a SECOND HubSpot connection under the same vendor scope
  });

  it('deleting one HubSpot connection does NOT tombstone a sibling HubSpot connection', () => {
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForConnectionDelete('api', 'acme', 'hubspot');

    // acme's row tombstoned…
    expect(result.rows_tombstoned).toBe(1);
    expect(tombstonedAt('acme', '1')).not.toBeNull();
    // …acme2's row UNTOUCHED (the pre-fix whole-scope walk would have tombstoned it too)
    expect(tombstonedAt('acme2', '9')).toBeNull();
  });
});

// ── purgeConnectionData CRM fan-out ─────────────────────────────

describe('purgeConnectionData — CRM leg', () => {
  let mirror: CrmRecordMirrorStore;
  let enrichment: EnrichmentStore;

  const seedMirror = (conn: string, native: string): void => {
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'deal', conn, native),
      meta: { snapshot_at: now, snapshot_hash: `h:${conn}${native}`, name: `${conn}` },
      now,
    });
  };
  const seedEnrichment = (conn: string, native: string): void => {
    enrichment.upsert({
      topic: 'deal_health_score',
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'deal', conn, native),
      value: { score: 50, confidence: 0.5, reasoning: 'seed', signals: [] },
      authored_by: 'system.housekeeping.deal_health_score',
      meta: { snapshot_at: now, snapshot_hash: `e:${conn}${native}` },
    });
  };

  beforeEach(() => {
    ensureCrmRecordMirrorSchema(db);
    mirror = createCrmRecordMirrorStore(db);
    enrichment = createEnrichmentStore(db);
    seedMirror('acme', '1');
    seedMirror('acme2', '9');
    seedEnrichment('acme', '1');
    seedEnrichment('acme2', '9');
  });

  const deps = () => ({
    db,
    // no registry Sources → the source loop is empty; only the CRM leg runs
    workEntityStore: {
      listSources: () => [],
      listRecordIdentitiesForSource: () => [],
      deleteRecordsForSource: () => 0,
    },
    fileMetaStore: { deleteAllForScope: () => 0 },
    annotationStore: { cascadeDelete: () => ({ annotations_deleted: 0, links_deleted: 0 }) },
    enrichmentStore: enrichment,
    edges: { deleteForSource: () => 0 },
    crmRecordMirror: mirror,
  });

  it('purges the vendor mirror + enrichments for ONE connection, leaving the sibling', () => {
    const summary = purgeConnectionData({ connection_name: 'acme', vendor: 'hubspot' }, deps());
    expect(summary.crm_records_deleted).toBe(1);
    expect(summary.crm_enrichments_deleted).toBe(1);
    // acme2 survives
    expect(mirror.list(DEAL_SCOPE)).toHaveLength(1);
    expect(
      enrichment.listByTarget(DEAL_SCOPE, composePlatformRecordTargetId('hubspot', 'deal', 'acme2', '9')),
    ).toHaveLength(1);
  });

  it('skips the CRM leg for a connection with no vendor', () => {
    const summary = purgeConnectionData({ connection_name: 'acme' }, deps());
    expect(summary.crm_records_deleted).toBe(0);
    expect(summary.crm_enrichments_deleted).toBe(0);
    expect(mirror.list(DEAL_SCOPE)).toHaveLength(2);
  });

  it('fans across every CRM entity of the vendor (deal + contact + company), still per-connection', () => {
    // seed a CONTACT + COMPANY mirror row for acme (multi-entity fan-out) + a
    // sibling contact for acme2 that must survive.
    const CONTACT_SCOPE = 'connection.api.hubspot.contact' as const;
    const COMPANY_SCOPE = 'connection.api.hubspot.company' as const;
    for (const [scope, entity] of [
      [CONTACT_SCOPE, 'contact'],
      [COMPANY_SCOPE, 'company'],
    ] as const) {
      mirror.upsert({
        scope,
        target_id: composePlatformRecordTargetId('hubspot', entity, 'acme', 'x'),
        meta: { snapshot_at: now, snapshot_hash: `h:${entity}` },
        now,
      });
    }
    mirror.upsert({
      scope: CONTACT_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'contact', 'acme2', 'y'),
      meta: { snapshot_at: now, snapshot_hash: 'h:sibling' },
      now,
    });

    const summary = purgeConnectionData({ connection_name: 'acme', vendor: 'hubspot' }, deps());
    // acme: 1 deal + 1 contact + 1 company
    expect(summary.crm_records_deleted).toBe(3);
    // sibling acme2 contact + acme2 deal survive
    expect(mirror.countForConnection(CONTACT_SCOPE, composeConnectionTargetIdPrefix('hubspot', 'contact', 'acme2'))).toBe(1);
    expect(mirror.list(DEAL_SCOPE)).toHaveLength(1); // acme2's deal
  });
});
