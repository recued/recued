/** D-226 — the walk at its declared MAXIMUM: two hops.
 *
 *  ⚠ Written because a review pass found the gap: RECORDS_ROOT_MAX_HOPS is 2,
 *  and every other test covered 1 hop or 0. The resolver iterates hops in
 *  REVERSE and returns from inside the loop, which is precisely the shape where
 *  an off-by-one hides — and it would hide as a WRONG NUMBER, not a crash.
 *
 *  ⛔ The case that matters most is a MIDDLE level returning zero rows. If the
 *  walk fell through instead of stopping, the base-level filter would be
 *  dropped and the rollup would aggregate EVERY row in the pack under one
 *  contact's name. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordsExecutionBinding, RecordsPackRef, RecordsSchemaSnapshot } from '@recued/contracts';
import { createRecordsStore, type RecordsStore } from '../store.js';
import { readRootProjections } from '../root-projection.js';

const OWNER: RecordsPackRef = { publisher: 'p', pack_slug: 'deep' };
const SH = 'a'.repeat(64); const DH = 'b'.repeat(64);
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    client: { kind: 'client', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'email', slot: 's1', kind: 'string', required: false }] },
    project: { kind: 'project', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'client_ref', slot: 'r1', kind: 'ref', required: true }] },
    task: { kind: 'task', roots: [{
        root: 'contact',
        via: [{ field: 'project_ref', entity: 'project' }, { field: 'client_ref', entity: 'client' }],
        key_field: 'email', where: { done: false }, label: 'Open tasks',
        select: { hours: { fn: 'sum', field: 'hours' }, n: { fn: 'count' } },
      }],
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'project_ref', slot: 'r1', kind: 'ref', required: true },
        { key: 'hours', slot: 'n1', kind: 'number', required: true },
        { key: 'done', slot: 'b1', kind: 'boolean', required: true }] },
  },
};
const bind = (entity: string): RecordsExecutionBinding => ({
  kind: 'core.records', action: 'create', entity, owner: OWNER,
  pack_version: 1, storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:create:${entity}`,
});

describe('two-hop walk: task → project → client → contact', () => {
  let db: Database.Database; let store: RecordsStore;
  const mk = (entity: string, id: string, values: Record<string, unknown>) =>
    store.execute({ binding: bind(entity), principal: 'owner', args: { id, values } });

  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
    store.installNamespace({ owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema,
      bindings: { c: bind('client'), p: bind('project'), t: bind('task') } });
    mk('client', 'c1', { email: 'bob@x.test' });
    mk('client', 'c2', { email: 'eve@y.test' });
    mk('project', 'p1', { client_ref: 'client/c1' });
    mk('project', 'p2', { client_ref: 'client/c1' });
    mk('project', 'p3', { client_ref: 'client/c2' });
    mk('task', 't1', { project_ref: 'project/p1', hours: 3, done: false });
    mk('task', 't2', { project_ref: 'project/p2', hours: 5, done: false });
    mk('task', 't3', { project_ref: 'project/p1', hours: 9, done: true });   // filtered by where
    mk('task', 't4', { project_ref: 'project/p3', hours: 100, done: false }); // other client
  });
  afterEach(() => db.close());

  it('⛔ traverses BOTH hops and lands on the right rows', () => {
    const [r] = readRootProjections(store, 'contact', 'bob@x.test');
    expect(r!.value).toEqual({ hours: 8, n: 2 });   // t1 + t2; t3 done, t4 other client
    expect(r!.complete).toBe(true);
  });
  it("the other client's 100 hours never leak across two hops", () => {
    expect(readRootProjections(store, 'contact', 'eve@y.test')[0]!.value).toEqual({ hours: 100, n: 1 });
  });
  it('an unknown root gives the empty contract, not a crash', () => {
    expect(readRootProjections(store, 'contact', 'nobody@z.test')[0]!.value).toEqual({ hours: 0, n: 0 });
  });
  it('⛔ a MIDDLE level with zero rows short-circuits to empty, not to everything', () => {
    // a client with no projects: the walk must stop, not fall through to an
    // unfiltered scan of tasks.
    mk('client', 'c3', { email: 'ghost@z.test' });
    const [r] = readRootProjections(store, 'contact', 'ghost@z.test');
    expect(r!.value).toEqual({ hours: 0, n: 0 });
  });
});
