/** D-149 P9 § A.5.6 — reception status projection store tests.
 *
 *  Covers:
 *    - create + findById + findByEndpoint round-trips.
 *    - recordResolved writes back the cache hash + timestamp.
 *    - invalidateResolvedCache clears the cache columns.
 *    - deleteByEndpoint drops the row.
 *    - JSON round-trip for refresh_policy + fields_visible_override. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionStatusProjectionStore } from '../storage/reception-status-projection-store.js';

const NOW = 1_700_000_000_000;

const buildDb = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return db;
};

const goodCreate = (overrides: Partial<{ projection_id: string; endpoint_id: string }> = {}) => ({
  projection_id: overrides.projection_id ?? 'p_1',
  endpoint_id: overrides.endpoint_id ?? 'e_1',
  projection_kind: 'project' as const,
  source_entity_kind: 'data.project',
  source_entity_id: 'proj-xyz',
  refresh_policy: { auto_refresh_enabled: true, refresh_interval_seconds: 60 },
  comments_enabled: false,
  shows_update_history: true,
});

describe('D-149 P9 § A.5.6 — StatusProjectionStore CRUD', () => {
  it('create persists a projection row', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    const row = store.create(goodCreate());
    expect(row.projection_id).toBe('p_1');
    expect(row.endpoint_id).toBe('e_1');
    expect(row.projection_kind).toBe('project');
    expect(row.source_entity_kind).toBe('data.project');
    expect(row.source_entity_id).toBe('proj-xyz');
    expect(row.comments_enabled).toBe(false);
    expect(row.shows_update_history).toBe(true);
    expect(row.last_resolved_payload_hash).toBeNull();
    expect(row.last_resolved_at).toBeNull();
  });

  it('findById returns the row + null on miss', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    expect(store.findById('p_1')?.projection_id).toBe('p_1');
    expect(store.findById('missing')).toBeNull();
  });

  it('findByEndpoint returns the singleton projection row', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    const found = store.findByEndpoint('e_1');
    expect(found?.projection_id).toBe('p_1');
    expect(found?.endpoint_id).toBe('e_1');
  });

  it('findByEndpoint returns null when missing', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    expect(store.findByEndpoint('missing')).toBeNull();
  });

  it('refresh_policy round-trips via JSON', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    const row = store.findByEndpoint('e_1');
    expect(row?.refresh_policy.auto_refresh_enabled).toBe(true);
    expect(row?.refresh_policy.refresh_interval_seconds).toBe(60);
  });

  it('refresh_policy with auto_refresh_enabled=false round-trips without interval', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create({
      ...goodCreate(),
      refresh_policy: { auto_refresh_enabled: false },
    });
    const row = store.findByEndpoint('e_1');
    expect(row?.refresh_policy.auto_refresh_enabled).toBe(false);
    expect(row?.refresh_policy.refresh_interval_seconds).toBeUndefined();
  });

  it('fields_visible_override round-trips when present', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create({
      ...goodCreate(),
      fields_visible_override: ['title', 'state'],
    });
    const row = store.findByEndpoint('e_1');
    expect(row?.fields_visible_override).toEqual(['title', 'state']);
  });

  it('fields_visible_override is null when omitted', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    const row = store.findByEndpoint('e_1');
    expect(row?.fields_visible_override).toBeNull();
  });

  it('metadata blob round-trips via JSON', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create({
      ...goodCreate(),
      metadata: { template_ref: 'foundation:project' },
    });
    const row = store.findByEndpoint('e_1');
    expect(row?.metadata).toEqual({ template_ref: 'foundation:project' });
  });

  it('recordResolved writes back the cache hash + timestamp', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    const outcome = store.recordResolved({
      endpoint_id: 'e_1',
      payload_hash: 'abc123',
      now: NOW,
    });
    expect(outcome).toBe('updated');
    const row = store.findByEndpoint('e_1');
    expect(row?.last_resolved_payload_hash).toBe('abc123');
    expect(row?.last_resolved_at).toBe(NOW);
  });

  it('recordResolved returns not_found when the endpoint has no projection', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    expect(
      store.recordResolved({ endpoint_id: 'missing', payload_hash: 'x', now: NOW }),
    ).toBe('not_found');
  });

  it('invalidateResolvedCache clears the hash + timestamp', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    store.recordResolved({ endpoint_id: 'e_1', payload_hash: 'abc123', now: NOW });
    const outcome = store.invalidateResolvedCache('e_1');
    expect(outcome).toBe('updated');
    const row = store.findByEndpoint('e_1');
    expect(row?.last_resolved_payload_hash).toBeNull();
    expect(row?.last_resolved_at).toBeNull();
  });

  it('invalidateResolvedCache returns not_found when the endpoint has no projection', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    expect(store.invalidateResolvedCache('missing')).toBe('not_found');
  });

  it('deleteByEndpoint removes the row', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate());
    expect(store.deleteByEndpoint('e_1')).toBe('deleted');
    expect(store.findByEndpoint('e_1')).toBeNull();
  });

  it('deleteByEndpoint returns not_found when the endpoint has no projection', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    expect(store.deleteByEndpoint('missing')).toBe('not_found');
  });

  it('handles multiple projections concurrently keyed on endpoint_id', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    store.create(goodCreate({ projection_id: 'p_1', endpoint_id: 'e_1' }));
    store.create({
      ...goodCreate({ projection_id: 'p_2', endpoint_id: 'e_2' }),
      projection_kind: 'event_plan',
      source_entity_kind: 'data.event',
      source_entity_id: 'evt-A',
    });
    expect(store.findByEndpoint('e_1')?.projection_id).toBe('p_1');
    expect(store.findByEndpoint('e_2')?.projection_id).toBe('p_2');
    expect(store.findByEndpoint('e_2')?.projection_kind).toBe('event_plan');
  });

  it('every projection kind supported in the contract round-trips', () => {
    const db = buildDb();
    const store = createReceptionStatusProjectionStore(db);
    const matrix: Array<{
      pid: string;
      kind: 'event_plan' | 'itinerary' | 'project' | 'packing_list' | 'commitment_summary' | 'custom';
      entity_kind: string;
      entity_id: string;
    }> = [
      { pid: 'e1', kind: 'event_plan', entity_kind: 'data.event', entity_id: 'E' },
      { pid: 'i1', kind: 'itinerary', entity_kind: 'data.itinerary', entity_id: 'I' },
      { pid: 'p1', kind: 'project', entity_kind: 'data.project', entity_id: 'P' },
      { pid: 'pl1', kind: 'packing_list', entity_kind: 'data.packing_list', entity_id: 'L' },
      { pid: 'c1', kind: 'commitment_summary', entity_kind: 'data.commitment', entity_id: 'C' },
      { pid: 'cu1', kind: 'custom', entity_kind: 'data.note', entity_id: 'N' },
    ];
    for (const r of matrix) {
      store.create({
        projection_id: r.pid,
        endpoint_id: `ep_${r.pid}`,
        projection_kind: r.kind,
        source_entity_kind: r.entity_kind,
        source_entity_id: r.entity_id,
        refresh_policy: { auto_refresh_enabled: false },
        comments_enabled: false,
        shows_update_history: true,
      });
    }
    for (const r of matrix) {
      const row = store.findByEndpoint(`ep_${r.pid}`);
      expect(row?.projection_kind).toBe(r.kind);
      expect(row?.source_entity_kind).toBe(r.entity_kind);
      expect(row?.source_entity_id).toBe(r.entity_id);
    }
  });
});
