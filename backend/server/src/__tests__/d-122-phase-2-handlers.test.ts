/** D-122 Phase 2 — handler-level tests for the five graph-builder
 *  kernel ingredients.
 *
 *  Manifest existence + shape is covered by `kernel-manifests.test.ts`
 *  linting `KERNEL_MANIFESTS`; this file exercises the server-
 *  side behavior the kernel dispatcher slots route into:
 *
 *    - `handleAnnotationCreate` (annotation-handler.ts) — upsert
 *      semantics on (target_collection, target_id, key), audit
 *      emission, error mapping.
 *    - `handleLinkCreate` (annotation-handler.ts) — upsert semantics
 *      on (from, to, role), confidence + evidence pass-through with
 *      clamp + truncation, audit emission.
 *    - `handleMailThreadRead` (mail-thread-handler.ts) — thread
 *      assembly, ordering, max_messages cap, missing-instance error.
 *    - `handleTimelineReadFromRecipe` (timeline-recipe-handler.ts) —
 *      shape passthrough to handleTimelineRequest, BAD_INPUT on
 *      missing entity.
 *
 *  `contact-upsert` already has full coverage in the existing
 *  contact-store / contact-handler tests — this file adds one
 *  smoke-test confirming the dispatcher shim surfaces a stamped
 *  ContactRecord. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';
import type { CollectionRecord } from '@recued/contracts';
import type { ActivityEntry, AuditEntry, AuditLogStore } from '@recued/storage';

import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import {
  handleAnnotationCreate,
  handleLinkCreate,
  type AnnotationRpcDeps,
} from '../annotation-handler.js';
import {
  handleMailThreadRead,
  type MailThreadHandlerDeps,
} from '../mail-thread-handler.js';
import { handleTimelineReadFromRecipe } from '../timeline-recipe-handler.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';

// ────────────────────────────────────────────────────────────────
// Test scaffolding
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let store: AnnotationStore;
let auditEntries: Array<{ action: string; target: string; detail?: string }>;
let auditLog: AuditLogStore;
let deps: AnnotationRpcDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-122-handlers-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // The annotation + link tables are created by createAnnotationStore's
  // ensureAnnotationSchema call; the D-122 fresh-install CREATE TABLE
  // already includes confidence + evidence columns.
  const blobs = createBlobStore(join(dir, 'blobs'));
  let counter = 0;
  store = createAnnotationStore({
    db,
    blobs,
    now: () => 1_000_000 + counter,
    newId: () => `id-${++counter}`,
  });
  // No-op stub mirroring AuditLogStore's `logActivity` shape — we
  // capture into an array for assertions and skip every other method
  // (handler doesn't touch them).
  auditEntries = [];
  auditLog = {
    logActivity: async (entry: ActivityEntry) => {
      auditEntries.push({
        action: entry.action,
        target: entry.target,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      });
    },
  } as unknown as AuditLogStore;
  deps = { store, auditLog };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// handleAnnotationCreate
// ────────────────────────────────────────────────────────────────

describe('handleAnnotationCreate', () => {
  const baseInput = {
    target_collection: 'data.contact',
    target_id: 'jane@acme.com',
    key: 'company',
    value: 'Acme',
    authored_by_recipe_id: 'enrich-contact-from-thread',
    source_record_hash: 'src-1',
    recipe_hash: 'rec-1',
  };

  it('writes a new annotation row + emits audit', async () => {
    const res = await handleAnnotationCreate(deps, { ...baseInput });
    expect(res.annotation.target_collection).toBe('data.contact');
    expect(res.annotation.target_id).toBe('jane@acme.com');
    expect(res.annotation.key).toBe('company');
    expect(res.annotation.value).toBe('Acme');
    expect(res.annotation_id).toBe(res.annotation._id);
    expect(auditEntries).toEqual([{
      action: 'annotation_write',
      target: 'data.contact/jane@acme.com#company',
      detail: 'author=rpc upsert=true bytes=6',
    }]);
  });

  it('upsert: re-running on (target, key) leaves exactly one row', async () => {
    await handleAnnotationCreate(deps, { ...baseInput, value: 'Acme' });
    await handleAnnotationCreate(deps, { ...baseInput, value: 'Acme Inc' });
    const annotations = await store.listAnnotations({
      target_collection: 'data.contact',
      target_id: 'jane@acme.com',
      key: 'company',
    });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].value).toBe('Acme Inc');
  });

  it('ignores inherited annotation value fields', async () => {
    const args = Object.create({ value: 'Inherited Inc' });
    Object.assign(args, {
      ...baseInput,
      value: undefined,
    });
    delete args.value;

    const res = await handleAnnotationCreate(deps, args);

    expect(res.annotation.value).toBeNull();
  });

  it('upsert preserves rows with a different key (per-(target,key) scope)', async () => {
    await handleAnnotationCreate(deps, { ...baseInput, key: 'company', value: 'Acme' });
    await handleAnnotationCreate(deps, { ...baseInput, key: 'role', value: 'CTO' });
    await handleAnnotationCreate(deps, { ...baseInput, key: 'company', value: 'Acme Inc' });
    const annotations = await store.listAnnotations({
      target_collection: 'data.contact',
      target_id: 'jane@acme.com',
    });
    expect(annotations.map((a) => a.key).sort()).toEqual(['company', 'role']);
  });

  it('rejects missing target_collection / target_id', async () => {
    await expect(
      handleAnnotationCreate(deps, { ...baseInput, target_collection: '' as unknown as undefined } as never),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing source_record_hash', async () => {
    const { source_record_hash: _, ...withoutHash } = baseInput;
    await expect(
      handleAnnotationCreate(deps, withoutHash as unknown as Record<string, unknown>),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('forwards event_at when supplied (bistemporal stamping)', async () => {
    const eventAt = 1_700_000_000_000;
    const res = await handleAnnotationCreate(deps, {
      ...baseInput,
      event_at: eventAt,
    });
    expect(res.annotation.event_at).toBe(eventAt);
  });
});

// ────────────────────────────────────────────────────────────────
// handleLinkCreate
// ────────────────────────────────────────────────────────────────

describe('handleLinkCreate', () => {
  const baseInput = {
    from_collection: 'data.mail',
    from_id: 'msg-abc',
    to_collection: 'data.contact',
    to_id: 'jane@acme.com',
    role: 'extraction.derived_contact',
    authored_by_recipe_id: 'extract-contact-from-mail',
  };

  it('writes a new link row + emits audit', async () => {
    const res = await handleLinkCreate(deps, { ...baseInput });
    expect(res.link.from_collection).toBe('data.mail');
    expect(res.link.to_collection).toBe('data.contact');
    expect(res.link.role).toBe('extraction.derived_contact');
    expect(auditEntries).toEqual([{
      action: 'link_write',
      target: 'data.mail/msg-abc extraction.derived_contact data.contact/jane@acme.com',
      detail: 'author=rpc upsert=true',
    }]);
  });

  it('upsert: re-running on (from, to, role) leaves exactly one row', async () => {
    await handleLinkCreate(deps, baseInput);
    await handleLinkCreate(deps, baseInput);
    const links = await store.listLinks({
      from_collection: 'data.mail',
      from_id: 'msg-abc',
      to_collection: 'data.contact',
      to_id: 'jane@acme.com',
      role: 'extraction.derived_contact',
    });
    expect(links).toHaveLength(1);
  });

  it('upsert: concurrent duplicate starts converge on one stable link id', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => handleLinkCreate(deps, baseInput)),
    );
    expect(new Set(results.map(({ link }) => link._id)).size).toBe(1);
    const links = await store.listLinks({
      from_collection: 'data.mail',
      from_id: 'msg-abc',
      to_collection: 'data.contact',
      to_id: 'jane@acme.com',
      role: 'extraction.derived_contact',
    });
    expect(links).toHaveLength(1);
  });

  it('upsert preserves rows under different role on the same endpoints', async () => {
    await handleLinkCreate(deps, baseInput);
    await handleLinkCreate(deps, { ...baseInput, role: 'extraction.thread_participant' });
    await handleLinkCreate(deps, baseInput);
    const links = await store.outboundLinks('data.mail', 'msg-abc');
    expect(links.map((l) => l.role).sort()).toEqual([
      'extraction.derived_contact',
      'extraction.thread_participant',
    ]);
  });

  it('persists confidence + evidence on the row', async () => {
    const res = await handleLinkCreate(deps, {
      ...baseInput,
      confidence: 0.82,
      evidence: 'matched on subject + attendee overlap',
    });
    expect(res.link.confidence).toBe(0.82);
    expect(res.link.evidence).toBe('matched on subject + attendee overlap');
    // Upsert clamp on second write — fresh confidence overrides
    const res2 = await handleLinkCreate(deps, {
      ...baseInput,
      confidence: 0.95,
      evidence: 'after re-extraction',
    });
    expect(res2.link.confidence).toBe(0.95);
    expect(res2.link.evidence).toBe('after re-extraction');
  });

  it('clamps confidence outside [0, 1] silently', async () => {
    const high = await handleLinkCreate(deps, { ...baseInput, confidence: 1.5 });
    expect(high.link.confidence).toBe(1);
    // Re-run because of upsert; otherwise both rows would coexist
    const low = await handleLinkCreate(deps, { ...baseInput, confidence: -0.3 });
    expect(low.link.confidence).toBe(0);
  });

  it('truncates evidence past 1 KB with an ellipsis marker', async () => {
    const big = 'x'.repeat(2048);
    const res = await handleLinkCreate(deps, { ...baseInput, evidence: big });
    expect(res.link.evidence).toHaveLength(1024);
    expect(res.link.evidence!.endsWith('…')).toBe(true);
  });

  it('rejects missing endpoints', async () => {
    await expect(
      handleLinkCreate(deps, { ...baseInput, from_id: '' as unknown as undefined } as never),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// handleMailThreadRead
// ────────────────────────────────────────────────────────────────

const mkMailRecord = (
  record_id: string,
  received_at: number,
  thread_id: string,
): CollectionRecord => ({
  record_id,
  received_at,
  modified_at: received_at,
  hot_fields: { thread_id, subject: `subj ${record_id}` },
  size_bytes: 100,
  source_id: record_id,
});

const mkRegistry = (records: CollectionRecord[], slug = 'work'): MailThreadHandlerDeps => {
  // Minimal Collection that returns `records` from `list` (filtered by
  // `filters.thread_id` when supplied) and ignores the rest. The
  // production CollectionTable runs the full filter compile path; here
  // we hand-filter so the test asserts the handler-side semantics
  // (asc reorder, bound, count) without depending on SQL.
  const collection: Collection = {
    platform: 'mail',
    slug,
    list: (q) => {
      const tid = (q.filters?.thread_id as string | undefined) ?? '';
      const matched = records.filter(
        (r) => (r.hot_fields as { thread_id?: string }).thread_id === tid,
      );
      // Production list orders by `received_at DESC`; mirror that so
      // the handler's `slice().reverse()` step is exercised.
      const desc = matched.slice().sort((a, b) => b.received_at - a.received_at);
      const limit = q.limit ?? 50;
      return desc.slice(0, limit);
    },
    get: () => null,
    search: () => [],
    upsert: () => {},
    delete: () => false,
    health: () => ({
      platform: 'mail', slug, last_indexed_at: 0, pending_queue_size: 0,
      error_count_24h: 0, state: 'idle' as const,
    }),
    runRetention: async () => ({
      pruned_count: 0, bytes_freed: 0, blob_hashes_freed: [], duration_ms: 0,
    }),
    sync: { start: async () => {}, stop: async () => {} },
    gate: undefined as never,
    close: async () => {},
  };
  const registry: CollectionRegistry = {
    register: () => {},
    get: (platform, s) =>
      platform === 'mail' && s === slug ? collection : undefined,
    unregister: () => false,
    list: () => [collection],
    dispose: async () => {},
  };
  return { registry };
};

describe('handleMailThreadRead', () => {
  it('returns messages oldest → newest with first/last + count', async () => {
    const records = [
      mkMailRecord('mail:c', 300, 'thr-1'),
      mkMailRecord('mail:a', 100, 'thr-1'),
      mkMailRecord('mail:b', 200, 'thr-1'),
    ];
    const handlerDeps = mkRegistry(records);
    const res = await handleMailThreadRead(handlerDeps, {
      slug: 'work', thread_id: 'thr-1',
    });
    expect(res.messages.map((m) => m.record_id)).toEqual(['mail:a', 'mail:b', 'mail:c']);
    expect(res.message_count).toBe(3);
    expect(res.first_at).toBe(100);
    expect(res.last_at).toBe(300);
  });

  it('caps at max_messages and returns the bounded window', async () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      mkMailRecord(`mail:${i}`, 100 + i * 10, 'thr-1'),
    );
    const handlerDeps = mkRegistry(records);
    const res = await handleMailThreadRead(handlerDeps, {
      slug: 'work', thread_id: 'thr-1', max_messages: 3,
    });
    // Cap of 3 against DESC order = newest 3 → reverse → oldest of the 3
    expect(res.message_count).toBe(3);
    // Newest 3 are indexes 7, 8, 9 (received_at 170, 180, 190); reversed
    // is 170, 180, 190 → record_ids mail:7, mail:8, mail:9.
    expect(res.messages.map((m) => m.record_id)).toEqual(['mail:7', 'mail:8', 'mail:9']);
    expect(res.first_at).toBe(170);
    expect(res.last_at).toBe(190);
  });

  it('returns empty shape when no messages match', async () => {
    const handlerDeps = mkRegistry([]);
    const res = await handleMailThreadRead(handlerDeps, {
      slug: 'work', thread_id: 'unknown',
    });
    expect(res.messages).toEqual([]);
    expect(res.message_count).toBe(0);
    expect(res.first_at).toBe(0);
    expect(res.last_at).toBe(0);
  });

  it('throws collection_not_found for an unregistered slug', async () => {
    const handlerDeps = mkRegistry([], 'work');
    await expect(
      handleMailThreadRead(handlerDeps, { slug: 'nope', thread_id: 't1' }),
    ).rejects.toMatchObject({ code: 'collection_not_found' });
  });

  it('rejects missing slug / thread_id', async () => {
    const handlerDeps = mkRegistry([]);
    await expect(
      handleMailThreadRead(handlerDeps, { thread_id: 't1' }),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleMailThreadRead(handlerDeps, { slug: 'work' }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// handleTimelineReadFromRecipe (recipe-channel wrapper)
// ────────────────────────────────────────────────────────────────

describe('handleTimelineReadFromRecipe', () => {
  // handleTimelineRequest probes the D-120 `links` table; create the
  // minimal shape it expects (no audit_entries needed when auditLog
  // returns null for every lookup). Real production flow goes through
  // ensureMemorySchema which materializes audit indexes too — irrelevant
  // for these recipe-channel-shape tests.
  beforeEach(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        memory_id          TEXT NOT NULL,
        entity_id          TEXT NOT NULL,
        recipe_insight_id  INTEGER NOT NULL,
        kind               TEXT NOT NULL,
        ts                 INTEGER NOT NULL,
        event_at           INTEGER,
        origin_actor       TEXT,
        origin_contract_id TEXT,
        PRIMARY KEY (memory_id, entity_id, kind, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_links_entity_event
        ON links (entity_id, COALESCE(event_at, ts) DESC);
    `);
  });

  it('delegates to handleTimelineRequest with the entity passed through', async () => {
    const auditStore = {
      get: async (_id: string) => null as AuditEntry | null,
    } as unknown as AuditLogStore;
    const res = await handleTimelineReadFromRecipe(
      {
        timelineDeps: {
          db,
          auditLog: auditStore,
          annotationStore: store,
        },
      },
      { entity: 'data.mail:no-such-record', limit: 5 },
    );
    expect(res.entries).toEqual([]);
    expect(res.next_cursor).toBeUndefined();
  });

  it('rejects missing entity', async () => {
    await expect(
      handleTimelineReadFromRecipe(
        {
          timelineDeps: {
            db,
            auditLog: { get: async () => null } as unknown as AuditLogStore,
            annotationStore: store,
          },
        },
        {},
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('returns next_cursor when the underlying merge produces one', async () => {
    // Seed two annotations on the same target so the merge produces
    // ≥ limit rows + a cursor. The store stamps `authored_at` from the
    // injected `now()` (1_000_001, 1_000_002) so ordering is stable.
    await store.annotate({
      target_collection: 'data.contact', target_id: 'jane@acme.com',
      key: 'company', value: 'Acme',
      authored_by_recipe_id: 'r1', source_record_hash: 's1', recipe_hash: 'r1',
    });
    await store.annotate({
      target_collection: 'data.contact', target_id: 'jane@acme.com',
      key: 'role', value: 'CTO',
      authored_by_recipe_id: 'r1', source_record_hash: 's1', recipe_hash: 'r1',
    });
    const res = await handleTimelineReadFromRecipe(
      {
        timelineDeps: {
          db,
          auditLog: { get: async () => null } as unknown as AuditLogStore,
          annotationStore: store,
        },
      },
      { entity: 'data.contact:jane@acme.com', limit: 1 },
    );
    expect(res.entries).toHaveLength(1);
    expect(res.next_cursor).toBeTypeOf('string');
  });
});

// ────────────────────────────────────────────────────────────────
// (removed) The bare-op manifest-existence/author check read community/ingredients files that are
// now inlined in KERNEL_MANIFESTS (kernel/community separation). Kernel manifest integrity —
// including author/risk/parity — is covered by backend/server/src/__tests__/kernel-manifests.test.ts.
