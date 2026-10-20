import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCheckpoint, isResourceReview, isPreflightRequiredSignal, renderResourceReview, RECORDS_MAX_CAUSAL_FANOUT,
  type IngredientManifest, type RecordsAction, type RecordsBatchAction,
  type RecordsExecutionBinding, type RecordsSchemaSnapshot, type PreflightRequiredSignal,
} from '@recued/contracts';
import { runCatalogOperation, type ExecutionContext } from '@recued/engine';
import { createRecordsStore } from '../records/store.js';
import { createResourceReviewHooks, currentResourceReview } from '../resource-review.js';
import { createNamespaceStores } from '../server-executor.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db);
  const owner = { publisher: 'recued-core', pack_slug: 'bulk-review-fixture' };
  const bind = (action: RecordsAction, entity = 'note'): RecordsExecutionBinding => ({
    kind: 'core.records', action, entity, owner, pack_version: 1,
    storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: entity + ':' + action,
  });
  const bindings = {
    create: bind('create'), update: bind('update'), delete: bind('delete'), upsert: bind('upsert'),
    tag: { ...bind('create', 'tag'), natural_key: ['name'] },
    batch: { ...bind('batch'), allow: [
      ...(['create', 'update', 'upsert', 'delete'] as const).map(action => ({ entity: 'note', action })),
      { entity: 'tag', action: 'create' as const },
    ] },
  };
  const schema: RecordsSchemaSnapshot = { decimal_scale: 4, entities: {
    note: { kind: 'note', fields: [
      { key: 'id', kind: 'id', slot: 'pk', required: true },
      { key: 'title', kind: 'string', slot: 's1', required: true },
      { key: 'details.note', kind: 'text', slot: 't1', required: false },
      { key: 'amount', kind: 'decimal', slot: 'dec1', required: false },
      { key: 'tag', kind: 'ref', slot: 'r1', required: false },
    ] },
    tag: { kind: 'tag', fields: [
      { key: 'id', kind: 'id', slot: 'pk', required: true },
      { key: 'name', kind: 'string', slot: 's1', required: true },
    ] },
  } };
  const changed = vi.fn();
  const idFactory = vi.fn(() => 'normal-generated-id');
  let store = createRecordsStore(db, { now: () => 1000, onChange: changed, id: idFactory });
  store.installNamespace({ owner, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'fixture', schema, bindings });
  const manifest: IngredientManifest = {
    slug: 'bulk-review-fixture', name: 'Bulk review fixture', description: 'Fixture', author: owner.publisher,
    kind: 'storage', version: 1, category: 'data', risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
    operations: {
      upsert: { operation_id: 'fixture.note.upsert', risk_tier: 'write', approval: 'always', groups: ['note.write'] },
      batch: { operation_id: 'fixture.note.batch', risk_tier: 'destructive', approval: 'always', groups: ['note.write'] },
      update: { operation_id: 'fixture.note.update', risk_tier: 'write', approval: 'always', groups: ['note.write'] },
    },
    operation_groups: { 'note.write': { group_id: 'note.write', operations: ['upsert', 'batch', 'update'], risk_floor: 'write' } },
    surfaces: { records: { executes: bindings, schema } },
  };
  const hooks = () => createResourceReviewHooks({ manifest: () => manifest, records: store, now: () => 1000 });
  const run = (action: keyof typeof bindings, args: Record<string, unknown>) =>
    store.execute({ binding: bindings[action], principal: 'owner', args });
  const seed = (id: string, title = id) => run('create', { id, values: { title } });
  const row = (id: string) => store.ownerGet(owner, 'note', id);
  const snapshot = () => ({
    records: db.prepare('SELECT * FROM core_records ORDER BY kind, pk').all(),
    namespaces: db.prepare('SELECT * FROM core_record_namespaces').all(),
    outbox: db.prepare('SELECT * FROM core_record_outbox ORDER BY event_id').all(),
    refs: db.prepare('SELECT * FROM core_record_reverse_refs').all(),
    quota: store.getGlobalQuota(),
  });
  const restart = () => { store = createRecordsStore(db, { now: () => 1000, onChange: changed, id: idFactory }); };
  return { db, owner, store: () => store, manifest, bindings, hooks, run, seed, row, snapshot, changed, idFactory, restart };
};
const op = (action: RecordsBatchAction, id: string, extra: Record<string, unknown> = {}) => ({
  entity: 'note', action, args: { id,
    ...(['update', 'delete', 'upsert'].includes(action) ? { expected_version: 1 } : {}),
    ...(['update', 'delete'].includes(action) ? { expected_revision: 0 } : {}), ...extra },
});

describe('version-bound Records upsert and batch approvals', () => {
  it('reviews an absent upsert without writing or publishing notices, then applies the reviewed insert after restart', () => {
    const f = fixture();
    const input = { operation: 'upsert', args: { id: 'new', expected_version: 1, values: { title: 'New', amount: '12.5' } } };
    const before = f.snapshot();
    const review = f.hooks().capture(f.manifest.slug, input)!;
    expect(isResourceReview(review)).toBe(true);
    expect(review.resources).toMatchObject([{ precondition: { kind: 'records_absent' }, before: {},
      after: { id: 'new', title: 'New', amount: '12.5000', details: { note: null } } }]);
    expect(f.snapshot()).toEqual(before);
    expect(f.changed).not.toHaveBeenCalled();
    expect(renderResourceReview(review)).toContain('Before: Does not exist');
    f.restart();
    const recovered = JSON.parse(JSON.stringify(review));
    expect(f.hooks().capture(f.manifest.slug, input, recovered, true)).toEqual(review);
    f.hooks().run(recovered, () => f.run('upsert', input.args));
    expect(f.row('new')).toMatchObject({ title: 'New', amount: '12.5000', _record: { revision: 0 } });
    expect(f.changed).toHaveBeenCalledTimes(1);
  });

  it('reviews the normalized replacement for an existing upsert, including cleared optional and nested fields', () => {
    const f = fixture();
    f.run('create', { id: 'old', values: { title: 'Old', details: { note: 'Clear me' }, amount: '8' } });
    const input = { operation: 'upsert', args: { id: 'old', expected_version: 1, expected_revision: 0, values: { title: 'Replacement' } } };
    const review = f.hooks().capture(f.manifest.slug, input)!;
    expect(review.resources[0]).toMatchObject({ before: { details: { note: 'Clear me' }, amount: '8.0000' },
      after: { title: 'Replacement', details: { note: null }, amount: null } });
    f.hooks().run(review, () => f.run('upsert', input.args));
    expect(f.row('old')).toMatchObject(review.resources[0]!.after!);
  });

  it('refuses an insert approval after another writer seats that ID, even with identical values', () => {
    const f = fixture();
    const input = { operation: 'upsert', args: { id: 'new', expected_version: 1, values: { title: 'New' } } };
    const review = f.hooks().capture(f.manifest.slug, input)!;
    f.seed('new', 'New');
    const before = f.snapshot(); f.changed.mockClear();
    expect(() => f.hooks().run(review, () => f.run('upsert', input.args))).toThrow(/revision|review/);
    expect(f.snapshot()).toEqual(before);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('retains generated and natural-key identities with the combined mixed batch review', () => {
    const f = fixture(); f.seed('edit'); f.seed('remove');
    const args = { ops: [op('update', 'edit', { set: { title: 'Edited' } }), op('delete', 'remove'),
      op('upsert', 'insert', { values: { title: 'Inserted' } }),
      { entity: 'note', action: 'create', args: { values: { title: 'Generated' } } },
      { entity: 'tag', action: 'create', args: { values: { name: 'Natural tag' } } },
    ] };
    const input = { operation: 'batch', args };
    const before = f.snapshot(); f.changed.mockClear();
    const review = f.hooks().capture(f.manifest.slug, input)!;
    expect(isResourceReview(review)).toBe(true);
    expect(review.resources).toHaveLength(5);
    const generated = review.resources.find(r => r.precondition.kind === 'records_absent' && r.precondition.generated_for === 3)!;
    expect(generated.after?.id).toMatch(/^rec_/);
    expect(f.snapshot()).toEqual(before);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.idFactory).not.toHaveBeenCalled();
    f.restart();
    // Manifest serialization may change object key order across restart.
    f.bindings.batch.owner = { pack_slug: f.owner.pack_slug, publisher: f.owner.publisher };
    expect(f.hooks().capture(f.manifest.slug, input, JSON.parse(JSON.stringify(review)), true)).toEqual(review);
    f.hooks().run(review, () => f.run('batch', args));
    expect(f.row('edit')!.title).toBe('Edited'); expect(f.row('remove')).toBeNull();
    expect(f.row('insert')!.title).toBe('Inserted');
    expect(f.row(String(generated.after!.id))!.title).toBe('Generated');
    expect(f.store().ownerGet(f.owner, 'tag', String(review.resources[4]!.after!.id))!.name).toBe('Natural tag');
    expect(f.changed).toHaveBeenCalledTimes(5);
    expect(f.idFactory).not.toHaveBeenCalled();
    expect(currentResourceReview()).toBeUndefined();
  });

  it.each(['update', 'replace', 'delete'] as const)('refuses the whole batch after a late %s of one reviewed row', mutation => {
    const f = fixture(); f.seed('first'); f.seed('last');
    const args = { ops: [op('create', 'new', { values: { title: 'New' } }),
      op('update', 'first', { set: { title: 'Approved first' } }), op('delete', 'last')] };
    const input = { operation: 'batch', args };
    const review = f.hooks().capture(f.manifest.slug, input)!;
    expect(f.hooks().capture(f.manifest.slug, input, review, true)).toEqual(review);
    if (mutation === 'update') f.run('update', { id: 'last', expected_version: 1, expected_revision: 0, set: { title: 'Other writer' } });
    else {
      f.run('delete', { id: 'last', expected_version: 1, expected_revision: 0 });
      if (mutation === 'replace') f.seed('last');
    }
    const before = f.snapshot(); f.changed.mockClear();
    expect(() => f.hooks().run(review, () => f.run('batch', args))).toThrow();
    expect(f.snapshot()).toEqual(before);
    expect(f.row('new')).toBeNull(); expect(f.row('first')!.title).toBe('first');
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('reviews sequential edits, delete and recreation of one ID without hiding the intermediate effects', () => {
    const f = fixture(); f.seed('same');
    const args = { ops: [op('update', 'same', { set: { title: 'Intermediate' } }),
      op('upsert', 'same', { expected_revision: 1, values: { title: 'Second edit' } }),
      op('delete', 'same', { expected_revision: 2 }), op('create', 'same', { values: { title: 'Recreated' } })] };
    const review = f.hooks().capture(f.manifest.slug, { operation: 'batch', args })!;
    expect(review.resources).toHaveLength(1);
    expect(review.resources[0]!.changes?.map(change => change.action)).toEqual(['update', 'upsert', 'delete', 'create']);
    const rendered = renderResourceReview(review);
    expect(rendered).toContain('Intermediate'); expect(rendered).toContain('3. delete'); expect(rendered).toContain('4. create');
    f.hooks().run(review, () => f.run('batch', args));
    expect(f.row('same')).toMatchObject({ title: 'Recreated', _record: { revision: 0 } });
  });

  it('delivers change notices after the reviewed batch commits without lending its approval or reserved IDs to a callback', () => {
    const f = fixture();
    const args = { ops: [0, 1].map(index => ({ entity: 'note', action: 'create',
      args: { values: { title: 'Generated ' + index } } })) };
    const review = f.hooks().capture(f.manifest.slug, { operation: 'batch', args })!;
    const observations: { inTransaction: boolean; reviewedRowsExist: boolean; hasApproval: boolean }[] = [];
    let callbackResult: unknown;
    let callbackError: unknown;
    f.changed.mockImplementationOnce(() => {
      observations.push({ inTransaction: f.db.inTransaction,
        reviewedRowsExist: review.resources.every(resource => f.row(String(resource.after!.id)) !== null),
        hasApproval: currentResourceReview() !== undefined });
      try { callbackResult = f.run('create', { values: { title: 'Callback row' } }); }
      catch (error) { callbackError = error; }
    });
    f.hooks().run(review, () => f.run('batch', args));
    expect(observations).toEqual([{ inTransaction: false, reviewedRowsExist: true, hasApproval: false }]);
    expect(callbackError).toBeUndefined();
    expect(callbackResult).toMatchObject({ record: { id: 'normal-generated-id', title: 'Callback row' } });
    expect(f.idFactory).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(3);
  });

  it('discards change notices if the final watcher context exhausts its budget midway through the reviewed batch', () => {
    const f = fixture(); f.seed('root');
    const root = f.db.prepare('SELECT event_id FROM core_record_outbox').pluck().get() as string;
    for (let i = 1; i < RECORDS_MAX_CAUSAL_FANOUT - 1; i++) {
      f.store().execute({ binding: f.bindings.create, principal: 'watcher', root_event_id: root, causal_depth: 1,
        args: { id: 'prior-' + i, values: { title: 'Prior watcher row' } } });
    }
    const args = { ops: [op('create', 'first', { values: { title: 'First' } }),
      op('create', 'last', { values: { title: 'Last' } })] };
    const review = f.hooks().capture(f.manifest.slug, { operation: 'batch', args })!;
    const before = f.snapshot(); f.changed.mockClear();
    expect(() => f.hooks().run(review, () => f.store().execute({ binding: f.bindings.batch,
      principal: 'watcher', root_event_id: root, causal_depth: 1, args }))).toThrow(/fan-out budget/);
    expect(f.snapshot()).toEqual(before);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('pins arguments at the final store boundary and permits a fresh review after a conflict', () => {
    const f = fixture(); f.seed('edit');
    const args = { ops: [op('update', 'edit', { set: { title: 'Approved' } })] };
    const review = f.hooks().capture(f.manifest.slug, { operation: 'batch', args })!;
    const changedArgs = { ops: [op('update', 'edit', { set: { title: 'Different' } })] };
    expect(() => f.hooks().run(review, () => f.run('batch', changedArgs))).toThrow(/review/);
    expect(f.row('edit')!.title).toBe('edit');
    const fresh = f.hooks().capture(f.manifest.slug, { operation: 'batch', args: changedArgs })!;
    f.hooks().run(fresh, () => f.run('batch', changedArgs));
    expect(f.row('edit')!.title).toBe('Different');
  });

  it('shows a create/delete sequence even when the final row is absent', () => {
    const f = fixture();
    const args = { ops: [op('create', 'transient', { values: { title: 'Intermediate' } }), op('delete', 'transient')] };
    const review = f.hooks().capture(f.manifest.slug, { operation: 'batch', args })!;
    expect(review.resources[0]).toMatchObject({ before: {}, after: null });
    expect(review.resources[0]!.changes?.map(change => change.action)).toEqual(['create', 'delete']);
    const text = renderResourceReview(review);
    expect(text).toContain('After: Does not exist');
    expect(text).toContain('Intermediate');
    expect(text).not.toContain('Delete this resource');
    f.hooks().run(review, () => f.run('batch', args));
    expect(f.row('transient')).toBeNull();
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid late batch operation without publishing preview writes or notices', () => {
    const f = fixture(); const before = f.snapshot();
    expect(() => f.hooks().capture(f.manifest.slug, { operation: 'batch', args: { ops: [
      op('create', 'one', { values: { title: 'Valid' } }), op('create', 'two', { values: { unknown: 'Invalid' } }),
    ] } })).toThrow(/unknown|missing/);
    expect(f.snapshot()).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
    expect(currentResourceReview()).toBeUndefined();
  });

  it('rejects an occupied generated ID after restart without turning the create into a replay', () => {
    const f = fixture();
    const input = { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'create', args: { values: { title: 'Generated' } } },
    ] } };
    const review = f.hooks().capture(f.manifest.slug, input)!;
    const id = String(review.resources[0]!.after!.id);
    f.restart(); f.seed(id, 'Generated');
    const before = f.snapshot(); f.changed.mockClear();
    expect(() => f.hooks().capture(f.manifest.slug, input, review, true)).toThrow(/changed after review/);
    expect(() => f.hooks().run(review, () => f.run('batch', input.args))).toThrow(/replaced after review/);
    expect(f.snapshot()).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
  });

  it('refuses an existing upsert review for a same-clock identical replacement', () => {
    const f = fixture(); f.seed('replace');
    const input = { operation: 'upsert', args: { id: 'replace', expected_version: 1, expected_revision: 0, values: { title: 'After' } } };
    const review = f.hooks().capture(f.manifest.slug, input)!;
    f.run('delete', { id: 'replace', expected_version: 1, expected_revision: 0 }); f.seed('replace');
    const before = f.snapshot();
    expect(() => f.hooks().run(review, () => f.run('upsert', input.args))).toThrow(/replaced after review/);
    expect(f.snapshot()).toEqual(before);
  });

  it('supports the 100-operation limit while preserving every sequential change in the review', () => {
    const f = fixture(); f.seed('many');
    const args = { ops: Array.from({ length: 100 }, (_, i) => op('update', 'many', {
      expected_revision: i, set: { title: 'Step ' + i },
    })) };
    const review = f.hooks().capture(f.manifest.slug, { operation: 'batch', args })!;
    expect(isResourceReview(review)).toBe(true);
    expect(review.resources[0]!.changes).toHaveLength(100);
    f.hooks().run(review, () => f.run('batch', args));
    expect(f.row('many')).toMatchObject({ title: 'Step 99', _record: { revision: 100 } });
    expect(() => f.hooks().capture(f.manifest.slug, { operation: 'batch', args: { ops: [...args.ops, args.ops[0]] } }))
      .toThrow(/at most 100/);
  });

  it('refuses a review over the byte limit without seating any of the preview rows', () => {
    const f = fixture(); const before = f.snapshot();
    expect(() => f.hooks().capture(f.manifest.slug, { operation: 'upsert', args: {
      id: 'large', expected_version: 1, values: { title: 'Large', details: { note: 'x'.repeat(70 * 1024) } },
    } })).toThrow(/too large to review/);
    expect(f.snapshot()).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
  });

  it('requires a fresh review for legacy batch/upsert holds and rejects malformed insert evidence', () => {
    const f = fixture();
    const input = { operation: 'upsert', args: { id: 'new', expected_version: 1, values: { title: 'New' } } };
    expect(() => f.hooks().capture(f.manifest.slug, input, undefined, true)).toThrow(/older approval/);
    expect(() => f.hooks().capture(f.manifest.slug, { operation: 'batch', args: { ops: [op('create', 'new', { values: { title: 'New' } })] } }, undefined, true))
      .toThrow(/older approval/);
    const review = f.hooks().capture(f.manifest.slug, input)!;
    for (const generated_for of [-1, 100, 0.5, '0']) {
      expect(isResourceReview({ ...review, resources: [{ ...review.resources[0], precondition: { kind: 'records_absent', generated_for } }] })).toBe(false);
    }
    expect(isResourceReview({ ...review, resources: [{ ...review.resources[0], before: { title: 'Claimed absent' } }] })).toBe(false);
  });

  it('carries one combined batch review through the catalog gate and a serialized checkpoint', async () => {
    const f = fixture(); f.seed('edit');
    const input = { operation: 'batch', args: { ops: [op('update', 'edit', { set: { title: 'Edited' } }),
      op('upsert', 'new', { values: { title: 'New' } })] } };
    const ctx: ExecutionContext = { stores: createNamespaceStores({}, {}, {}), ingredientExecutor: vi.fn(),
      recordsReachabilityResolver: () => true, recordsOperationExecutor: call => f.store().execute(call), resourceReview: f.hooks(),
      execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'chat', user_id: 'owner' } };
    let held: PreflightRequiredSignal | undefined;
    try { await runCatalogOperation(ctx, f.manifest, f.manifest.slug, input, '', undefined, undefined, undefined); }
    catch (error) { if (!isPreflightRequiredSignal(error)) throw error; held = error; }
    const review = held?.resource_review;
    expect(review?.resources).toHaveLength(2);
    const checkpoint = JSON.parse(JSON.stringify({ checkpoint_id: 'cp', run_id: 'run', recipe_id: 'recipe',
      gated_step_id: 'bulk', step_state: {}, created_at: 1000, resource_review: review }));
    expect(isCheckpoint(checkpoint)).toBe(true);
    f.restart(); ctx.resourceReview = f.hooks();
    const result = await runCatalogOperation(ctx, f.manifest, f.manifest.slug, input, '', undefined, undefined, {
      step_id: 'bulk', recipe_id: 'recipe', preflight_admitted: true, resource_review: checkpoint.resource_review,
      preflight_approved_target: { ingredient_slug: f.manifest.slug, operation_id: 'fixture.note.batch', connection_name: '' },
    });
    expect(result).toMatchObject({ batch: true, count: 2 });
    expect(f.row('edit')!.title).toBe('Edited'); expect(f.row('new')!.title).toBe('New');
  });
});
