/** D-119 Phase 13 — cascade-on-parent-delete sweep across the
 *  collection.deleteRecord rpc surface.
 *
 *  Verifies that deleting a record from a `data.<platform>:<slug>`
 *  collection also clears every annotation pointing at it and every
 *  link with it as either endpoint. Cascade is best-effort — a sweep
 *  failure must not roll back the row delete. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import { handleCollectionDeleteRecord, type CollectionHandlerDeps } from '../collections/collection-handler.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { CollectionRecord } from '@recued/contracts';

let dir: string;
let db: Database.Database;
let store: AnnotationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collection-cascade-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => 1_000,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const fakeRegistry = (presentRecord: boolean): CollectionRegistry => {
  const fakeCollection = {
    delete: (_id: string) => (presentRecord ? ({ record_id: _id } as CollectionRecord) : null),
    list: () => ({ records: [] as CollectionRecord[] }),
    search: () => ({ matches: [] }),
    get: () => null,
    sync: { start: async () => {} },
    runRetention: async () => 0,
    health: () => ({}),
  };
  return {
    get: () => fakeCollection as unknown as ReturnType<CollectionRegistry['get']>,
    list: () => [],
  } as unknown as CollectionRegistry;
};

describe('handleCollectionDeleteRecord — cascade integration', () => {
  it('cascades annotation + link sweep when annotationCascade is wired', async () => {
    // Seed annotations + links touching mail/m1
    await store.annotate({
      target_collection: 'mail', target_id: 'm1', key: 'summary',
      value: 'goodbye', authored_by_recipe_id: 'r1',
      source_record_hash: 's',
    });
    await store.link({
      from_collection: 'mail', from_id: 'm1',
      to_collection: 'file', to_id: 'f1',
      role: 'attachment', authored_by_recipe_id: 'r1',
    });
    // Unrelated link must survive
    await store.link({
      from_collection: 'mail', from_id: 'm2',
      to_collection: 'file', to_id: 'f9',
      role: 'attachment', authored_by_recipe_id: 'r1',
    });

    const deps: CollectionHandlerDeps = {
      registry: fakeRegistry(true),
      annotationCascade: (col, id) => store.cascadeDelete(col, id),
    };

    const res = await handleCollectionDeleteRecord(deps, {
      platform: 'mail', slug: 'gmail-default', record_id: 'm1',
    });
    expect(res).toEqual({ ok: true });

    const annLeft = await store.annotationsForRecord('mail', 'm1');
    expect(annLeft).toHaveLength(0);
    const links = await store.listLinks({});
    expect(links).toHaveLength(1);
    expect(links[0].from_id).toBe('m2');
  });

  it('skips cascade when annotationCascade is absent', async () => {
    await store.annotate({
      target_collection: 'mail', target_id: 'm1', key: 'summary',
      value: 'survives', authored_by_recipe_id: 'r1',
      source_record_hash: 's',
    });

    const deps: CollectionHandlerDeps = { registry: fakeRegistry(true) };
    const res = await handleCollectionDeleteRecord(deps, {
      platform: 'mail', slug: 'gmail-default', record_id: 'm1',
    });
    expect(res).toEqual({ ok: true });

    const annLeft = await store.annotationsForRecord('mail', 'm1');
    expect(annLeft).toHaveLength(1);
  });

  it('cascade failure does not roll back the record delete', async () => {
    let callCount = 0;
    const deps: CollectionHandlerDeps = {
      registry: fakeRegistry(true),
      annotationCascade: () => {
        callCount++;
        throw new Error('intentional sweep failure');
      },
    };
    const res = await handleCollectionDeleteRecord(deps, {
      platform: 'mail', slug: 'gmail-default', record_id: 'm1',
    });
    expect(res).toEqual({ ok: true });
    expect(callCount).toBe(1);
  });
});
