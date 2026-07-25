/** D-122 Phase 4.5 — enrichment-store CRUD + cascade + resolver tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEnrichmentStore,
  EnrichmentScopeUnsupportedError,
  EnrichmentTopicUnknownError,
  EnrichmentValueInvalidError,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import { createEnrichmentResolver } from '../storage/enrichment-resolver.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'enrichment-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const validRollup = {
  interaction_count: 4,
  last_interaction: 1_700_000_000_000,
  recent_subjects: ['hello'],
  cursor_at: 1_700_000_000_000,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

const validEventRollup = {
  brief: 'meeting brief',
  attendees: ['alice@x.com'],
  related_thread_ids: [],
  generated_at: 1_700_000_000_000,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

/** Build a valid `topic_cluster` value for store-mechanics tests
 *  that don't care about field semantics — just need to satisfy the
 *  registry validator. Members and thread_ids are caller-controlled
 *  since cascade-engine tests assert on them directly. */
const validTopicCluster = (
  members: string[],
  thread_ids: string[] = members.map((m) => `t-${m}`),
) => ({
  topic_name: 'Test Cluster',
  summary: 'Stub cluster for store mechanics tests.',
  members,
  thread_ids,
  theme_tokens: ['test'],
  thread_count: thread_ids.length,
  ai_invoked: true,
  confidence: 0.75,
  computed_at: 1_700_000_000_000,
  window_ms: 90 * 24 * 60 * 60 * 1000,
});

describe('D-122 Phase 4.5 — enrichment-store upsert (Shape A)', () => {
  it('inserts a per-record row when none exists', () => {
    const out = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.refresh-contact-timeline-rollup',
    });
    expect(out._id.startsWith('enr_')).toBe(true);
    expect(out.topic).toBe('contact_timeline_rollup');
    expect(out.scope).toBe('contact');
    expect(out.target_id).toBe('bob@x.com');
    expect(out.value).toEqual(validRollup);
    expect(out.staleness_class).toBe('fresh');
  });

  it('idempotent on (topic, scope, target_id, authored_by) — second upsert replaces', () => {
    const a = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.x',
    });
    const b = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: { ...validRollup, interaction_count: 9 },
      authored_by: 'recipe.x',
    });
    expect(a._id).toBe(b._id);
    expect((b.value as { interaction_count: number }).interaction_count).toBe(9);
    expect(store.countForTopic('contact_timeline_rollup')).toBe(1);
  });

  it('different authored_by produces separate rows', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.a',
    });
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.b',
    });
    expect(store.countForTopic('contact_timeline_rollup')).toBe(2);
  });

  it('rejects unknown topics', () => {
    expect(() =>
      store.upsert({
        topic: 'not_a_topic',
        scope: 'contact',
        target_id: 'bob@x.com',
        value: validRollup,
        authored_by: 'r',
      }),
    ).toThrow(EnrichmentTopicUnknownError);
  });

  it('rejects unsupported scope for the topic', () => {
    expect(() =>
      store.upsert({
        topic: 'contact_timeline_rollup',
        scope: 'mail',
        target_id: 'msg-1',
        value: validRollup,
        authored_by: 'r',
      }),
    ).toThrow(EnrichmentScopeUnsupportedError);
  });

  it('rejects values that fail the registry validator', () => {
    expect(() =>
      store.upsert({
        topic: 'contact_timeline_rollup',
        scope: 'contact',
        target_id: 'bob@x.com',
        value: { interaction_count: 'four' },
        authored_by: 'r',
      }),
    ).toThrow(EnrichmentValueInvalidError);
  });
});

describe('D-122 Phase 4.5 — enrichment-store upsert (Shape B)', () => {
  it('inserts a derived-entity row keyed on the supplied id', () => {
    const out = store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_xyz',
      value: validTopicCluster(['msg-1', 'msg-2']),
      authored_by: 'system.housekeeping.clusterer',
    });
    expect(out._id).toBe('cluster_xyz');
    expect(out.topic).toBe('topic_cluster');
    expect(out.scope).toBe(null);
    expect(out.target_id).toBe(null);
  });

  it('idempotent on (topic, _id) for derived entities', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_xyz',
      value: validTopicCluster(['msg-1']),
      authored_by: 'system.x',
    });
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_xyz',
      value: validTopicCluster(['msg-1', 'msg-2']),
      authored_by: 'system.y',
    });
    expect(store.countForTopic('topic_cluster')).toBe(1);
    const row = store.getDerived('topic_cluster', 'cluster_xyz');
    expect(row).not.toBeNull();
    expect((row!.value as { members: string[] }).members).toEqual(['msg-1', 'msg-2']);
    // Last-write wins on authored_by for derived entities (different
    // producers can take over the same id; the registry knows which
    // producer is canonical).
    expect(row!.authored_by).toBe('system.y');
  });
});

describe('D-122 Phase 4.5 — enrichment-store list / get / delete', () => {
  it('list filters by topic + scope + target_id', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'r',
    });
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-2',
      value: validEventRollup,
      authored_by: 'r',
    });
    const filtered = store.list({ topic: 'calendar_event_rollup', target_id: 'evt-1' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.target_id).toBe('evt-1');
  });

  it('list defaults to fresh-only', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'r',
    });
    store.markStaleByAuthor('r');
    expect(store.list({ topic: 'calendar_event_rollup' }).length).toBe(0);
    expect(store.list({ topic: 'calendar_event_rollup', fresh_only: false }).length).toBe(1);
  });

  it('getByRecord returns null for unknown topic', () => {
    expect(store.getByRecord('not_a_topic', 'contact', 'x', 'y')).toBe(null);
  });

  it('deleteForSource drops every shape-A row at (scope, target_id)', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'r',
    });
    expect(store.deleteForSource('calendar', 'evt-1')).toBe(1);
    expect(store.countForTopic('calendar_event_rollup')).toBe(0);
  });

  it('reset(topic) hard-deletes every row of the topic', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'a',
      value: validTopicCluster(['m1']),
      authored_by: 'r',
    });
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'b',
      value: validTopicCluster(['m1']),
      authored_by: 'r',
    });
    expect(store.reset('topic_cluster')).toBe(2);
    expect(store.countForTopic('topic_cluster')).toBe(0);
  });

  it('count returns the warehouse-wide total', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'r',
    });
    expect(store.count()).toBe(1);
  });
});

describe('D-122 Phase 4.5 — enrichment-store stale / sidecar', () => {
  it('markStaleByAuthor flags every authored row + drops sidecars', () => {
    store.upsert({
      topic: 'embedding',
      scope: 'mail',
      target_id: 'msg-1',
      value: { dimensions: 384, model: 'text-embedding-3-small' },
      authored_by: 'system.embedder',
      sidecar_vector: Buffer.from([1, 2, 3]),
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM data_enrichment_vector_index').get() as { n: number };
    expect(before.n).toBe(1);
    expect(store.markStaleByAuthor('system.embedder')).toBe(1);
    const after = db.prepare('SELECT COUNT(*) AS n FROM data_enrichment_vector_index').get() as { n: number };
    expect(after.n).toBe(0);
  });

  it('FK CASCADE drops the sidecar when the main row is deleted', () => {
    const row = store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg-2',
      value: { text: 'short summary' },
      authored_by: 'system.summarizer',
      sidecar_text: 'short summary',
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM data_enrichment_fts').get() as { n: number };
    expect(before.n).toBe(1);
    expect(store.deleteById(row._id)).toBe(true);
    const after = db.prepare('SELECT COUNT(*) AS n FROM data_enrichment_fts').get() as { n: number };
    expect(after.n).toBe(0);
  });

  it('trimMember removes a source id from every owning row + deletes when empty', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'c1',
      value: validTopicCluster(['msg-1', 'msg-2']),
      authored_by: 'system',
    });
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'c2',
      value: validTopicCluster(['msg-1']),
      authored_by: 'system',
    });
    const counts = store.trimMember('topic_cluster', 'msg-1');
    expect(counts.trimmed).toBe(1);
    expect(counts.deleted).toBe(1);
    expect(store.countForTopic('topic_cluster')).toBe(1);
    const survivor = store.getDerived('topic_cluster', 'c1');
    expect(survivor).not.toBeNull();
    expect((survivor!.value as { members: string[] }).members).toEqual(['msg-2']);
  });
});

describe('D-122 Phase 4.5 — cascade engine', () => {
  it('cascadeForSourceDelete drops dependent rows', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'r',
    });
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForSourceDelete('calendar', 'evt-1');
    expect(result.rows_deleted).toBeGreaterThanOrEqual(1);
    expect(store.countForTopic('calendar_event_rollup')).toBe(0);
  });

  it('cascadeForSourceDelete trims members_list rows', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster',
      value: validTopicCluster(['msg-1', 'msg-2']),
      authored_by: 'sys',
    });
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForSourceDelete('mail', 'msg-1');
    expect(result.members_trimmed).toBe(1);
    const row = store.getDerived('topic_cluster', 'cluster');
    expect((row!.value as { members: string[] }).members).toEqual(['msg-2']);
  });

  it('cascadeForSourceDelete drops aggregate rows (D-145 § A.7.9)', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'r',
    });
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForSourceDelete('contact', 'bob@x.com');
    // D-145 § A.7.9 — every per-record policy is current_state;
    // aggregate rows cascade-delete on source delete alongside
    // dependent rows. Independent policy stays no-op (no linkage).
    expect(result.rows_deleted).toBeGreaterThanOrEqual(1);
    expect(store.countForTopic('contact_timeline_rollup')).toBe(0);
  });

  it('cascadeForSourceUpdate marks dependent rows stale', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'r',
    });
    const cascade = createEnrichmentCascade(store);
    cascade.cascadeForSourceUpdate('calendar', 'evt-1', 'new_hash');
    const fresh = store.list({ topic: 'calendar_event_rollup', target_id: 'evt-1' });
    expect(fresh.length).toBe(0);
    const all = store.list({
      topic: 'calendar_event_rollup',
      target_id: 'evt-1',
      fresh_only: false,
    });
    expect(all.length).toBe(1);
    expect(all[0]!.staleness_class).toBe('stale');
  });

  it('cascadeForRecipeUpgrade marks every authored row stale', () => {
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-1',
      value: validEventRollup,
      authored_by: 'recipe.x',
    });
    store.upsert({
      topic: 'calendar_event_rollup',
      scope: 'calendar',
      target_id: 'evt-2',
      value: validEventRollup,
      authored_by: 'recipe.x',
    });
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForRecipeUpgrade('recipe.x');
    expect(result.rows_marked_stale).toBe(2);
  });
});

describe('D-122 Phase 4.5 — resolver', () => {
  it('returns the value for a fully-qualified per-record ref', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'r',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['contact', 'bob@x.com', 'contact_timeline_rollup']);
    expect(out.kind).toBe('value');
    if (out.kind === 'value') expect(out.value).toEqual(validRollup);
  });

  it('returns a record bag when the topic is omitted', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'r',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['contact', 'bob@x.com']);
    expect(out.kind).toBe('list');
    if (out.kind === 'list') expect(out.records.length).toBe(1);
  });

  it('returns a list for a derived-entity wildcard', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'a',
      value: validTopicCluster(['m1']),
      authored_by: 'sys',
    });
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'b',
      value: validTopicCluster(['m2']),
      authored_by: 'sys',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['topic_cluster', '*']);
    expect(out.kind).toBe('list');
    if (out.kind === 'list') expect(out.records.length).toBe(2);
  });

  it('drills into derived-entity value fields', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'a',
      value: validTopicCluster(['msg-1']),
      authored_by: 'sys',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['topic_cluster', 'a', 'topic_name']);
    expect(out.kind).toBe('value');
    if (out.kind === 'value') expect(out.value).toBe('Test Cluster');
  });

  it('returns null for unknown scope or topic', () => {
    const resolver = createEnrichmentResolver(store);
    expect(resolver.resolve(['not_a_scope']).kind).toBe('null');
    expect(resolver.resolve(['mail', 'msg-1', 'not_a_topic']).kind).toBe('null');
  });

  it('returns null for a per-record topic addressed at the wrong scope', () => {
    const resolver = createEnrichmentResolver(store);
    // contact_timeline_rollup is contact-only, not mail.
    expect(resolver.resolve(['mail', 'msg-1', 'contact_timeline_rollup']).kind).toBe('null');
  });

  it('lookup returns the registry definition or null', () => {
    const resolver = createEnrichmentResolver(store);
    expect(resolver.lookup('contact_timeline_rollup')!.policy).toBe('aggregate');
    expect(resolver.lookup('not_a_topic')).toBe(null);
  });
});
