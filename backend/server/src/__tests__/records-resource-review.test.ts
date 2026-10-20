import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { isResourceReview, type IngredientManifest, type RecordsExecutionBinding, type RecordsSchemaSnapshot } from '@recued/contracts';
import { runCatalogOperation, type ExecutionContext } from '@recued/engine';
import { createRecordsStore } from '../records/store.js';
import { createNamespaceStores } from '../server-executor.js';
import { createResourceReviewHooks } from '../resource-review.js';

const setup = (db: Database.Database) => {
  const owner = { publisher: 'recued-core', pack_slug: 'review-fixture' };
  const bind = (action: 'create' | 'update' | 'delete'): RecordsExecutionBinding => ({
    kind: 'core.records', action, entity: 'note', owner, pack_version: 1,
    storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: action,
  });
  const bindings = { create: bind('create'), update: bind('update'), delete: bind('delete') };
  const schema: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
    { key: 'id', kind: 'id', slot: 'pk', required: true },
    { key: 'title', kind: 'string', slot: 's1', required: true },
  ] } } };
  const store = createRecordsStore(db, { now: () => 1_000 });
  store.installNamespace({ owner, version: 1, storage_schema_hash: 'a'.repeat(64),
    declaration_hash: 'b'.repeat(64), artifact_digest: 'fixture', schema, bindings });
  store.execute({ binding: bindings.create, principal: 'owner', args: { id: 'note-1', values: { title: 'Before' } } });
  const manifest: IngredientManifest = {
    slug: 'review-fixture', name: 'Review fixture', description: 'Review fixture', author: owner.publisher,
    kind: 'storage', version: 1, category: 'data', risk_tier: 'read',
    input: { operation: null, args: null }, output: { result: 'result' },
    operations: {
      update: { operation_id: 'fixture.note.update', risk_tier: 'write', approval: 'always', groups: ['note.write'] },
      delete: { operation_id: 'fixture.note.delete', risk_tier: 'destructive', approval: 'always', groups: ['note.write'] },
    },
    operation_groups: { 'note.write': { group_id: 'note.write', operations: ['update', 'delete'], risk_floor: 'write' } },
    surfaces: { records: { executes: bindings, schema } },
  };
  const hooks = createResourceReviewHooks({ manifest: () => manifest, records: store, now: () => 1_000 });
  return { owner, bindings, store, hooks, manifest };
};

describe('Records uses the shared resource review and its existing atomic revision check', () => {
  it.each(['update', 'delete'] as const)('refuses a changed %s, including a race after the review check', verb => {
    const db = new Database(':memory:');
    try {
      const { owner, bindings, store, hooks } = setup(db);
      const args = { id: 'note-1', expected_version: 1, expected_revision: 0,
        ...(verb === 'update' ? { set: { title: 'Approved' } } : {}) };
      const input = { operation: verb, args };
      const review = hooks.capture('fixture', input)!;
      expect(review.resources[0]).toMatchObject({ kind: 'records', precondition: { kind: 'records_revision', value: 0 },
        before: { title: 'Before' }, after: verb === 'delete' ? null : { title: 'Approved' } });
      expect(hooks.capture('fixture', input, review, true)).toEqual(review);
      // A competing transaction happens after the last pre-dispatch check.
      store.execute({ binding: bindings.update, principal: 'owner',
        args: { id: 'note-1', expected_version: 1, expected_revision: 0, set: { title: 'Other edit' } } });
      expect(() => hooks.run(review, () => store.execute({ binding: bindings[verb], principal: 'owner', args })))
        .toThrow(/changed|stale Records/);
      expect(store.ownerGet(owner, 'note', 'note-1')!.title).toBe('Other edit');
      expect(() => hooks.capture('fixture', input, review, true)).toThrow(/out of date/);
      const freshInput = { operation: verb, args: { ...args, expected_revision: 1 } };
      const fresh = hooks.capture('fixture', freshInput)!;
      expect(fresh.resources[0]!.before.title).toBe('Other edit');
      hooks.run(fresh, () => store.execute({ binding: bindings[verb], principal: 'owner', args: freshInput.args }));
      expect(store.ownerGet(owner, 'note', 'note-1')?.title).toBe(verb === 'delete' ? undefined : 'Approved');

      // Reuse the same ID and timestamps, with an identical revision-zero row.
      if (verb === 'update') store.execute({ binding: bindings.delete, principal: 'owner',
        args: { id: 'note-1', expected_version: 1, expected_revision: 2 } });
      store.execute({ binding: bindings.create, principal: 'owner', args: { id: 'note-1', values: { title: 'Before' } } });
      const replacement = hooks.capture('fixture', input)!;
      expect(replacement.resources[0]!.version).not.toBe(review.resources[0]!.version);
      expect(() => hooks.capture('fixture', input, review, true)).toThrow(/changed after review/);
      // The final transaction must refuse even if replacement races the last check.
      expect(() => hooks.run(review, () => store.execute({ binding: bindings[verb], principal: 'owner', args })))
        .toThrow(/replaced after review/);
      expect(store.ownerGet(owner, 'note', 'note-1')!.title).toBe('Before');
    } finally { db.close(); }
  });

  it('heals an interrupted incarnation upgrade and preserves the recovered token on reopen', () => {
    const db = new Database(':memory:');
    try {
      const { owner, manifest } = setup(db);
      db.exec('DROP TRIGGER core_records_resource_incarnation');
      db.exec('UPDATE core_records SET resource_incarnation = NULL');
      const restored = createRecordsStore(db);
      const hooks = createResourceReviewHooks({ manifest: () => manifest, records: restored });
      const input = { operation: 'update', args: { id: 'note-1', expected_version: 1, expected_revision: 0, set: { title: 'After' } } };
      const review = hooks.capture('fixture', input)!;
      expect(isResourceReview(review)).toBe(true);
      expect(review.resources[0]!.precondition).toMatchObject({ incarnation: expect.stringMatching(/^[a-f0-9]{32}$/) });
      expect(restored.ownerGet(owner, 'note', 'note-1')!.title).toBe('Before');
      const recovered = restored.reviewSnapshot(owner, 'note', 'note-1');
      const reopened = createRecordsStore(db);
      expect(reopened.reviewSnapshot(owner, 'note', 'note-1')).toEqual(recovered);
    } finally { db.close(); }
  });

  it('rolls the incarnation column back if its insert trigger cannot be installed', () => {
    const db = new Database(':memory:');
    try {
      setup(db);
      db.exec('DROP TRIGGER core_records_resource_incarnation');
      db.exec('ALTER TABLE core_records DROP COLUMN resource_incarnation');
      const exec = db.exec.bind(db);
      const intercepted = vi.spyOn(db, 'exec').mockImplementation(sql => {
        if (sql.includes('CREATE TRIGGER IF NOT EXISTS core_records_resource_incarnation')) throw new Error('interrupted trigger install');
        return exec(sql);
      });
      expect(() => createRecordsStore(db)).toThrow('interrupted trigger install');
      intercepted.mockRestore();
      const columns = db.prepare('PRAGMA table_info(core_records)').all() as { name: string }[];
      expect(columns.some(column => column.name === 'resource_incarnation')).toBe(false);
      expect(() => createRecordsStore(db)).not.toThrow();
    } finally { db.close(); }
  });

  it.each(['missing', 'unsupported'] as const)('refuses a catalog resume when its saved review guard is %s', async mode => {
    const db = new Database(':memory:');
    try {
      const { manifest, hooks } = setup(db);
      const input = { operation: 'update', args: { id: 'note-1', expected_version: 1, expected_revision: 0, set: { title: 'After' } } };
      const review = hooks.capture(manifest.slug, input)!;
      const executor = vi.fn();
      const ctx: ExecutionContext = {
        stores: createNamespaceStores({}, {}, {}), ingredientExecutor: vi.fn(), recordsOperationExecutor: executor,
        recordsReachabilityResolver: () => true,
        execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'chat', user_id: 'owner' },
        ...(mode === 'unsupported' ? { resourceReview: createResourceReviewHooks({ manifest: () => undefined }) } : {}),
      };
      await expect(runCatalogOperation(ctx, manifest, manifest.slug, input, '', undefined, undefined, {
        step_id: 'write', recipe_id: 'review', preflight_admitted: true, resource_review: review,
        preflight_approved_target: { ingredient_slug: manifest.slug, operation_id: 'fixture.note.update' },
      })).rejects.toMatchObject({ code: 'resource_conflict' });
      expect(executor).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('captures a Records catalog snapshot only when an independent grant no longer admits the call', async () => {
    const db = new Database(':memory:');
    try {
      const { manifest, hooks, store } = setup(db);
      manifest.operations!.update!.approval = 'ask';
      const capture = vi.fn(hooks.capture);
      const consume = vi.fn(() => true);
      const match = vi.fn(() => 'grant');
      const ctx: ExecutionContext = {
        stores: createNamespaceStores({}, {}, {}), ingredientExecutor: vi.fn(),
        recordsOperationExecutor: vi.fn(call => store.execute(call)), recordsReachabilityResolver: () => true,
        execution_source: { channel: 'chat', actor: 'contracted_user', contract_id: 'contract', chat_session_id: 'chat', user_id: 'owner' },
        resourceReview: { ...hooks, capture },
        catalogSessionGrants: { match, consume, mint() {} },
      };
      const input = { operation: 'update', args: { id: 'note-1', expected_version: 1, expected_revision: 0, set: { title: 'After' } } };
      await expect(runCatalogOperation(ctx, manifest, manifest.slug, input, '', undefined, undefined, undefined))
        .resolves.toMatchObject({ record: { title: 'After' } });
      expect(capture).not.toHaveBeenCalled();
      expect(match).toHaveBeenCalledTimes(1);
      expect(consume).toHaveBeenCalledTimes(1);
      consume.mockReturnValue(false);
      const second = { ...input, args: { ...input.args, expected_revision: 1, set: { title: 'Next' } } };
      await expect(runCatalogOperation(ctx, manifest, manifest.slug, second, '', undefined, undefined, undefined))
        .rejects.toMatchObject({ resource_review: { resources: [{ before: { title: 'After' }, after: { title: 'Next' } }] } });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(ctx.recordsOperationExecutor).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});
