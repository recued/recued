import { describe, expect, it } from 'vitest';
import { isExternallyExposableIngredient } from '@recued/contracts';

import type { CompositionIngredient } from '../schema.js';
import {
  decomposeComposition,
  hashRecordsDeclaration,
  recordsEntitySchemas,
  recordsSchemaSnapshot,
  stampRecordsCatalog,
  validateComposition,
} from '../index.js';

const operation = (
  op: string,
  action: string,
  risk: 'read' | 'write' | 'destructive',
  args: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({
  op,
  ingredient: 'job-status-board-records',
  risk,
  approval: action === 'delete' ? 'always' : 'never',
  args,
  bind: { kind: 'core.records', action, entity: op.startsWith('job_event.') ? 'job_event' : 'job', ...extra },
});

/** The D-221 compatibility/golden composition: existing composition, storage,
 * entity, operation, arg, and bind cells only. */
const jobStatusBoard = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'job-status-board',
  ingredients: [{
    slug: 'job-status-board-records',
    kind: 'storage',
    entities: {
      job: {
        fields: [
          { maps_to: 'id', field_path: 'pk', type: 'string', source_operation: 'job.get', pii: 'external_id' },
          { maps_to: 'title', field_path: 's1', type: 'string', source_operation: 'job.get', pii: 'content' },
          { maps_to: 'contact.name', field_path: 's2', type: 'string', optional: true, source_operation: 'job.get', pii: 'name' },
          { maps_to: 'status', field_path: 's3', type: 'string', source_operation: 'job.get' },
          { maps_to: 'due_at', field_path: 'dt1', type: 'datetime', optional: true, date_granularity: 'datetime', source_operation: 'job.get' },
          { maps_to: 'archived', field_path: 'b1', type: 'boolean', source_operation: 'job.get' },
          { maps_to: 'parent_job_ref', field_path: 'r1', type: 'string', optional: true, source_operation: 'job.get', pii: 'external_id' },
        ],
      },
      job_event: {
        fields: [
          { maps_to: 'id', field_path: 'pk', type: 'string', source_operation: 'job_event.get', pii: 'external_id' },
          { maps_to: 'event', field_path: 's1', type: 'string', source_operation: 'job_event.get' },
          { maps_to: 'note', field_path: 't1', type: 'string', optional: true, source_operation: 'job_event.get', pii: 'content' },
          { maps_to: 'at', field_path: 'dt1', type: 'datetime', date_granularity: 'datetime', source_operation: 'job_event.get' },
          { maps_to: 'job_ref', field_path: 'r1', type: 'string', source_operation: 'job_event.get', pii: 'external_id' },
        ],
      },
    },
  }],
  operations: [
    operation('job.create', 'create', 'write', [
      { key: 'id', type: 'string' },
      { key: 'values', type: 'object', required: true },
    ]),
    operation('job.get', 'get', 'read', [
      { key: 'id', type: 'string', required: true, affects_target: true },
    ]),
    operation('job.search', 'search', 'read', [
      { key: 'filters', type: 'object' },
      { key: 'sort', type: 'string' },
      { key: 'cursor', type: 'string' },
      { key: 'limit', type: 'number' },
    ], { filter_fields: ['status', 'due_at', 'archived', 'parent_job_ref'], sort_fields: ['due_at', '_record.updated_at'] }),
    operation('job.update', 'update', 'write', [
      { key: 'id', type: 'string', required: true, affects_target: true },
      { key: 'expected_version', type: 'number', required: true },
      { key: 'expected_revision', type: 'number', required: true },
      { key: 'set', type: 'object' },
      { key: 'unset', type: 'array' },
    ]),
    operation('job.delete', 'delete', 'destructive', [
      { key: 'id', type: 'string', required: true, affects_target: true },
      { key: 'expected_version', type: 'number', required: true },
      { key: 'expected_revision', type: 'number', required: true },
    ]),
    operation('job_event.create', 'create', 'write', [
      { key: 'id', type: 'string' },
      { key: 'values', type: 'object', required: true },
    ]),
    operation('job_event.get', 'get', 'read', [
      { key: 'id', type: 'string', required: true, affects_target: true },
    ]),
  ],
} as unknown as CompositionIngredient);

/** Turn the fixture's `job.create` into a legal natural_key create: a keyed
 *  create derives its own id, so it may not declare an `id` arg. */
const keyJobCreate = (value: CompositionIngredient): void => {
  const create = value.operations[0]!;
  create.args = [{ key: 'values', type: 'object', required: true }] as typeof create.args;
  (create.bind as Record<string, unknown>).natural_key = ['status'];
};

describe('D-221 existing-composition Records authoring', () => {
  it('accepts and always lowers the one-storage canary to a catalog plus local PII carrier', () => {
    const composition = jobStatusBoard();
    const validation = validateComposition(composition);
    expect(validation.valid).toBe(true);
    expect(validation.issues.filter((entry) => entry.severity === 'error')).toEqual([]);

    const artifacts = decomposeComposition[1]!(composition);
    expect(artifacts.ingredient).toBeUndefined();
    expect(artifacts.catalog?.kind).toBe('storage');
    expect(artifacts.catalog?.surfaces?.records?.executes['job.create']).toMatchObject({
      kind: 'core.records',
      action: 'create',
      entity: 'job',
    });
    expect(artifacts.entity_schemas).toHaveLength(2);
    expect(artifacts.entity_schemas?.[0]?.scope).toBe('data.entity.unverified.job-status-board.job');
    expect(artifacts.entity_schemas?.[0]?.meta_fields?.find((field) => field.key === 'title')?.privacy).toBe('content');
  });

  it('refuses a reference target that is not a declared entity, or not a ref slot', () => {
    // ⛔ An unresolvable target is worse than none: a picker and a prefix check
    // would both trust it. The target is what turns "this field IS a reference"
    // into "this field references THAT" — without it the entity was only known
    // at write time, from the value's own prefix, which is how
    // `contract/` survived every static check in the tree and failed against a
    // live store as a per-item `foreach` error that reported success.
    const withRef = (field: Record<string, unknown>) => {
      const composition = jobStatusBoard();
      composition.ingredients[0]!.entities!.job!.fields.push(field as never);
      return validateComposition(composition).issues
        .filter((entry) => entry.severity === 'error')
        .map((entry) => entry.code);
    };

    expect(withRef({ maps_to: 'other_ref', field_path: 'r3', type: 'string', references: 'job_event' }))
      .toEqual([]);
    expect(withRef({ maps_to: 'other_ref', field_path: 'r3', type: 'string', references: 'nope' }))
      .toContain('records_references_unknown');
    // Only a ref slot can target anything — a string field claiming one would
    // read as a relationship the store never enforces.
    expect(withRef({ maps_to: 'other_name', field_path: 's8', type: 'string', references: 'job_event' }))
      .toContain('records_references_not_ref');
    // …and it stays optional: every pack that predates the declaration is valid.
    expect(withRef({ maps_to: 'other_ref', field_path: 'r3', type: 'string' })).toEqual([]);

    // ⚠ It must reach the snapshot the store installs, not merely validate.
    // Nothing READS it there yet — the picker does not exist — so without this
    // assertion, dropping the carry is invisible and the field would be
    // declared, validated, and then quietly not there when something needs it.
    const carried = jobStatusBoard();
    carried.ingredients[0]!.entities!.job!.fields.push(
      { maps_to: 'other_ref', field_path: 'r3', type: 'string', references: 'job_event' } as never,
    );
    expect(recordsSchemaSnapshot(carried).entities.job!.fields
      .find((field) => field.key === 'other_ref')?.references).toBe('job_event');
  });

  it('makes an authored label a RE-DECLARATION, never a migration', async () => {
    // ⛔ The property the whole feature rests on. `canonicalStorageProjection`
    // picks only `{key, slot, kind, required}` per field, so a display
    // declaration must leave `storage_schema_hash` untouched — otherwise
    // labelling a field would hit the install coordinator's refusal that "a
    // populated Records schema cannot change without advancing through a
    // declared migration edge", and naming a column would mean migrating data.
    //
    // `declaration_hash` MUST move: the installed namespace has to re-activate
    // to serve the new labels, which is the pack version bump adopters pay.
    // Same trade D-226's `roots` makes.
    const plain = jobStatusBoard();
    const labelled = jobStatusBoard();
    const target = labelled.ingredients[0]!.entities!.job!.fields
      .find((field) => field.maps_to === 'parent_job_ref')!;
    target.label = 'Parent job';

    const before = await hashRecordsDeclaration(plain);
    const after = await hashRecordsDeclaration(labelled);
    expect(after.storage_schema_hash, 'a label must not force a migration')
      .toBe(before.storage_schema_hash);
    expect(after.declaration_hash, 'a label must still re-declare')
      .not.toBe(before.declaration_hash);

    // …and it reaches BOTH carriers: the Records snapshot the store installs,
    // and the `meta_fields` row the privacy/field resolver reads. A label on
    // one only would resolve on one surface and title-case on the other.
    const snapshot = recordsSchemaSnapshot(labelled);
    expect(snapshot.entities.job!.fields.find((f) => f.key === 'parent_job_ref')?.label)
      .toBe('Parent job');
    const schemas = decomposeComposition[1]!(labelled).entity_schemas ?? [];
    const metaField = schemas.flatMap((schema) => schema.meta_fields ?? [])
      .find((field) => field.key === 'parent_job_ref');
    expect((metaField as { label?: string } | undefined)?.label).toBe('Parent job');
  });

  it('derives stable hashes and stamps only verified install provenance', async () => {
    const composition = jobStatusBoard();
    const reordered = jobStatusBoard();
    reordered.operations.reverse();
    const first = await hashRecordsDeclaration(composition);
    const second = await hashRecordsDeclaration(reordered);
    expect(second.storage_schema_hash).toBe(first.storage_schema_hash);
    expect(second.declaration_hash).toBe(first.declaration_hash);

    const catalog = decomposeComposition[1]!(composition).catalog!;
    const stamped = await stampRecordsCatalog(
      catalog,
      composition,
      { publisher: 'verified.example', pack_slug: 'job-status-board' },
      7,
    );
    expect(stamped.manifest.author).toBe('verified.example');
    expect(stamped.manifest.version).toBe(7);
    expect(stamped.manifest.surfaces?.records?.executes['job.get']).toMatchObject({
      owner: { publisher: 'verified.example', pack_slug: 'job-status-board' },
      pack_version: 7,
      storage_schema_hash: first.storage_schema_hash,
      declaration_hash: first.declaration_hash,
    });
    expect(isExternallyExposableIngredient(stamped.manifest)).toBe(false);
    expect(recordsEntitySchemas(composition, 'verified.example', 'job-status-board')[0]?.scope)
      .toBe('data.entity.verified.example.job-status-board.job');
  });

  it.each([
    ['wrong risk', (value: CompositionIngredient) => { value.operations[0]!.risk = 'read'; }, 'records_risk_floor'],
    ['unknown bind key', (value: CompositionIngredient) => { (value.operations[0]!.bind as Record<string, unknown>).table = 'jobs'; }, 'records_bind_key_unknown'],
    ['wrong action envelope', (value: CompositionIngredient) => { value.operations[1]!.args = []; }, 'records_arg_missing'],
    ['unindexed text query', (value: CompositionIngredient) => { (value.operations[2]!.bind as Record<string, unknown>).sort_fields = ['title']; }, 'records_sort_unordered'],
    ['external facet', (value: CompositionIngredient) => {
      (value.ingredients[0]!.entities!.job as unknown as Record<string, unknown>).crm_alias = 'task';
    }, 'records_external_entity_facet'],
    // D-221 §6.2 — `natural_key` is admissible only on `create`, so a sibling
    // bind on the same entity that can seat a row at a CALLER-supplied id turns
    // derived-id uniqueness back into a convention. Per-bind validation cannot
    // see the pair; only the cross-operation walk can.
    ['an upsert beside a natural_key entity', (value: CompositionIngredient) => {
      keyJobCreate(value);
      value.operations.push(operation('job.upsert', 'upsert', 'write', [
        { key: 'id', type: 'string', required: true, affects_target: true },
        { key: 'expected_version', type: 'number', required: true },
        { key: 'expected_revision', type: 'number' },
        { key: 'values', type: 'object', required: true },
      ]) as unknown as CompositionIngredient['operations'][number]);
    }, 'records_natural_key_conflict'],
    ['an unkeyed sibling create on a natural_key entity', (value: CompositionIngredient) => {
      keyJobCreate(value);
      value.operations.push(operation('job.create_raw', 'create', 'write', [
        { key: 'id', type: 'string' },
        { key: 'values', type: 'object', required: true },
      ]) as unknown as CompositionIngredient['operations'][number]);
    }, 'records_natural_key_conflict'],
    ['two creates claiming different natural keys', (value: CompositionIngredient) => {
      keyJobCreate(value);
      value.operations.push(operation('job.create_alt', 'create', 'write', [
        { key: 'values', type: 'object', required: true },
      ], { natural_key: ['title'] }) as unknown as CompositionIngredient['operations'][number]);
    }, 'records_natural_key_conflict'],
  ])('rejects %s before decomposition persistence', (_label, mutate, code) => {
    const composition = jobStatusBoard();
    mutate(composition);
    const result = validateComposition(composition);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(code);
  });

  it('refuses a dotted alias in filter_fields/sort_fields, which no caller could reach', () => {
    // A dotted alias is READABLE — it projects as a nested object — but not
    // queryable: `filterList` keys the filter map on the literal friendly name,
    // and the kernel's arg guard refuses any object key carrying a `.` before
    // dispatch. Admitting one shipped an operation with a declared query field
    // that `filters: {"contact.name": …}` cannot express and
    // `filters: {contact: {name: …}}` resolves as an undeclared parent.
    for (const key of ['filter_fields', 'sort_fields'] as const) {
      const composition = jobStatusBoard();
      (composition.operations[2]!.bind as Record<string, unknown>)[key] = ['contact.name'];
      const result = validateComposition(composition);
      expect(result.valid, key).toBe(false);
      expect(result.issues.map((entry) => entry.code), key)
        .toContain('records_dotted_query_field');
    }
    // The permitting case: the same field stays declarable and readable, so this
    // refuses a QUERY on a dotted alias, not the alias itself.
    const readable = jobStatusBoard();
    expect(validateComposition(readable).valid).toBe(true);
    expect(recordsSchemaSnapshot(readable).entities.job?.fields
      .map((field) => field.key)).toContain('contact.name');
  });

  it('canonicalises natural_key ORDER when stamping, so no sibling bind is dead on arrival', async () => {
    // `canonicalBind` — and therefore the declaration hash and the
    // cross-operation authoring check — already sorts the key. Leaving the
    // STAMPED bind on its authored order made the two disagree: a reversed
    // sibling installed clean and then refused at every dispatch. It also made
    // the derived `pk` depend on which bind the store read first.
    const composition = jobStatusBoard();
    const create = composition.operations[0]!;
    create.args = [{ key: 'values', type: 'object', required: true }] as typeof create.args;
    (create.bind as Record<string, unknown>).natural_key = ['status', 'contact.name'];
    const stamped = await stampRecordsCatalog(
      decomposeComposition[1]!(composition).catalog!,
      composition,
      { publisher: 'verified.example', pack_slug: 'job-status-board' },
      1,
    );
    expect((stamped.manifest.surfaces!.records!.executes['job.create'] as
      { natural_key?: string[] }).natural_key)
      .toEqual(['contact.name', 'status']);
  });

  it('still admits a natural_key entity whose only create is the keyed one', () => {
    // The permitting case. Without it the three refusals above are
    // indistinguishable from refusing `natural_key` outright.
    const composition = jobStatusBoard();
    keyJobCreate(composition);
    const result = validateComposition(composition);
    expect(result.issues.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
    expect(decomposeComposition[1]!(composition).catalog?.surfaces?.records
      ?.executes['job.create']).toMatchObject({ natural_key: ['status'] });
  });
});
