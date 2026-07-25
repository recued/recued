import { describe, expect, it } from 'vitest';
import type { CompositionIngredient, PackOperationRow, RestExecutionBinding } from '@recued/contracts';
import { validateComposition } from '../index.js';

const compositionWith = (bind: RestExecutionBinding): CompositionIngredient => ({
  schema_version: 1,
  slug: 'int64-api',
  catalog_kind: 'official',
  ingredients: [{
    slug: 'int64-api',
    kind: 'http',
    http: { base: 'https://api.example.com', connection: 'int64-api' },
  }],
  operations: [{
    op: 'record.create',
    ingredient: 'int64-api',
    risk: 'write',
    approval: 'always',
    idempotency: 'non_idempotent',
    args: [
      { key: 'body.person_id', type: 'string', required: true, affects_target: true },
      { key: 'body.assignee_ids', type: 'array', required: false, affects_target: true },
    ],
    request_schema: {
      type: 'object',
      properties: {
        'body.person_id': { type: 'string' },
        'body.assignee_ids': { type: 'array', items: { type: 'string' } },
      },
      required: ['body.person_id'],
      additionalProperties: true,
    },
    bind: bind as unknown as PackOperationRow['bind'],
  }],
});

const binding = (extra: Partial<RestExecutionBinding> = {}): RestExecutionBinding => ({
  kind: 'rest',
  method: 'POST',
  path_template: '/records',
  request_json: { decimal_integer_fields: ['person_id', 'assignee_ids[]'] },
  response_json: { unsafe_integers: 'string' },
  ...extra,
});

describe('REST exact JSON integer authoring gates', () => {
  it('accepts the closed request and response declarations and lowers them verbatim', () => {
    const result = validateComposition(compositionWith(binding()));

    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
    const catalog = result.decomposed && 'catalog' in result.decomposed
      ? result.decomposed.catalog
      : undefined;
    expect(catalog?.surfaces?.api?.executes['record.create']).toMatchObject({
      request_json: { decimal_integer_fields: ['person_id', 'assignee_ids[]'] },
      response_json: { unsafe_integers: 'string' },
    });
  });

  it('rejects a response mode typo instead of silently using native lossy parsing', () => {
    const result = validateComposition(compositionWith(binding({
      response_json: { unsafe_integers: 'number' } as never,
    })));

    expect(result.issues.some((issue) =>
      issue.code === 'composition_rest_response_json_unsafe_integers')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('rejects unsafe, duplicate, or empty request selectors', () => {
    const result = validateComposition(compositionWith(binding({
      request_json: { decimal_integer_fields: ['person.id', 'person.id', ''] },
    })));

    expect(result.issues.some((issue) =>
      issue.code === 'composition_rest_request_json_decimal_integer_fields')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('rejects a well-shaped selector that has no matching string input declaration', () => {
    const result = validateComposition(compositionWith(binding({
      request_json: { decimal_integer_fields: ['missing_id'] },
    })));

    expect(result.issues.some((issue) =>
      issue.code === 'composition_rest_request_json_arg_mismatch')).toBe(true);
    expect(result.issues.some((issue) =>
      issue.code === 'composition_rest_request_json_schema_mismatch')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('rejects request serialization on a bodyless method', () => {
    const result = validateComposition(compositionWith(binding({ method: 'GET' })));

    expect(result.issues.some((issue) =>
      issue.code === 'composition_rest_request_json_method')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('rejects JSON parsing combined with binary response capture', () => {
    const result = validateComposition(compositionWith(binding({
      method: 'GET',
      request_json: undefined,
      response_capture: {
        kind: 'file_ref',
        filename_source: { kind: 'header' },
      },
    })));

    expect(result.issues.some((issue) =>
      issue.code === 'composition_rest_response_json_capture_conflict')).toBe(true);
    expect(result.valid).toBe(false);
  });
});
