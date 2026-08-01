import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  RecordsExecutionBinding,
  RecordsSchemaSnapshot,
} from '@recued/contracts';

import type {
  RecordsMigrationFinalizeStep,
  RecordsMigrationTransformStep,
  RecordsMigrationVerifyStep,
} from '../migration.js';
import {
  createRecordsStore,
  RECORDS_TABLES,
  type RecordsMigrationStartInput,
  type RecordsStore,
} from '../store.js';

const OWNER = { publisher: 'recued-core', pack_slug: 'job-status-board' } as const;
const OTHER = { publisher: 'publisher-b', pack_slug: 'other-records-pack' } as const;
const V1_STORAGE = '1'.repeat(64);
const V2_STORAGE = '2'.repeat(64);
const V1_DECLARATION = 'a'.repeat(64);
const V2_DECLARATION = 'b'.repeat(64);
const RECIPE_DIGEST = 'c'.repeat(64);

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

const v1Schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
      ],
    },
  },
};
const v2Schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'name', slot: 's2', kind: 'string', required: true },
        { key: 'category', slot: 's3', kind: 'string', required: true },
      ],
    },
    job_event: {
      kind: 'job_event',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'event', slot: 's1', kind: 'string', required: true },
        { key: 'job_ref', slot: 'r1', kind: 'ref', required: true },
      ],
    },
  },
};

const binding = (
  action: RecordsExecutionBinding['action'],
  version: number,
  storage: string,
  declaration: string,
): RecordsExecutionBinding => ({
  kind: 'core.records',
  action,
  entity: 'job',
  owner: OWNER,
  pack_version: version,
  storage_schema_hash: storage,
  declaration_hash: declaration,
  operation_digest: `${version}:${action}`,
});

const v1Bindings = {
  create: binding('create', 1, V1_STORAGE, V1_DECLARATION),
  get: binding('get', 1, V1_STORAGE, V1_DECLARATION),
};
const v2Bindings = {
  create: binding('create', 2, V2_STORAGE, V2_DECLARATION),
  get: binding('get', 2, V2_STORAGE, V2_DECLARATION),
};

const transformArgs = {
  kind: 'job',
  from_v: 1,
  new_v: 2,
  field_mapping: [
    { op: 'move', from: 'title', to: 'name' },
    { op: 'default', to: 'category', value: 'service' },
  ] as const,
};
const transform: RecordsMigrationTransformStep = {
  id: 'move-title',
  op: 'core.records.migrate',
  args: { ...transformArgs, field_mapping: [...transformArgs.field_mapping] },
  args_hash: hash(transformArgs),
};
const verifyArgs = { kind: 'job', from_v: 1, new_v: 2 };
const verify: RecordsMigrationVerifyStep = {
  id: 'verify-job',
  op: 'core.records.verify-migration',
  args: verifyArgs,
  args_hash: hash(verifyArgs),
};
const finalizerArgs = { from_v: 1, new_v: 2 };
const finalizer: RecordsMigrationFinalizeStep = {
  id: 'sweep-version',
  op: 'core.records.finalize-migration',
  args: finalizerArgs,
  args_hash: hash(finalizerArgs),
};
const requiredSteps = [transform, verify, finalizer].map((step) => ({
  recipe_digest: RECIPE_DIGEST,
  step_id: step.id,
  args_hash: step.args_hash,
  op: step.op,
}));
const orderedSteps = [transform, verify, finalizer].map((step) => ({
  recipe_digest: RECIPE_DIGEST,
  step,
}));

describe('D-221 durable Records migration kernel and Job Status Board v1->v2 fixture', () => {
  let db: Database.Database;
  let store: RecordsStore;
  let tick: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    tick = 1_900_000_000_000;
    store = createRecordsStore(db, { now: () => tick++ });
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: V1_STORAGE,
      declaration_hash: V1_DECLARATION,
      artifact_digest: 'artifact-v1',
      schema: v1Schema,
      bindings: v1Bindings,
    });
  });

  afterEach(() => db.close());

  const startInput = (): RecordsMigrationStartInput => ({
    owner: OWNER,
    migration_id: 'migration-v1-v2',
    plan_digest: hash(requiredSteps),
    from_version: 1,
    target_version: 2,
    target_storage_schema_hash: V2_STORAGE,
    target_declaration_hash: V2_DECLARATION,
    target_artifact_digest: 'artifact-v2',
    target_schema: v2Schema,
    route_schemas: { '1': v1Schema, '2': v2Schema },
    artifact_pins: { '1': 'artifact-v1', '2': 'artifact-v2' },
    target_bindings: v2Bindings,
    target_subscriber_digest: hash([]),
    target_subscribers: [],
    required_steps: requiredSteps,
    ordered_steps: orderedSteps,
    expected_state_generation: store.getNamespace(OWNER)!.state_generation,
  });

  const runTransform = (lock: number, batchSize = 1) => store.runMigrationTransform({
    owner: OWNER,
    migration_id: 'migration-v1-v2',
    lock_generation: lock,
    recipe_digest: RECIPE_DIGEST,
    step: transform,
    batch_size: batchSize,
  });

  it('resumes bounded transforms/finalization from durable cursors and promotes only after all receipts', () => {
    for (const id of ['a', 'b', 'c']) {
      store.execute({ binding: v1Bindings.create, args: { id, values: { title: `Title ${id}` } }, principal: 'owner' });
    }
    const started = store.beginMigration(startInput());
    expect(store.listOutbox(OWNER, 'pending')).toEqual([]);
    expect(store.listOutbox(OWNER, 'dead_letter')).toHaveLength(3);
    expect(() => store.execute({ binding: v1Bindings.get, args: { id: 'a' }, principal: 'owner' }))
      .toThrow(/migrating/);

    expect(runTransform(started.lock_generation)).toMatchObject({ done: false, cursor: 'a', rows_changed: 1 });
    const afterFirst = db.prepare(`SELECT s1,s2,revision,version FROM ${RECORDS_TABLES.rows}
      WHERE publisher=? AND pack_slug=? AND kind='job' AND pk='a'`)
      .get(OWNER.publisher, OWNER.pack_slug) as Record<string, unknown>;
    expect(afterFirst).toMatchObject({ s1: null, s2: 'Title a', revision: 1, version: 1 });

    store = createRecordsStore(db, { now: () => tick++ });
    expect(store.beginMigration({ ...startInput(), expected_state_generation: started.lock_generation }))
      .toMatchObject({ lock_generation: started.lock_generation, status: 'running' });
    expect(runTransform(started.lock_generation)).toMatchObject({ done: false, cursor: 'b', rows_changed: 2 });
    expect(runTransform(started.lock_generation)).toMatchObject({ done: true, cursor: 'c', rows_changed: 3 });

    const requiredReceipts = requiredSteps.slice(0, -1).map(({ recipe_digest, step_id, args_hash }) => ({
      recipe_digest, step_id, args_hash,
    }));
    expect(() => store.runMigrationFinalizer({
      owner: OWNER,
      migration_id: 'migration-v1-v2',
      lock_generation: started.lock_generation,
      recipe_digest: RECIPE_DIGEST,
      step: finalizer,
      required_receipts: requiredReceipts,
      batch_size: 1,
    })).toThrow(/out of order/);

    expect(store.runMigrationVerify({
      owner: OWNER,
      migration_id: 'migration-v1-v2',
      lock_generation: started.lock_generation,
      recipe_digest: RECIPE_DIGEST,
      step: verify,
      batch_size: 10,
    })).toMatchObject({ done: true, rows_changed: 0 });

    const firstSweep = store.runMigrationFinalizer({
      owner: OWNER,
      migration_id: 'migration-v1-v2',
      lock_generation: started.lock_generation,
      recipe_digest: RECIPE_DIGEST,
      step: finalizer,
      required_receipts: requiredReceipts,
      batch_size: 1,
    });
    expect(firstSweep).toMatchObject({ done: false, rows_changed: 1 });
    expect(db.prepare(`SELECT version,revision FROM ${RECORDS_TABLES.rows}
      WHERE publisher=? AND pack_slug=? AND kind='job' AND pk='a'`)
      .get(OWNER.publisher, OWNER.pack_slug)).toEqual({ version: 2, revision: 1 });

    store = createRecordsStore(db, { now: () => tick++ });
    let sweep = firstSweep;
    while (!sweep.done) {
      sweep = store.runMigrationFinalizer({
        owner: OWNER,
        migration_id: 'migration-v1-v2',
        lock_generation: started.lock_generation,
        recipe_digest: RECIPE_DIGEST,
        step: finalizer,
        required_receipts: requiredReceipts,
        batch_size: 1,
      });
    }
    const promoted = store.promoteMigration({
      owner: OWNER,
      migration_id: 'migration-v1-v2',
      lock_generation: started.lock_generation,
      finalizer: {
        recipe_digest: RECIPE_DIGEST,
        step_id: finalizer.id,
        args_hash: finalizer.args_hash,
      },
    });
    expect(promoted.state).toMatchObject({ state: 'ready', version: 2 });
    expect(promoted.schema.entities).toHaveProperty('job_event');
    expect(promoted.quota).toMatchObject({ row_count: 3, data_generation: 6, outbox_count: 0 });
    expect(store.execute({ binding: v2Bindings.get, args: { id: 'c' }, principal: 'owner' }))
      .toMatchObject({ record: { id: 'c', name: 'Title c', category: 'service', _record: { version: 2, revision: 1 } } });
    expect(() => store.execute({ binding: v1Bindings.get, args: { id: 'c' }, principal: 'owner' }))
      .toThrow(/ready activation|does not match/);
  });

  it('durably reserves proven migration growth against writes from another pack', () => {
    store.execute({
      binding: v1Bindings.create,
      args: { id: 'a', values: { title: 'Title a' } },
      principal: 'owner',
    });
    const otherCreate: RecordsExecutionBinding = {
      ...v1Bindings.create,
      owner: OTHER,
      operation_digest: 'other:create',
    };
    store.installNamespace({
      owner: OTHER,
      version: 1,
      storage_schema_hash: V1_STORAGE,
      declaration_hash: V1_DECLARATION,
      artifact_digest: 'artifact-other',
      schema: v1Schema,
      bindings: { create: otherCreate },
    });
    const preflight = store.preflightMigration({
      start: startInput(),
      ordered_steps: orderedSteps,
    });
    expect(preflight.byte_delta).toBeGreaterThan(0);
    const before = store.getGlobalQuota();
    store.setGlobalQuota({
      byte_limit: before.payload_bytes + preflight.byte_delta,
    });
    store.beginMigration({
      ...startInput(),
      reserved_byte_delta: preflight.byte_delta,
    });
    expect(store.getGlobalQuota().reserved_payload_bytes).toBe(preflight.byte_delta);
    expect(() => store.execute({
      binding: otherCreate,
      args: { id: 'b', values: { title: 'Other row' } },
      principal: 'owner',
    })).toThrow(/global Records quota/);
    expect(store.ownerGet(OTHER, 'job', 'b')).toBeNull();
  });

  it('does not let a finalizer sweep an unexpected third version clean', () => {
    store.execute({ binding: v1Bindings.create, args: { id: 'a', values: { title: 'A' } }, principal: 'owner' });
    const autoFinalizer = { ...finalizer, id: 'auto-sweep' };
    const autoRequired = [{
      recipe_digest: RECIPE_DIGEST,
      step_id: autoFinalizer.id,
      args_hash: autoFinalizer.args_hash,
      op: autoFinalizer.op,
    }];
    const started = store.beginMigration({
      ...startInput(),
      plan_digest: hash(autoRequired),
      required_steps: autoRequired,
      ordered_steps: [{ recipe_digest: RECIPE_DIGEST, step: autoFinalizer }],
    });
    db.prepare(`UPDATE ${RECORDS_TABLES.rows} SET version=9
      WHERE publisher=? AND pack_slug=? AND kind='job' AND pk='a'`)
      .run(OWNER.publisher, OWNER.pack_slug);
    expect(() => store.runMigrationFinalizer({
      owner: OWNER,
      migration_id: 'migration-v1-v2',
      lock_generation: started.lock_generation,
      recipe_digest: RECIPE_DIGEST,
      step: autoFinalizer,
      required_receipts: [],
    })).toThrow(/unexpected row version/);
    expect(store.getNamespace(OWNER)?.state.state).toBe('migrating');
    expect(store.getMigration(OWNER)?.status).toBe('failed');
    expect(db.prepare(`SELECT version FROM ${RECORDS_TABLES.rows}
      WHERE publisher=? AND pack_slug=? AND kind='job' AND pk='a'`)
      .get(OWNER.publisher, OWNER.pack_slug)).toEqual({ version: 9 });
  });

  it('refuses stale lock generations before a resumed batch can mutate another row', () => {
    store.execute({ binding: v1Bindings.create, args: { id: 'a', values: { title: 'A' } }, principal: 'owner' });
    const started = store.beginMigration(startInput());
    db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET state_generation=state_generation+1
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);
    expect(() => runTransform(started.lock_generation)).toThrow(/stale Records migration lock/);
    expect(db.prepare(`SELECT s1,s2,revision FROM ${RECORDS_TABLES.rows}
      WHERE publisher=? AND pack_slug=? AND kind='job' AND pk='a'`)
      .get(OWNER.publisher, OWNER.pack_slug)).toEqual({ s1: 'A', s2: null, revision: 0 });
  });
  it('refuses promotion when a row sits at an id the target natural_key does not derive', () => {
    // Defence in depth for the rekey the upgrade authority already refuses. That
    // gate lives in the install coordinator and takes its keys from a CALLER;
    // this one re-derives every id from the bindings PERSISTED at
    // `beginMigration`, so a promotion cannot enter `ready(target)` claiming a
    // key its rows do not satisfy — however it was reached.
    for (const id of ['a', 'b', 'c']) {
      store.execute({ binding: v1Bindings.create, args: { id, values: { title: `Title ${id}` } }, principal: 'owner' });
    }
    const keyedTarget = {
      ...v2Bindings,
      create: { ...v2Bindings.create, natural_key: ['name'] },
    };
    const started = store.beginMigration({ ...startInput(), target_bindings: keyedTarget });
    let step = runTransform(started.lock_generation, 10);
    while (!step.done) step = runTransform(started.lock_generation, 10);
    store.runMigrationVerify({
      owner: OWNER, migration_id: 'migration-v1-v2', lock_generation: started.lock_generation,
      recipe_digest: RECIPE_DIGEST, step: verify, batch_size: 10,
    });
    const requiredReceipts = requiredSteps.slice(0, -1).map(({ recipe_digest, step_id, args_hash }) => ({
      recipe_digest, step_id, args_hash,
    }));
    let sweep = store.runMigrationFinalizer({
      owner: OWNER, migration_id: 'migration-v1-v2', lock_generation: started.lock_generation,
      recipe_digest: RECIPE_DIGEST, step: finalizer, required_receipts: requiredReceipts, batch_size: 10,
    });
    while (!sweep.done) {
      sweep = store.runMigrationFinalizer({
        owner: OWNER, migration_id: 'migration-v1-v2', lock_generation: started.lock_generation,
        recipe_digest: RECIPE_DIGEST, step: finalizer, required_receipts: requiredReceipts, batch_size: 10,
      });
    }

    const promote = () => store.promoteMigration({
      owner: OWNER,
      migration_id: 'migration-v1-v2',
      lock_generation: started.lock_generation,
      finalizer: { recipe_digest: RECIPE_DIGEST, step_id: finalizer.id, args_hash: finalizer.args_hash },
    });

    // Every row was created at a caller-chosen id under v1, so none of them sits
    // where the new key derives. The check reports the id it DOES derive, and it
    // fires per row — walk them, relocating each to its derived id, and the
    // refusal must recur until the last one is right.
    const relocated: string[] = [];
    for (let guard = 0; guard < 4; guard += 1) {
      let error: { code?: string; details?: { id?: string; derived_id?: string } } | undefined;
      try { promote(); } catch (caught) { error = caught as typeof error; }
      if (error === undefined) break;
      expect(error.code).toBe('records_incoherent');
      expect(error.details?.derived_id).toMatch(/^nk_[0-9a-f]{64}$/);
      // Refused, and refused BEFORE promotion: still migrating, nothing flipped.
      expect(store.getNamespace(OWNER)?.state.state).toBe('migrating');
      db.prepare(`UPDATE ${RECORDS_TABLES.rows} SET pk=?
        WHERE publisher=? AND pack_slug=? AND kind='job' AND pk=?`)
        .run(error.details!.derived_id, OWNER.publisher, OWNER.pack_slug, error.details!.id);
      relocated.push(error.details!.derived_id!);
    }
    // It caught all three, not just the first.
    expect(relocated).toHaveLength(3);
    expect(new Set(relocated).size).toBe(3);

    // The permitting case, and it uses the store's OWN derived ids: once every
    // row sits where the target key puts it, the identical promotion succeeds.
    // So this refuses a rekeyed row, not promotion-under-a-natural_key.
    expect(store.getNamespace(OWNER)?.state)
      .toMatchObject({ state: 'ready', version: 2 });
    expect(store.execute({
      binding: keyedTarget.get,
      args: { id: relocated[0] },
      principal: 'owner',
    })).toMatchObject({ record: { id: relocated[0], category: 'service' } });
  });
});
