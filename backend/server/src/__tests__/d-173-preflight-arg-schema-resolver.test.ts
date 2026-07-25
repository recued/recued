/** D-173 P1 / N.6 — `resolveArgEditSchema` (the shared seam) tests.
 *
 *  Asserts the intersection contract: the `editable_args` allowlist gates
 *  which args are editable (non-listed args omitted), the request schema +
 *  entity field fill type / privacy / validation, `affects_target` is set
 *  for destination / connection keys, privacy is carried for sealed-PII
 *  reveal, and the resolver is pure (fail-closed on an unknown op). */

import { describe, expect, it } from 'vitest';
import type { ArgEditField } from '@recued/contracts';
import {
  createOperationCatalogLookup,
  resolveArgEditSchema,
  type ArgEditSchemaResolverDeps,
  type ResolvedOperationCatalogEntry,
  type ResolvedTargetField,
} from '../preflight-arg-schema-resolver.js';

const OP = 'recued-core/reception-intake.materialize_task';

const depsFrom = (
  entry: ResolvedOperationCatalogEntry | null,
  targetFields: Record<string, ResolvedTargetField> = {},
): ArgEditSchemaResolverDeps => ({
  lookupOperation: () => entry,
  lookupTargetField: (_op, key) => targetFields[key] ?? null,
});

describe('D-173 N.6 — resolveArgEditSchema', () => {
  it('enforces the editable_args allowlist — non-listed args are omitted (immutable)', () => {
    const editable_args: ArgEditField[] = [{ key: 'title', type: 'string' }];
    const schema = resolveArgEditSchema(
      OP,
      { title: 'Prefilled', body: 'authored body', source_id: 'recued.task' },
      depsFrom({ editable_args }),
    );
    // Only `title` is editable; `body` + `source_id` are absent from the
    // allowlist → omitted (the authored value stands).
    expect(schema.fields.map((f) => f.key)).toEqual(['title']);
  });

  it('yields an empty (no-edit) schema for an op with no editable_args', () => {
    expect(resolveArgEditSchema(OP, {}, depsFrom({ editable_args: [] })).fields).toEqual([]);
    expect(resolveArgEditSchema(OP, {}, depsFrom({ request_schema: {} })).fields).toEqual([]);
  });

  it('fail-closed: an unknown op resolves to no editable fields', () => {
    const schema = resolveArgEditSchema(OP, { title: 'x' }, depsFrom(null));
    expect(schema.fields).toEqual([]);
  });

  it('lifts min/max/pattern + required from the request_schema where the field omits them', () => {
    // `type` is required on every `ArgEditField` (the pack always declares
    // it); the resolver lifts the OTHER facets (validation bounds + schema-
    // `required[]`) from the request schema when the field leaves them off.
    const editable_args: ArgEditField[] = [
      { key: 'priority', type: 'number' },
      { key: 'start_at', type: 'datetime' },
    ];
    const request_schema = {
      type: 'object',
      properties: {
        priority: { type: 'integer', minimum: 1, maximum: 5 },
        start_at: { type: 'string', format: 'date-time' },
      },
      required: ['start_at'],
    };
    const schema = resolveArgEditSchema(OP, {}, depsFrom({ editable_args, request_schema }));
    const priority = schema.fields.find((f) => f.key === 'priority')!;
    const startAt = schema.fields.find((f) => f.key === 'start_at')!;
    expect(priority.validation).toEqual({ min: 1, max: 5 });
    expect(startAt.required).toBe(true); // from schema.required[]
  });

  it('field-declared type/label/validation win over the request schema', () => {
    const editable_args: ArgEditField[] = [
      {
        key: 'priority',
        type: 'string', // author overrides the schema's integer
        label: 'Urgency',
        validation: { pattern: '^(low|high)$' },
      },
    ];
    const request_schema = {
      type: 'object',
      properties: { priority: { type: 'integer', minimum: 1, maximum: 5 } },
    };
    const field = resolveArgEditSchema(OP, {}, depsFrom({ editable_args, request_schema })).fields[0]!;
    expect(field.type).toBe('string');
    expect(field.label).toBe('Urgency');
    expect(field.validation).toEqual({ pattern: '^(low|high)$' });
  });

  it('carries privacy from the entity field (sealed-PII reveal-on-edit) when the field omits it', () => {
    const editable_args: ArgEditField[] = [{ key: 'email', type: 'string' }];
    const schema = resolveArgEditSchema(
      OP,
      {},
      depsFrom({ editable_args }, { email: { privacy: 'email' } }),
    );
    expect(schema.fields[0]!.privacy).toBe('email');
  });

  it('keeps a field-declared privacy over the entity field', () => {
    const editable_args: ArgEditField[] = [{ key: 'note', type: 'string', privacy: 'content' }];
    const field = resolveArgEditSchema(
      OP,
      {},
      depsFrom({ editable_args }, { note: { privacy: 'name' } }),
    ).fields[0]!;
    expect(field.privacy).toBe('content');
  });

  it('sets affects_target on destination / connection keys (N.5 §3)', () => {
    const editable_args: ArgEditField[] = [
      { key: 'title', type: 'string' },
      { key: 'source_id', type: 'string' },
      { key: 'calendar_id', type: 'string', options_source: 'calendar_list' },
      { key: 'sync_target.source_id', type: 'string' },
    ];
    const schema = resolveArgEditSchema(OP, {}, depsFrom({ editable_args }));
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f.affects_target]));
    expect(byKey.title).toBe(false);
    expect(byKey.source_id).toBe(true);
    expect(byKey.calendar_id).toBe(true); // leaf calendar_id
    expect(byKey['sync_target.source_id']).toBe(true); // leaf source_id
  });

  it('honors an explicit affects_target:true even on a non-destination key', () => {
    const editable_args: ArgEditField[] = [{ key: 'venue', type: 'string', affects_target: true }];
    expect(resolveArgEditSchema(OP, {}, depsFrom({ editable_args })).fields[0]!.affects_target).toBe(true);
  });

  it('walks dotted keys through nested request_schema properties', () => {
    const editable_args: ArgEditField[] = [{ key: 'request.email', type: 'string' }];
    const request_schema = {
      type: 'object',
      properties: {
        request: {
          type: 'object',
          properties: { email: { type: 'string', pattern: '@' } },
          required: ['email'],
        },
      },
    };
    const field = resolveArgEditSchema(OP, {}, depsFrom({ editable_args, request_schema })).fields[0]!;
    expect(field.type).toBe('string');
    expect(field.required).toBe(true);
    expect(field.validation).toEqual({ pattern: '@' });
  });

  it('falls back to a title-cased label when none is declared', () => {
    const editable_args: ArgEditField[] = [{ key: 'promised_for_at', type: 'datetime' }];
    expect(resolveArgEditSchema(OP, {}, depsFrom({ editable_args })).fields[0]!.label).toBe(
      'Promised For At',
    );
  });

  it('dedupes a duplicated allowlist key (first declaration wins)', () => {
    const editable_args: ArgEditField[] = [
      { key: 'title', type: 'string', label: 'First' },
      { key: 'title', type: 'string', label: 'Second' },
    ];
    const fields = resolveArgEditSchema(OP, {}, depsFrom({ editable_args })).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.label).toBe('First');
  });

  it('rejects a malformed (non-vocab) declared type, falling back to string', () => {
    const editable_args = [{ key: 'x', type: 'enum' as unknown as ArgEditField['type'] }] as ArgEditField[];
    expect(resolveArgEditSchema(OP, {}, depsFrom({ editable_args })).fields[0]!.type).toBe('string');
  });

  it('is pure — it never mutates prefilledArgs and returns fresh objects', () => {
    const editable_args: ArgEditField[] = [{ key: 'title', type: 'string' }];
    const prefilled = { title: 'x', body: 'y' };
    const frozen = Object.freeze({ ...prefilled });
    const a = resolveArgEditSchema(OP, frozen, depsFrom({ editable_args }));
    const b = resolveArgEditSchema(OP, frozen, depsFrom({ editable_args }));
    expect(a).not.toBe(b);
    expect(a.fields).not.toBe(b.fields);
    expect(prefilled).toEqual({ title: 'x', body: 'y' }); // untouched
  });
});

describe('D-173 N.6 — createOperationCatalogLookup', () => {
  it('combines an editable_args reader + a request_schema reader', () => {
    const editable_args: ArgEditField[] = [{ key: 'title', type: 'string' }];
    const lookup = createOperationCatalogLookup({
      getEditableArgs: (id) => (id === OP ? editable_args : null),
      getRequestSchema: (id) => (id === OP ? { type: 'object' } : undefined),
    });
    const entry = lookup(OP);
    expect(entry?.editable_args).toBe(editable_args);
    expect(entry?.request_schema).toEqual({ type: 'object' });
  });

  it('returns null when neither reader knows the op (fail-closed)', () => {
    const lookup = createOperationCatalogLookup({
      getEditableArgs: () => null,
      getRequestSchema: () => undefined,
    });
    expect(lookup('unknown/op.x')).toBeNull();
  });

  it('resolves end-to-end through the lookup factory + resolver', () => {
    const editable_args: ArgEditField[] = [{ key: 'title', type: 'string' }, { key: 'source_id', type: 'string' }];
    const lookup = createOperationCatalogLookup({
      getEditableArgs: () => editable_args,
      getRequestSchema: () => ({ type: 'object', properties: { title: { type: 'string' } } }),
    });
    const schema = resolveArgEditSchema(OP, { title: 'x' }, { lookupOperation: lookup });
    expect(schema.fields.map((f) => f.key)).toEqual(['title', 'source_id']);
    expect(schema.fields.find((f) => f.key === 'source_id')!.affects_target).toBe(true);
  });
});
