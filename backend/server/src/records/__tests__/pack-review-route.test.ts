import { describe, expect, it } from 'vitest';

import type {
  BulkPackManifest,
  RecordsNamespaceView,
  RecordsSchemaSnapshot,
} from '@recued/contracts';

import type { RecordsMigrationPlan } from '../migration.js';
import {
  buildRecordsPackUpdateReview,
  type PreparedRecordsReviewTarget,
} from '../pack-review.js';
import { resolveRecordsMigrationAuthority } from '../route-authority.js';
import type { RecordsStore } from '../store.js';

const OWNER = { publisher: 'publisher-a', pack_slug: 'board' } as const;
const schema = (slot: 's1' | 's2' = 's1'): RecordsSchemaSnapshot => ({
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot, kind: 'string', required: true },
      ],
    },
  },
});

const migration = (
  from_v: number,
  new_v: number,
  digest: string,
  operation: 'move' | 'clear' = 'move',
): RecordsMigrationPlan => ({
  recipe_id: `migrate-${from_v}-${new_v}-${digest}`,
  recipe_version: 1,
  recipe_digest: digest.repeat(64).slice(0, 64),
  from_v,
  new_v,
  steps: [{
    id: `map-${from_v}-${new_v}`,
    op: 'core.records.migrate',
    args: {
      kind: 'job',
      from_v,
      new_v,
      field_mapping: operation === 'clear'
        ? [{ op: 'clear', from: 'title' }]
        : [{ op: 'move', from: 'title', to: 'title' }],
    },
    args_hash: `${digest}-mapping`,
  }],
  finalizer: {
    id: `finalize-${from_v}-${new_v}`,
    op: 'core.records.finalize-migration',
    args: { from_v, new_v },
    args_hash: `${digest}-finalizer`,
  },
});

const manifest = (version: number): BulkPackManifest => ({
  manifest_version: 2,
  slug: OWNER.pack_slug,
  publisher: OWNER.publisher,
  name: 'Board',
  description: 'Board',
  version,
  recipes: [],
  requires: [],
  tags: [],
  contents: [],
  pack_kind: 'app_pack',
  service_kind: 'storage',
} as BulkPackManifest);

const namespace = (version: number, storageHash: string): RecordsNamespaceView => ({
  owner: OWNER,
  state: {
    state: 'ready',
    version,
    storage_schema_hash: storageHash,
    declaration_hash: `declaration-v${version}`,
  },
  activation_generation: 1,
  state_generation: 1,
  quota: {
    row_count: 1,
    payload_bytes: 10,
    row_limit: 100,
    byte_limit: 1_000,
    outbox_count: 0,
    outbox_limit: 100,
    data_generation: 1,
  },
  schema: schema(version === 1 ? 's1' : 's2'),
  artifact_digest: `artifact-v${version}`,
  subscriber_digest: 'subscribers',
  updated_at: 1,
});

const store = (
  current: RecordsNamespaceView,
  installedPlans: readonly RecordsMigrationPlan[],
): RecordsStore => ({
  getNamespace: () => current,
  getRetention: () => ({}),
  getGlobalQuota: () => ({
    row_count: 1,
    payload_bytes: 10,
    outbox_count: 0,
    reserved_payload_bytes: 0,
    row_limit: 1_000,
    byte_limit: 10_000,
    outbox_limit: 1_000,
  }),
  getInstalledMigrationPlans: () => [...installedPlans],
  listKinds: () => [{ kind: 'job', rows: 1, payload_bytes: 10 }],
  countActiveExecutionLeases: () => 0,
} as unknown as RecordsStore);

const target = (
  version: number,
  storageHash: string,
  migrationPlans: readonly RecordsMigrationPlan[],
): PreparedRecordsReviewTarget => ({
  composition: {} as PreparedRecordsReviewTarget['composition'],
  business_recipes: [],
  migration_plans: [...migrationPlans],
  target_storage_schema_hash: storageHash,
  target_declaration_hash: `declaration-v${version}`,
  target_artifact_digest: `artifact-v${version}`,
  target_schema: schema(version === 1 ? 's1' : 's2'),
});

describe('D-221 Records update route disclosure', () => {
  it('discloses destructive downgrade work from installed source authority', () => {
    const reverse = migration(2, 1, 'a', 'clear');
    const result = buildRecordsPackUpdateReview({
      manifest: manifest(1),
      target: target(1, 'storage-v1', []),
      store: store(namespace(2, 'storage-v2'), [reverse]),
    });

    expect(result?.review.destructive_changes).toEqual([{
      edge: '2->1',
      kind: 'job',
      step_id: 'map-2-1',
      operation: 'clear',
      from: 'title',
    }]);
  });

  it('refuses review when populated schema-changing data has no complete route', () => {
    expect(() => buildRecordsPackUpdateReview({
      manifest: manifest(2),
      target: target(2, 'storage-v2', []),
      store: store(namespace(1, 'storage-v1'), []),
    })).toThrow(/no complete monotonic migration route/);
  });

  it('does not hide ambiguous declared routes behind a schema-unchanged sweep', () => {
    const v1v2 = migration(1, 2, 'b');
    const v2v4 = migration(2, 4, 'c');
    const v1v3 = migration(1, 3, 'd');
    const v3v4 = migration(3, 4, 'e');
    expect(() => buildRecordsPackUpdateReview({
      manifest: manifest(4),
      target: target(4, 'storage-v1', [v2v4, v3v4]),
      store: store(namespace(1, 'storage-v1'), []),
      migration_artifacts: [
        {
          owner: OWNER,
          version: 2,
          artifact_digest: 'artifact-v2',
          storage_schema_hash: 'storage-v2',
          declaration_hash: 'declaration-v2',
          schema: schema('s2'),
          migration_plans: [v1v2],
        },
        {
          owner: OWNER,
          version: 3,
          artifact_digest: 'artifact-v3',
          storage_schema_hash: 'storage-v3',
          declaration_hash: 'declaration-v3',
          schema: schema('s2'),
          migration_plans: [v1v3],
        },
      ],
    })).toThrow(/equal-shortest ambiguity/);
  });
});

describe('D-221 upgrade authority: a natural_key change is a rekey, not a sweep', () => {
  const base = {
    owner: OWNER,
    from_version: 1,
    target_version: 2,
    // IDENTICAL storage hash — a natural key projects no field, so adding one
    // leaves this untouched. That is why nothing upstream can see the transition.
    source_storage_schema_hash: 'a'.repeat(64),
    target_storage_schema_hash: 'a'.repeat(64),
    source_artifact_digest: 'artifact-v1',
    target_artifact_digest: 'artifact-v2',
    source_schema: schema(),
    target_schema: schema(),
    source_plans: [] as RecordsMigrationPlan[],
    target_plans: [] as RecordsMigrationPlan[],
    migration_artifacts: [],
    populated_entities: ['job'],
  };

  /** One valid declared v1->v2 edge. Its CONTENT is irrelevant: no mapping op
   *  rewrites a `pk`, so no route can relocate a rekeyed row. */
  const declaredRoute = [{
    recipe_id: 'migrate-v1-v2',
    recipe_version: 1,
    recipe_digest: 'd'.repeat(64),
    from_v: 1,
    new_v: 2,
    steps: [{
      id: 't', op: 'core.records.migrate', args_hash: 'h',
      kind: 'job', from_v: 1, new_v: 2, field_mapping: [],
    }],
    finalizer: { id: 'f', op: 'core.records.finalize-migration', args_hash: 'g', from_v: 1, new_v: 2 },
  }] as unknown as RecordsMigrationPlan[];

  it('takes the schema-unchanged sweep when the keys agree — the permitting case', () => {
    expect(resolveRecordsMigrationAuthority({ ...base }))
      .toMatchObject({ route: [], synthetic_schema_unchanged_upgrade: true });
    expect(resolveRecordsMigrationAuthority({
      ...base,
      source_natural_keys: { job: ['tenant', 'email'] },
      target_natural_keys: { job: ['email', 'tenant'] },
    })).toMatchObject({ synthetic_schema_unchanged_upgrade: true });
  });

  it('admits a rekey of an entity holding NO rows — there are no ids to be wrong', () => {
    // Without this the guard blocks an ordinary pack update that adds a key to a
    // brand-new entity, because a SIBLING entity happens to hold data.
    expect(resolveRecordsMigrationAuthority({
      ...base,
      populated_entities: [],
      target_natural_keys: { job: ['email'] },
    })).toMatchObject({ synthetic_schema_unchanged_upgrade: true });
    expect(resolveRecordsMigrationAuthority({
      ...base,
      populated_entities: ['other'],
      target_natural_keys: { job: ['email'] },
    })).toMatchObject({ synthetic_schema_unchanged_upgrade: true });
  });

  it.each([
    ['a key ADDED', undefined, { job: ['email'] }],
    ['a key REMOVED', { job: ['email'] }, undefined],
    ['a key CHANGED', { job: ['email'] }, { job: ['tenant'] }],
  ])('refuses %s on a populated entity', (_label, source, target) => {
    expect(() => resolveRecordsMigrationAuthority({
      ...base,
      ...(source ? { source_natural_keys: source } : {}),
      ...(target ? { target_natural_keys: target } : {}),
    })).toThrow(/natural_key changed on populated job\. Records v1 has no mapping that rewrites a primary key/);
  });

  it('⛔ a DECLARED route does not silence it, because no mapping rewrites a pk', () => {
    // This guard first shipped inside the no-route `catch`, so declaring any
    // unrelated v1->v2 edge silenced it completely and the rekey was admitted.
    // The closed mapping vocabulary is field-only and `change_kind` preserves
    // `pk` (§ 10.4), so a route's presence is not the author having handled it.
    expect(() => resolveRecordsMigrationAuthority({
      ...base,
      target_plans: declaredRoute,
      target_natural_keys: { job: ['email'] },
    })).toThrow(/natural_key changed on populated job/);
    // The permitting half: that same declared route still resolves normally when
    // no key changed, so this refuses the REKEY and not the route.
    expect(resolveRecordsMigrationAuthority({ ...base, target_plans: declaredRoute }))
      .toMatchObject({ synthetic_schema_unchanged_upgrade: false });
  });
});
