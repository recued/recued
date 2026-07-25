/** D-161 P2 — origin_actor provenance on annotation + D-119 link rows.
 *
 *  Mirrors the P1 enrichment pattern: the store stamps `origin_actor` /
 *  `origin_contract_id` from its input (default `'system'`); the handlers
 *  read origin from SERVER-INJECTED `deps`, never from `args` (the spoofing
 *  boundary, I-6 / A.5); the direct paired-client `annotation.write` /
 *  `link.write` rpc stamps `'user_self'` via `makeAnnotationHandlers`. */

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
import {
  handleAnnotationCreate,
  handleAnnotationWrite,
  handleLinkCreate,
  handleLinkWrite,
  makeAnnotationHandlers,
  type AnnotationRpcDeps,
} from '../annotation-handler.js';

let dir: string;
let db: Database.Database;
let store: AnnotationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-161-p2-annlink-'));
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

const annInput = () => ({
  target_collection: 'mail',
  target_id: 'msg-1',
  key: 'summary',
  value: 'v',
  authored_by_recipe_id: 'r1',
  source_record_hash: 'src',
  recipe_hash: 'rec',
});

const linkInput = () => ({
  from_collection: 'mail',
  from_id: 'msg-1',
  to_collection: 'contact',
  to_id: 'jane@x.com',
  role: 'mentions',
  authored_by_recipe_id: 'r1',
});

describe('annotation-store — origin stamping', () => {
  it('stamps origin_actor + origin_contract_id from input and surfaces them on read', async () => {
    const ann = await store.annotate({
      ...annInput(),
      origin_actor: 'contracted_user',
      origin_contract_id: 'c-1',
    });
    expect(ann.origin_actor).toBe('contracted_user');
    expect(ann.origin_contract_id).toBe('c-1');
    const read = await store.annotationsForRecord('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('contracted_user');
    expect(read[0]?.origin_contract_id).toBe('c-1');
  });

  it("defaults origin_actor to 'system' when the input omits it", async () => {
    const ann = await store.annotate(annInput());
    expect(ann.origin_actor).toBe('system');
    expect(ann.origin_contract_id).toBeUndefined();
    const read = await store.annotationsForRecord('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('system');
  });

  it('stamps + surfaces origin on link rows too', async () => {
    const link = await store.link({ ...linkInput(), origin_actor: 'anonymous' });
    expect(link.origin_actor).toBe('anonymous');
    const read = await store.outboundLinks('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('anonymous');
    const linkDefault = await store.link({ ...linkInput(), to_id: 'bob@x.com' });
    expect(linkDefault.origin_actor).toBe('system');
  });
});

describe('annotation/link handlers — origin is server-injected via deps, never args', () => {
  it('handleAnnotationCreate reads deps.origin_actor and IGNORES an args spoof', async () => {
    // deps carries the trusted run actor; args carries a spoof attempt.
    const deps: AnnotationRpcDeps = { store, origin_actor: 'contracted_user', origin_contract_id: 'c-9' };
    await handleAnnotationCreate(deps, { ...annInput(), origin_actor: 'user_self', origin_contract_id: 'spoof' });
    const read = await store.annotationsForRecord('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('contracted_user'); // deps wins
    expect(read[0]?.origin_contract_id).toBe('c-9');
  });

  it("handleAnnotationCreate defaults to 'system' when deps carry no origin (a spoofed args is ignored)", async () => {
    await handleAnnotationCreate({ store }, { ...annInput(), origin_actor: 'user_self' });
    const read = await store.annotationsForRecord('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('system');
  });

  it('handleLinkCreate reads deps.origin_actor and IGNORES an args spoof', async () => {
    await handleLinkCreate(
      { store, origin_actor: 'contracted_user' },
      { ...linkInput(), origin_actor: 'user_self' },
    );
    const read = await store.outboundLinks('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('contracted_user');
  });

  it('handleAnnotationWrite + handleLinkWrite also honour deps origin', async () => {
    await handleAnnotationWrite({ store, origin_actor: 'anonymous' }, annInput());
    expect((await store.annotationsForRecord('mail', 'msg-1'))[0]?.origin_actor).toBe('anonymous');
    await handleLinkWrite({ store, origin_actor: 'anonymous' }, linkInput());
    expect((await store.outboundLinks('mail', 'msg-1'))[0]?.origin_actor).toBe('anonymous');
  });
});

describe('makeAnnotationHandlers — direct paired-client rpc stamps user_self', () => {
  const client = { instance_id: 'dev-1' } as never;

  it("annotation.write rpc stamps origin_actor='user_self'", async () => {
    const slice = makeAnnotationHandlers({ store })!;
    await slice.handlers['annotation.write'](annInput() as never, client);
    const read = await store.annotationsForRecord('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('user_self');
  });

  it("link.write rpc stamps origin_actor='user_self'", async () => {
    const slice = makeAnnotationHandlers({ store })!;
    await slice.handlers['link.write'](linkInput() as never, client);
    const read = await store.outboundLinks('mail', 'msg-1');
    expect(read[0]?.origin_actor).toBe('user_self');
  });

  it('a client cannot spoof a different origin on the direct write rpc', async () => {
    const slice = makeAnnotationHandlers({ store })!;
    // The client jams origin_actor into the rpc payload — ignored; the
    // server injects user_self from the channel.
    await slice.handlers['annotation.write']({ ...annInput(), origin_actor: 'system' } as never, client);
    expect((await store.annotationsForRecord('mail', 'msg-1'))[0]?.origin_actor).toBe('user_self');
  });
});
