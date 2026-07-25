/** D-119 Phase 13 — annotation + link rpc handler tests.
 *
 *  Covers the eight rpc methods (`annotation.write|list|search|delete|
 *  forRecord` + `link.write|list|delete|forRecord`): canonical-ref
 *  normalization on writes, validation of required fields, error
 *  mapping, and direction routing on `link.forRecord`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import {
  handleAnnotationWrite,
  handleAnnotationList,
  handleAnnotationSearch,
  handleAnnotationDelete,
  handleAnnotationForRecord,
  handleLinkWrite,
  handleLinkList,
  handleLinkDelete,
  handleLinkForRecord,
} from '../annotation-handler.js';

let dir: string;
let db: Database.Database;
let store: AnnotationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'annotation-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(dir, 'blobs'));
  let counter = 0;
  store = createAnnotationStore({
    db,
    blobs,
    now: () => 1_000_000 + counter,
    newId: () => `id-${++counter}`,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('handleAnnotationWrite', () => {
  it('writes via target_ref (canonical record)', async () => {
    const res = await handleAnnotationWrite({ store }, {
      target_ref: { _id: 'msg-1', _collection: 'mail' },
      key: 'summary',
      value: 'hi',
      authored_by_recipe_id: 'r1',
      source_record_hash: 'src',
      recipe_hash: 'rec',
    });
    expect(res.annotation.target_collection).toBe('mail');
    expect(res.annotation.target_id).toBe('msg-1');
  });

  it('writes via explicit target_collection + target_id', async () => {
    const res = await handleAnnotationWrite({ store }, {
      target_collection: 'calendar',
      target_id: 'evt-1',
      key: 'tldr',
      value: 'short',
      authored_by_recipe_id: 'r1',
      source_record_hash: 'src',
      recipe_hash: 'rec',
    });
    expect(res.annotation.target_collection).toBe('calendar');
    expect(res.annotation.target_id).toBe('evt-1');
  });

  it('ignores inherited value fields', async () => {
    const args = Object.create({ value: 'proto' });
    Object.assign(args, {
      target_collection: 'mail',
      target_id: 'msg-1',
      key: 'summary',
      authored_by_recipe_id: 'r1',
      source_record_hash: 'src',
      recipe_hash: 'rec',
    });

    const res = await handleAnnotationWrite({ store }, args);

    expect(res.annotation.value).toBeNull();
  });

  it('rejects non-canonical target_ref', async () => {
    await expect(
      handleAnnotationWrite({ store }, {
        target_ref: { foo: 'bar' },
        key: 'k',
        value: 'v',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's',
        recipe_hash: 'r',
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing source_record_hash', async () => {
    await expect(
      handleAnnotationWrite({ store }, {
        target_collection: 'mail', target_id: 'x',
        key: 'k', value: 'v',
        authored_by_recipe_id: 'r1',
        recipe_hash: 'r',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects empty key', async () => {
    await expect(
      handleAnnotationWrite({ store }, {
        target_collection: 'mail', target_id: 'x',
        key: '', value: 'v',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's', recipe_hash: 'r',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('handleAnnotationList / Search / Delete / ForRecord', () => {
  const seed = async (): Promise<void> => {
    await handleAnnotationWrite({ store }, {
      target_collection: 'mail', target_id: 'm1',
      key: 'summary', value: 'Acme Q3 close',
      authored_by_recipe_id: 'r1',
      source_record_hash: 's', recipe_hash: 'r',
    });
    await handleAnnotationWrite({ store }, {
      target_collection: 'mail', target_id: 'm1',
      key: 'risk_score', value: 0.8,
      authored_by_recipe_id: 'r2',
      source_record_hash: 's', recipe_hash: 'r',
    });
    await handleAnnotationWrite({ store }, {
      target_collection: 'mail', target_id: 'm2',
      key: 'summary', value: 'Other thing',
      authored_by_recipe_id: 'r1',
      source_record_hash: 's', recipe_hash: 'r',
    });
  };

  it('list returns rows by filter', async () => {
    await seed();
    const res = await handleAnnotationList({ store }, { target_id: 'm1' });
    expect(res.annotations).toHaveLength(2);
  });

  it('forRecord returns the latest per (target,id,key)', async () => {
    await seed();
    const res = await handleAnnotationForRecord({ store }, {
      collection: 'mail', id: 'm1',
    });
    expect(res.annotations.map((a) => a.key).sort()).toEqual(['risk_score', 'summary']);
  });

  it('forRecord validates collection + id are strings', async () => {
    await expect(
      handleAnnotationForRecord({ store }, { collection: 'mail', id: 42 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('search rejects empty query', async () => {
    await expect(
      handleAnnotationSearch({ store }, { query: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('delete by filter returns deleted count', async () => {
    await seed();
    const res = await handleAnnotationDelete({ store }, { key: 'risk_score' });
    expect(res.deleted).toBe(1);
  });
});

describe('handleLinkWrite', () => {
  it('accepts canonical refs on both sides', async () => {
    const res = await handleLinkWrite({ store }, {
      from_ref: { _id: 'msg-1', _collection: 'mail' },
      to_ref: { _id: 'f1', _collection: 'file' },
      role: 'attachment',
      authored_by_recipe_id: 'r1',
    });
    expect(res.link.from_collection).toBe('mail');
    expect(res.link.to_collection).toBe('file');
  });

  it('falls back to explicit from_/to_ collection+id pairs', async () => {
    const res = await handleLinkWrite({ store }, {
      from_collection: 'mail', from_id: 'm1',
      to_collection: 'calendar', to_id: 'evt-1',
      role: 'scheduled-from',
      authored_by_recipe_id: 'r1',
    });
    expect(res.link.role).toBe('scheduled-from');
  });

  it('rejects empty role', async () => {
    await expect(
      handleLinkWrite({ store }, {
        from_collection: 'mail', from_id: 'x',
        to_collection: 'file', to_id: 'y',
        role: '',
        authored_by_recipe_id: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('handleLinkList / Delete / ForRecord', () => {
  const seed = async (): Promise<void> => {
    await handleLinkWrite({ store }, {
      from_collection: 'mail', from_id: 'm1',
      to_collection: 'file', to_id: 'f1',
      role: 'attachment', authored_by_recipe_id: 'r1',
    });
    await handleLinkWrite({ store }, {
      from_collection: 'calendar', from_id: 'evt-1',
      to_collection: 'mail', to_id: 'm1',
      role: 'follow-up-on', authored_by_recipe_id: 'r1',
    });
  };

  it('list filters work', async () => {
    await seed();
    const res = await handleLinkList({ store }, { role: 'attachment' });
    expect(res.links).toHaveLength(1);
    expect(res.links[0].to_collection).toBe('file');
  });

  it('forRecord outbound returns links with the record as `from`', async () => {
    await seed();
    const res = await handleLinkForRecord({ store }, {
      collection: 'mail', id: 'm1', direction: 'outbound',
    });
    expect(res.links).toHaveLength(1);
    expect(res.links[0].to_id).toBe('f1');
  });

  it('forRecord inbound returns links with the record as `to`', async () => {
    await seed();
    const res = await handleLinkForRecord({ store }, {
      collection: 'mail', id: 'm1', direction: 'inbound',
    });
    expect(res.links).toHaveLength(1);
    expect(res.links[0].from_id).toBe('evt-1');
  });

  it('forRecord rejects invalid direction', async () => {
    await expect(
      handleLinkForRecord({ store }, {
        collection: 'mail', id: 'm1', direction: 'sideways',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('delete by filter returns deleted count', async () => {
    await seed();
    const res = await handleLinkDelete({ store }, { role: 'attachment' });
    expect(res.deleted).toBe(1);
  });
});
